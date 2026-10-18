// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// AirPlay video. mpv can't send video over AirPlay, so while AirPlay plays,
// AVPlayer plays instead and mpv is stopped. Apps can't list AirPlay
// receivers: the user picks one in the system route picker, and the audio
// route says which. Rust drives this through the `mvp_ios_airplay_*`
// functions below and gets AVPlayer's state back as JSON.
//
// The stream URL carries the provider's login, so it's never logged, and an
// error goes to Rust only as its domain and code.

import AVFoundation
import AVKit
import UIKit

typealias MvpAirPlayAvailableCallback = @convention(c) (Bool) -> Void
typealias MvpAirPlayRouteCallback = @convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?) ->
  Void
typealias MvpAirPlayClosedCallback = @convention(c) () -> Void
typealias MvpAirPlayReportCallback = @convention(c) (UnsafePointer<CChar>?) -> Void

/// Owns AVPlayer, the route picker and the route detector. Only used on the
/// main thread.
final class AirPlayHost: NSObject, AVRoutePickerViewDelegate {
  static let shared = AirPlayHost()

  /// Whether AVPlayer has an item. While it does, the audio session stays
  /// on and the lock screen's controls drive AVPlayer, not mpv.
  private(set) var isActive = false

  private var availableCallback: MvpAirPlayAvailableCallback?
  private var routeCallback: MvpAirPlayRouteCallback?
  private var closedCallback: MvpAirPlayClosedCallback?
  private var reportCallback: MvpAirPlayReportCallback?

  private let detector = AVRouteDetector()
  private var detectorObservation: NSKeyValueObservation?
  private var picker: AVRoutePickerView?
  /// The AirPlay receiver the audio route went to last, as name and uid.
  private var route: (name: String, uid: String)?

  private var player: AVPlayer?
  /// Holds an AVPlayerLayer for the player, too small to see. Some reports
  /// say AVPlayer only sends audio over AirPlay without a layer.
  private var layerView: UIView?
  private var observations: [NSKeyValueObservation] = []
  private var itemObservers: [NSObjectProtocol] = []
  private var timer: Timer?

  private var title: String?
  private var live = false
  private var startAt = 0.0
  private var started = false
  private var ended = false
  private var failed = false
  private var legible: AVMediaSelectionGroup?
  private var audible: AVMediaSelectionGroup?
  private var lastReport: String?

  func register(
    available: MvpAirPlayAvailableCallback?, route: MvpAirPlayRouteCallback?,
    closed: MvpAirPlayClosedCallback?, report: MvpAirPlayReportCallback?
  ) {
    availableCallback = available
    routeCallback = route
    closedCallback = closed
    reportCallback = report
    detectorObservation = detector.observe(\.multipleRoutesDetected, options: [.new]) {
      [weak self] detector, _ in
      let detected = detector.multipleRoutesDetected
      DispatchQueue.main.async { self?.availableCallback?(detected) }
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(audioRouteChanged),
      name: AVAudioSession.routeChangeNotification, object: nil)
    updateRoute()
  }

  // MARK: Receivers

  func setDetection(_ enabled: Bool) {
    detector.isRouteDetectionEnabled = enabled
    if enabled {
      availableCallback?(detector.multipleRoutesDetected)
    }
  }

  /// Opens the system route picker over `rect`, in the page's CSS pixels.
  /// AVRoutePickerView has no method that opens it, so this taps its
  /// button, as other apps do. It's all public API.
  func choose(_ rect: CGRect) {
    guard let webview = MpvHost.shared.webview, let container = webview.superview else {
      closedCallback?()
      return
    }
    let view = picker ?? makePicker()
    if view.superview !== container {
      view.removeFromSuperview()
      container.addSubview(view)
    }
    view.frame = webview.convert(rect, to: container)
    guard let button = view.subviews.compactMap({ $0 as? UIButton }).first else {
      NSLog("[AirPlay] the route picker has no button")
      closedCallback?()
      return
    }
    button.sendActions(for: .touchUpInside)
  }

