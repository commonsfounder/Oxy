import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        guard let userId = KeychainHelper.shared.read(key: "user_id"), !userId.isEmpty else { return }
        Task { @MainActor in
            await NativeIntegrationManager.shared.registerPushToken(deviceToken, userId: userId)
        }
    }
}
