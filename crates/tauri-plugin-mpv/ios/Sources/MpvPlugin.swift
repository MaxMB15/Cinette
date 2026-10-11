// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// The UIKit half of the mpv plugin on iOS. Rust drives mpv through libmpv and
// calls the `mvp_ios_*` functions below for everything that has to happen in
// UIKit: the video view, the audio session, Now Playing and the lock screen
// controls. Rust gets lifecycle, remote control and resize events back through
// the C callbacks it registers with `mvp_ios_register_callbacks`.

import AVFoundation
import MediaPlayer
import Tauri
import UIKit
import WebKit

typealias MvpLifecycleCallback = @convention(c) (Bool) -> Void
typealias MvpRemoteCallback = @convention(c) (Int32, Double) -> Void
typealias MvpResizeCallback = @convention(c) () -> Void

/// Remote commands sent to Rust. The raw values are shared with `ios.rs`.
enum MvpRemoteCommand: Int32 {
  case play = 0
  case pause = 1
  case togglePlayPause = 2
  case skip = 3
  case seekTo = 4
}

/// The layer mpv draws into through MoltenVK. MoltenVK sets `drawableSize`
/// to 1x1 when it tears a swapchain down, and mpv sizes its next swapchain
/// from `drawableSize`, so those sizes are ignored.
final class MpvMetalLayer: CAMetalLayer {
  override var drawableSize: CGSize {
    get { super.drawableSize }
    set {
      if newValue.width > 1, newValue.height > 1 {
        super.drawableSize = newValue
      }
    }
  }
}

/// Sits right under the web view and shows mpv's output. It never takes
/// touches, so the React controls drawn over it keep working.
final class MpvVideoView: UIView {
  /// mpv draws into this sublayer, not the view's own layer. MoltenVK changes
  /// the layer from mpv's thread, and UIKit warns when that happens to a
  /// layer that belongs to a view.
  let metalLayer = MpvMetalLayer()

  /// Called after the drawable changes size.
  var onDrawableResize: (() -> Void)?

  /// The drawable size mpv was last told about. MoltenVK also sets
  /// `drawableSize`, from mpv's thread, when it rebuilds its swapchain after
  /// the layer's bounds change. That can happen before `layoutSubviews`
  /// runs, so the layer's own value doesn't show whether mpv knows.
  private var reportedSize = CGSize.zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .black
    metalLayer.framebufferOnly = true
    metalLayer.backgroundColor = UIColor.black.cgColor
    layer.addSublayer(metalLayer)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let screen = window?.windowScene?.screen {
      contentScaleFactor = screen.nativeScale
    }
    updateDrawableSize()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateDrawableSize()
  }

  /// mpv reads the drawable size when it sets up video output, so it has to
  /// match the view before a stream starts. After that mpv only reads it
  /// again when told to, through `onDrawableResize`.
  private func updateDrawableSize() {
    let scale = contentScaleFactor
    // Without this the layer would animate to its new frame.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = bounds
    metalLayer.contentsScale = scale
    CATransaction.commit()
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    metalLayer.drawableSize = size
    guard size.width > 1, size.height > 1, size != reportedSize else { return }
    reportedSize = size
    onDrawableResize?()
  }
}

/// Owns the video view and the playback services. Only used on the main
/// thread.
final class MpvHost: NSObject {
  static let shared = MpvHost()

  private weak var webview: WKWebView?
  private var videoView: MpvVideoView?
  private var lifecycleCallback: MvpLifecycleCallback?
  private var remoteCallback: MvpRemoteCallback?
  private var resizeCallback: MvpResizeCallback?
  private var remoteCommandsReady = false

  func attach(webview: WKWebView) {
    self.webview = webview
    // The page decides where it's transparent. The web view itself never
    // paints a background, so the video view shows through.
    webview.isOpaque = false
    webview.backgroundColor = .clear
    webview.scrollView.backgroundColor = .clear
    // CSS pixels then map straight onto the web view's bounds, which keeps
    // `set_frame` simple. The page pads itself with env(safe-area-inset-*).
    webview.scrollView.contentInsetAdjustmentBehavior = .never

    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    } catch {
      NSLog("[mpv] audio session category: \(error)")
    }

    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(didEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(
      self, selector: #selector(willEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil)
    center.addObserver(
      self, selector: #selector(audioInterrupted(_:)),
      name: AVAudioSession.interruptionNotification, object: nil)
    center.addObserver(
      self, selector: #selector(audioRouteChanged(_:)),
      name: AVAudioSession.routeChangeNotification, object: nil)

    // The app needs iOS 17.5, so this always runs. The check is for the
    // package, which still declares iOS 13. Tauri loads plugins on the main
    // thread.
    if #available(iOS 17.0, *) {
      MainActor.assumeIsolated {
        _ = webview.registerForTraitChanges([UITraitVerticalSizeClass.self]) {
          [weak self] (_: WKWebView, _: UITraitCollection) in
          self?.updateSystemBars()
        }
      }
    }
  }

