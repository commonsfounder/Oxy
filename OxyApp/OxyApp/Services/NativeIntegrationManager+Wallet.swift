import Foundation
import PassKit
import UIKit

// MARK: - Apple Wallet Integration
// Called when an API action result contains pkpassBase64.
// Requires paid Apple Developer account (Pass Type ID cert) — same blocker as push.

extension NativeIntegrationManager {

    /// Present a PKAddPassViewController for a base64-encoded .pkpass archive.
    /// Call this from ChatViewModel when an action result has pkpassBase64 set.
    @MainActor
    func presentWalletPass(pkpassBase64: String, from viewController: UIViewController) {
        guard PKAddPassesViewController.canAddPasses() else {
            print("[Wallet] Device cannot add passes (simulator or Wallet not available)")
            return
        }
        guard let data = Data(base64Encoded: pkpassBase64, options: .ignoreUnknownCharacters) else {
            print("[Wallet] Invalid base64 pkpass data")
            return
        }
        do {
            let pass = try PKPass(data: data)
            guard let vc = PKAddPassesViewController(pass: pass) else {
                print("[Wallet] Could not create PKAddPassesViewController")
                return
            }
            viewController.present(vc, animated: true)
        } catch {
            print("[Wallet] Failed to create PKPass: \(error.localizedDescription)")
        }
    }
}
