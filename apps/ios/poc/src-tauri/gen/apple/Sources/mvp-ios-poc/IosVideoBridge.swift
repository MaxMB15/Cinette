import UIKit
import AVFoundation
import AVKit
import WebKit
import Foundation

final class IosVideoBridge {
    static let shared = IosVideoBridge()

    private var player: AVPlayer?
    private var viewController: AVPlayerViewController?

    func play(urlString: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            NSLog("[IosVideoBridge] play() called with %@", urlString)

            guard let url = URL(string: urlString) else {
                NSLog("[IosVideoBridge] Invalid URL")
                return
            }

            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try? AVAudioSession.sharedInstance().setActive(true)

            guard let rootVC = Self.topViewController else {
                NSLog("[IosVideoBridge] FAIL: no root view controller")
                return
            }
            NSLog("[IosVideoBridge] root VC=%@", String(describing: type(of: rootVC)))

            let player = AVPlayer(url: url)
            let vc = AVPlayerViewController()
            vc.player = player
            vc.modalPresentationStyle = .fullScreen
            vc.allowsPictureInPicturePlayback = true

            rootVC.present(vc, animated: true) {
                player.play()
                NSLog("[IosVideoBridge] presented AVPlayerViewController, calling play()")
            }

            self.player = player
            self.viewController = vc
        }
    }

    private static var topViewController: UIViewController? {
        guard
            let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
            let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
            var vc = window.rootViewController
        else { return nil }
        while let presented = vc.presentedViewController { vc = presented }
        return vc
    }
}

@_cdecl("ios_play_url")
public func ios_play_url(_ cUrl: UnsafePointer<CChar>) -> Int32 {
    let urlString = String(cString: cUrl)
    IosVideoBridge.shared.play(urlString: urlString)
    return 0
}