  func registerCallbacks(
    lifecycle: MvpLifecycleCallback?, remote: MvpRemoteCallback?, resize: MvpResizeCallback?
  ) {
    lifecycleCallback = lifecycle
    remoteCallback = remote
    resizeCallback = resize
    setUpRemoteCommands()
  }

  // MARK: Video view

  /// Shows the video view and returns its layer for mpv's `wid`, or 0 if the
  /// web view isn't there yet. The same view is reused for every stream, so
  /// the layer outlives each mpv instance that draws into it.
  func createSurface() -> UInt {
    guard let webview, let container = webview.superview else { return 0 }
    let view: MpvVideoView
    if let existing = videoView {
      view = existing
    } else {
      view = MpvVideoView(frame: webview.frame)
      view.onDrawableResize = { [weak self] in self?.resizeCallback?() }
      videoView = view
    }
    if view.superview !== container {
      view.removeFromSuperview()
      container.insertSubview(view, belowSubview: webview)
    }
    view.isHidden = false
    updateSystemBars()
    return UInt(bitPattern: Unmanaged.passUnretained(view.metalLayer).toOpaque())
  }

  /// Moves the video view to a rect in the page's CSS pixels.
  func setFrame(_ rect: CGRect) {
    guard let webview, let view = videoView, let container = view.superview else { return }
    let target = webview.convert(rect, to: container)
    guard view.frame != target else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    view.frame = target
    CATransaction.commit()
  }

  func setVisible(_ visible: Bool) {
    videoView?.isHidden = !visible
    updateSystemBars()
  }

  /// iOS hides the status bar in every app on an iPhone in landscape, but
  /// tao's view controller always asks for it, so it would sit on top of
  /// the video. Hiding it whenever the height is compact matches other
  /// apps, on every screen and not only the player. The home indicator
  /// fades out only while video is on screen.
  private func updateSystemBars() {
    guard let webview, let controller = webview.window?.rootViewController else { return }
    let compactHeight = webview.traitCollection.verticalSizeClass == .compact
    let showingVideo = videoView.map { !$0.isHidden && $0.window != nil } ?? false
    setFlag(controller, "setPrefersStatusBarHidden:", compactHeight)
    setFlag(controller, "setPrefersHomeIndicatorAutoHidden:", showingVideo)
  }

  /// Calls one of tao's BOOL setters, which UIKit doesn't declare.
  private func setFlag(_ target: NSObject, _ setter: String, _ value: Bool) {
    let selector = NSSelectorFromString(setter)
    guard target.responds(to: selector) else { return }
    typealias Setter = @convention(c) (NSObject, Selector, Bool) -> Void
    unsafeBitCast(target.method(for: selector), to: Setter.self)(target, selector, value)
  }

  // MARK: Audio session and Now Playing

  func setAudioActive(_ active: Bool) {
    let session = AVAudioSession.sharedInstance()
    do {
      if active {
        try session.setActive(true)
      } else {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
      }
    } catch {
      NSLog("[mpv] audio session active=\(active): \(error)")
    }
  }

