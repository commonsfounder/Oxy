import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if #available(iOS 16.1, *) {
            PendantLiveActivityManager.shared.begin()
        }
        return true
    }

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
