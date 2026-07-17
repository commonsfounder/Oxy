import Foundation
import Observation

@Observable
final class AppState {
    var isAuthenticated = false
    var userId: String = ""
    var token: String = ""
    var isDemoSession = false
    var isLoading = false
    var errorMessage: String?

    private let keychain = KeychainHelper.shared
    @ObservationIgnored private var sessionExpiredObserver: NSObjectProtocol?

    init() {
        sessionExpiredObserver = NotificationCenter.default.addObserver(
            forName: .oxySessionExpired,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            #if DEBUG
            // A local debug demo session uses a fake token; its 401s must not bounce
            // us out of the UI we're trying to iterate on.
            if self.isDemoSession { return }
            #endif
            self.logout()
            self.errorMessage = "Session expired. Please sign in again."
        }
    }

    deinit {
        if let sessionExpiredObserver {
            NotificationCenter.default.removeObserver(sessionExpiredObserver)
        }
    }

    func restoreSession() {
        guard let savedToken = keychain.read(key: "session_token"),
              let savedUserId = keychain.read(key: "user_id"),
              !savedToken.isEmpty else {
            isAuthenticated = false
            return
        }
        token = savedToken
        userId = savedUserId
        isDemoSession = keychain.read(key: "demo_session") == "true"
        isAuthenticated = true
        if !isDemoSession {
            Task { @MainActor in
                NativeIntegrationManager.shared.bootstrap(userId: savedUserId)
            }
        }
    }

    func login(userId: String, token: String, isDemo: Bool = false) {
        self.userId = userId
        self.token = token
        self.isDemoSession = isDemo
        let savedToken = keychain.save(key: "session_token", value: token)
        let savedUserId = keychain.save(key: "user_id", value: userId)
        let savedDemoFlag = keychain.save(key: "demo_session", value: isDemo ? "true" : "false")
        guard savedToken, savedUserId, savedDemoFlag else {
            keychain.delete(key: "session_token")
            keychain.delete(key: "user_id")
            keychain.delete(key: "demo_session")
            self.token = ""
            self.userId = ""
            isDemoSession = false
            isAuthenticated = false
            errorMessage = "Could not save your session securely. Please unlock your device and try again."
            print("[Auth] baseURL=\(APIClient.shared.baseURL) bucket=callback_or_session_storage_failed environment=\(isDemo ? "DEMO" : "STANDARD") event=auth.login.failure provider=custom_session reason=keychain_save_failed")
            return
        }
        isAuthenticated = true
        errorMessage = nil
        if !isDemo {
            Task { @MainActor in
                NativeIntegrationManager.shared.bootstrap(userId: userId)
            }
        }
    }

    func logout() {
        keychain.delete(key: "session_token")
        keychain.delete(key: "user_id")
        keychain.delete(key: "demo_session")
        token = ""
        userId = ""
        isDemoSession = false
        isAuthenticated = false
    }
}