  private func makePicker() -> AVRoutePickerView {
    let view = AVRoutePickerView(frame: .zero)
    view.prioritizesVideoDevices = true
    view.delegate = self
    // Invisible but on screen, so the iPad's popover has an anchor. A
    // hidden view doesn't present.
    view.alpha = 0.02
    view.isUserInteractionEnabled = false
    picker = view
    return view
  }

  func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
    closedCallback?()
  }

  @objc private func audioRouteChanged(_ note: Notification) {
    DispatchQueue.main.async { self.updateRoute() }
  }

  private func updateRoute() {
    let output = AVAudioSession.sharedInstance().currentRoute.outputs
      .first { $0.portType == .airPlay }
    let next = output.map { (name: $0.portName, uid: $0.uid) }
    if next?.uid == route?.uid && next?.name == route?.name { return }
    route = next
    if let next {
      next.name.withCString { name in
        next.uid.withCString { uid in routeCallback?(name, uid) }
      }
    } else {
      routeCallback?(nil, nil)
    }
  }

  // MARK: Playback

  func load(url: URL, title: String?, startAt: Double, live: Bool) {
    stopPlayer()
    self.title = title
    self.live = live
    self.startAt = startAt
    started = false
    ended = false
    failed = false
    legible = nil
    audible = nil
    lastReport = nil

    let player = self.player ?? makePlayer()
    let item = AVPlayerItem(url: url)
    observe(item: item, player: player)
    isActive = true
    MpvHost.shared.setAudioActive(true)
    player.replaceCurrentItem(with: item)
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      self?.sendReport()
    }
    sendReport()
  }

  private func makePlayer() -> AVPlayer {
    let player = AVPlayer()
    player.allowsExternalPlayback = true
    // With screen mirroring on, the video still goes to the TV full screen
    // as AirPlay video, rather than as part of the phone's mirrored screen.
    player.usesExternalPlaybackWhileExternalScreenIsActive = true
    player.automaticallyWaitsToMinimizeStalling = true
    self.player = player
    if let webview = MpvHost.shared.webview, let container = webview.superview {
      let view = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
      view.isUserInteractionEnabled = false
      view.alpha = 0.01
      let layer = AVPlayerLayer(player: player)
      layer.frame = view.bounds
      view.layer.addSublayer(layer)
      container.insertSubview(view, belowSubview: webview)
      layerView = view
    }
    return player
  }

  private func observe(item: AVPlayerItem, player: AVPlayer) {
    observations = [
      item.observe(\.status, options: [.new]) { [weak self] item, _ in
        DispatchQueue.main.async { self?.itemStatusChanged(item) }
      },
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.sendReport() }
      },
      player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] player, _ in
        DispatchQueue.main.async { self?.externalChanged(player) }
      },
    ]
    let center = NotificationCenter.default
    itemObservers = [
      center.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        self?.ended = true
        self?.sendReport()
      },
      center.addObserver(
        forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
      ) { [weak self] _ in
        self?.failed = true
        self?.sendReport()
      },
    ]
  }

  private func itemStatusChanged(_ item: AVPlayerItem) {
    guard item === player?.currentItem else { return }
    if item.status == .readyToPlay && !started {
      started = true
      loadSelectionGroups(item)
      // AVPlayerItem can't take a start time before it's ready.
      if startAt > 0 {
        item.seek(
          to: CMTime(seconds: startAt, preferredTimescale: 600), toleranceBefore: .zero,
          toleranceAfter: .zero
        ) { [weak self] _ in
          DispatchQueue.main.async { self?.player?.play() }
        }
      } else {
        player?.play()
      }
    }
    sendReport()
  }

  /// When the video leaves the receiver, AVPlayer would carry on here.
  /// Rust reports the receiver as lost, and the app plays nothing until the
  /// user says where.
  private func externalChanged(_ player: AVPlayer) {
    if !player.isExternalPlaybackActive && started {
      player.pause()
    }
    sendReport()
  }

  private func loadSelectionGroups(_ item: AVPlayerItem) {
    let asset = item.asset
    if #available(iOS 16.0, *) {
      Task { @MainActor [weak self] in
        let legible = try? await asset.loadMediaSelectionGroup(for: .legible)
        let audible = try? await asset.loadMediaSelectionGroup(for: .audible)
        guard let self, item === self.player?.currentItem else { return }
        self.legible = legible
        self.audible = audible
        self.sendReport()
      }
    }
  }

  func play() {
    player?.play()
  }

  func pause() {
    player?.pause()
  }

  func seek(_ position: Double) {
    player?.seek(
      to: CMTime(seconds: max(0, position), preferredTimescale: 600),
      toleranceBefore: .zero, toleranceAfter: .zero)
  }

  func selectLegible(_ index: Int) {
    guard let item = player?.currentItem, let group = legible else { return }
    let option = group.options.indices.contains(index) ? group.options[index] : nil
    item.select(option, in: group)
    sendReport()
  }

  func selectAudible(_ index: Int) {
    guard let item = player?.currentItem, let group = audible,
      group.options.indices.contains(index)
    else { return }
    item.select(group.options[index], in: group)
    sendReport()
  }

  func stop() {
    stopPlayer()
    // Nothing plays now, so other apps' audio may come back. If mpv starts
    // next, it turns the session on again.
    MpvHost.shared.setAudioActive(false)
    MpvHost.shared.clearNowPlaying()
  }

  private func stopPlayer() {
    timer?.invalidate()
    timer = nil
    observations = []
    for observer in itemObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    itemObservers = []
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    isActive = false
  }

  /// The lock screen's controls while AirPlay plays. Returns false when
  /// AirPlay isn't active, so mpv gets the command.
  func handleRemote(_ command: MvpRemoteCommand, _ value: Double) -> Bool {
    guard isActive, let player else { return false }
    switch command {
    case .play: player.play()
    case .pause: player.pause()
    case .togglePlayPause:
      if player.timeControlStatus == .paused { player.play() } else { player.pause() }
    case .skip: seek(player.currentTime().seconds + value)
    case .seekTo: seek(value)
    }
    return true
  }

  // MARK: Reports

  private func sendReport() {
    guard isActive, let player, let item = player.currentItem else { return }
    let status: String
    if failed || item.status == .failed {
      status = "failed"
    } else if ended {
      status = "ended"
    } else if item.status != .readyToPlay || !started {
      status = "opening"
    } else {
      switch player.timeControlStatus {
      case .playing: status = "playing"
      case .paused: status = "paused"
      case .waitingToPlayAtSpecifiedRate: status = "waiting"
      @unknown default: status = "waiting"
      }
    }
    let position = player.currentTime().seconds
    let duration = item.duration.isNumeric ? item.duration.seconds : nil
    var report: [String: Any] = [
      "status": status,
      "position": position.isFinite ? position : 0,
      "duration": duration.map { $0 as Any } ?? NSNull(),
      "external": player.isExternalPlaybackActive,
    ]
    if let error = item.error as NSError? {
      var detail: [String: Any] = ["domain": error.domain, "code": error.code]
      if let status = httpStatus(item) { detail["httpStatus"] = status }
      report["error"] = detail
    }
    if let group = legible {
      report["subtitles"] = group.options.map(track)
      if let selected = item.currentMediaSelection.selectedMediaOption(in: group),
        let index = group.options.firstIndex(of: selected)
      {
        report["subtitle"] = index
      }
    }
    if let group = audible {
      report["audio"] = group.options.map(track)
      if let selected = item.currentMediaSelection.selectedMediaOption(in: group),
        let index = group.options.firstIndex(of: selected)
      {
        report["audioTrack"] = index
      }
    }
    MpvHost.shared.updateNowPlaying(
      title: title, duration: live ? 0 : (duration ?? 0), position: position,
      playing: status == "playing")
    guard let data = try? JSONSerialization.data(withJSONObject: report),
      let json = String(data: data, encoding: .utf8), json != lastReport
    else { return }
    lastReport = json
    json.withCString { reportCallback?($0) }
  }

  private func track(_ option: AVMediaSelectionOption) -> [String: Any] {
    var track: [String: Any] = ["label": option.displayName]
    if let language = option.extendedLanguageTag ?? option.locale?.identifier {
      track["language"] = language
    }
    return track
  }

  /// The HTTP status of the last failed request, from the error log. Only
  /// the number is read: the log's comment can hold the URL.
  private func httpStatus(_ item: AVPlayerItem) -> Int? {
    guard let event = item.errorLog()?.events.last else { return nil }
    if (400...599).contains(event.errorStatusCode) {
      return event.errorStatusCode
    }
    guard let comment = event.errorComment,
      let range = comment.range(of: #"HTTP (\d{3})"#, options: .regularExpression)
    else { return nil }
    return Int(comment[range].dropFirst(5))
  }
}

