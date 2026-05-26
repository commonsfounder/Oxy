import Foundation
import Observation

@Observable
final class AppState {
    var isAuthenticated = false
    var userId: String = ""
    var token: String = ""
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
            self?.logout()
            self?.errorMessage = "Session expired. Please sign in again."
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
        isAuthenticated = true
        Task { @MainActor in
            NativeIntegrationManager.shared.bootstrap(userId: savedUserId)
        }
    }

    func login(userId: String, token: String) {
        self.userId = userId
        self.token = token
        let savedToken = keychain.save(key: "session_token", value: token)
        let savedUserId = keychain.save(key: "user_id", value: userId)
        guard savedToken, savedUserId else {
            keychain.delete(key: "session_token")
            keychain.delete(key: "user_id")
            self.token = ""
            self.userId = ""
            isAuthenticated = false
            errorMessage = "Could not save your session securely. Please unlock your device and try again."
            return
        }
        isAuthenticated = true
        errorMessage = nil
        Task { @MainActor in
            NativeIntegrationManager.shared.bootstrap(userId: userId)
        }
    }

    func logout() {
        keychain.delete(key: "session_token")
        keychain.delete(key: "user_id")
        token = ""
        userId = ""
        isAuthenticated = false
    }
}
