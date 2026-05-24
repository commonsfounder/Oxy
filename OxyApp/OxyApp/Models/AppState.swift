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
        keychain.save(key: "session_token", value: token)
        keychain.save(key: "user_id", value: userId)
        isAuthenticated = true
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