// MARK: C entry points called from airplay/ios.rs

@_cdecl("mvp_ios_airplay_register")
func mvpIosAirPlayRegister(
  _ available: MvpAirPlayAvailableCallback?, _ route: MvpAirPlayRouteCallback?,
  _ closed: MvpAirPlayClosedCallback?, _ report: MvpAirPlayReportCallback?
) {
  DispatchQueue.main.async {
    AirPlayHost.shared.register(
      available: available, route: route, closed: closed, report: report)
  }
}

@_cdecl("mvp_ios_airplay_set_detection")
func mvpIosAirPlaySetDetection(_ enabled: Bool) {
  DispatchQueue.main.async { AirPlayHost.shared.setDetection(enabled) }
}

@_cdecl("mvp_ios_airplay_choose")
func mvpIosAirPlayChoose(_ x: Double, _ y: Double, _ width: Double, _ height: Double) {
  DispatchQueue.main.async {
    AirPlayHost.shared.choose(CGRect(x: x, y: y, width: width, height: height))
  }
}

@_cdecl("mvp_ios_airplay_load")
func mvpIosAirPlayLoad(
  _ url: UnsafePointer<CChar>?, _ title: UnsafePointer<CChar>?, _ startAt: Double, _ live: Bool
) {
  // Copy the strings now. Rust frees them when this function returns.
  guard let url = url.flatMap({ URL(string: String(cString: $0)) }) else {
    NSLog("[AirPlay] load without a valid stream address")
    return
  }
  let name = title.map { String(cString: $0) }
  DispatchQueue.main.async {
    AirPlayHost.shared.load(url: url, title: name, startAt: startAt, live: live)
  }
}

@_cdecl("mvp_ios_airplay_play")
func mvpIosAirPlayPlay() {
  DispatchQueue.main.async { AirPlayHost.shared.play() }
}

@_cdecl("mvp_ios_airplay_pause")
func mvpIosAirPlayPause() {
  DispatchQueue.main.async { AirPlayHost.shared.pause() }
}

@_cdecl("mvp_ios_airplay_seek")
func mvpIosAirPlaySeek(_ position: Double) {
  DispatchQueue.main.async { AirPlayHost.shared.seek(position) }
}

@_cdecl("mvp_ios_airplay_select_legible")
func mvpIosAirPlaySelectLegible(_ index: Int32) {
  DispatchQueue.main.async { AirPlayHost.shared.selectLegible(Int(index)) }
}

@_cdecl("mvp_ios_airplay_select_audible")
func mvpIosAirPlaySelectAudible(_ index: Int32) {
  DispatchQueue.main.async { AirPlayHost.shared.selectAudible(Int(index)) }
}

@_cdecl("mvp_ios_airplay_stop")
func mvpIosAirPlayStop() {
  DispatchQueue.main.async { AirPlayHost.shared.stop() }
}