  func updateNowPlaying(title: String?, duration: Double, position: Double, playing: Bool) {
    var info: [String: Any] = [
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
    ]
    if let title, !title.isEmpty {
      info[MPMediaItemPropertyTitle] = title
    }
    if duration > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = duration
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position)
      info[MPNowPlayingInfoPropertyIsLiveStream] = false
    } else {
      info[MPNowPlayingInfoPropertyIsLiveStream] = true
    }
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = info
    center.playbackState = playing ? .playing : .paused
  }

  func clearNowPlaying() {
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = nil
    center.playbackState = .stopped
  }

  private func setUpRemoteCommands() {
    guard !remoteCommandsReady else { return }
    remoteCommandsReady = true
    let commands = MPRemoteCommandCenter.shared()
    commands.playCommand.addTarget { [weak self] _ in
      self?.sendRemote(.play) ?? .commandFailed
    }
    commands.pauseCommand.addTarget { [weak self] _ in
      self?.sendRemote(.pause) ?? .commandFailed
    }
    commands.togglePlayPauseCommand.addTarget { [weak self] _ in
      self?.sendRemote(.togglePlayPause) ?? .commandFailed
    }
    commands.skipForwardCommand.preferredIntervals = [10]
    commands.skipForwardCommand.addTarget { [weak self] _ in
      self?.sendRemote(.skip, 10) ?? .commandFailed
    }
    commands.skipBackwardCommand.preferredIntervals = [10]
    commands.skipBackwardCommand.addTarget { [weak self] _ in
      self?.sendRemote(.skip, -10) ?? .commandFailed
    }
    commands.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      return self?.sendRemote(.seekTo, event.positionTime) ?? .commandFailed
    }
  }

  private func sendRemote(_ command: MvpRemoteCommand, _ value: Double = 0)
    -> MPRemoteCommandHandlerStatus
  {
    guard let remoteCallback else { return .commandFailed }
    remoteCallback(command.rawValue, value)
    return .success
  }

  // MARK: Notifications

  @objc private func didEnterBackground() {
    lifecycleCallback?(true)
  }

  @objc private func willEnterForeground() {
    lifecycleCallback?(false)
  }

  /// Pauses for a phone call or an alarm, and resumes after it if iOS says so.
  @objc private func audioInterrupted(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    switch type {
    case .began:
      _ = sendRemote(.pause)
    case .ended:
      let rawOptions = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      if AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) {
        _ = sendRemote(.play)
      }
    @unknown default:
      break
    }
  }

  /// Pauses when headphones are unplugged, like every other player on iOS.
  @objc private func audioRouteChanged(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
    else { return }
    DispatchQueue.main.async { _ = self.sendRemote(.pause) }
  }
}

/// Runs `work` on the main thread and waits for its result.
private func onMain<T>(_ work: () -> T) -> T {
  if Thread.isMainThread {
    return work()
  }
  return DispatchQueue.main.sync(execute: work)
}

// MARK: C entry points called from ios.rs

@_cdecl("mvp_ios_register_callbacks")
func mvpIosRegisterCallbacks(
  _ lifecycle: MvpLifecycleCallback?, _ remote: MvpRemoteCallback?, _ resize: MvpResizeCallback?
) {
  DispatchQueue.main.async {
    MpvHost.shared.registerCallbacks(lifecycle: lifecycle, remote: remote, resize: resize)
  }
}

@_cdecl("mvp_ios_surface_create")
func mvpIosSurfaceCreate() -> UInt {
  onMain { MpvHost.shared.createSurface() }
}

@_cdecl("mvp_ios_surface_set_frame")
func mvpIosSurfaceSetFrame(_ x: Double, _ y: Double, _ width: Double, _ height: Double) {
  DispatchQueue.main.async {
    MpvHost.shared.setFrame(CGRect(x: x, y: y, width: width, height: height))
  }
}

@_cdecl("mvp_ios_surface_set_visible")
func mvpIosSurfaceSetVisible(_ visible: Bool) {
  DispatchQueue.main.async { MpvHost.shared.setVisible(visible) }
}

@_cdecl("mvp_ios_surface_detach")
func mvpIosSurfaceDetach() {
  DispatchQueue.main.async { MpvHost.shared.setVisible(false) }
}

@_cdecl("mvp_ios_set_idle_timer_disabled")
func mvpIosSetIdleTimerDisabled(_ disabled: Bool) {
  DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = disabled }
}

@_cdecl("mvp_ios_set_audio_active")
func mvpIosSetAudioActive(_ active: Bool) {
  DispatchQueue.main.async { MpvHost.shared.setAudioActive(active) }
}

@_cdecl("mvp_ios_now_playing")
func mvpIosNowPlaying(
  _ title: UnsafePointer<CChar>?, _ duration: Double, _ position: Double, _ playing: Bool
) {
  // Copy the string now. Rust frees it when this function returns.
  let name = title.map { String(cString: $0) }
  DispatchQueue.main.async {
    MpvHost.shared.updateNowPlaying(
      title: name, duration: duration, position: position, playing: playing)
  }
}

@_cdecl("mvp_ios_now_playing_clear")
func mvpIosNowPlayingClear() {
  DispatchQueue.main.async { MpvHost.shared.clearNowPlaying() }
}

// MARK: Tauri plugin

class MpvPlugin: Plugin {
  override func load(webview: WKWebView) {
    MpvHost.shared.attach(webview: webview)
  }
}

@_cdecl("init_plugin_mpv")
func initPlugin() -> Plugin {
  return MpvPlugin()
}
