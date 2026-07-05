import Foundation

struct AuthService {
    private let api = APIClient.shared
    private let provider = "custom_session"

    func register(userId: String, password: String) async throws -> AuthResponse {
        do {
            let data = try await api.request(
                path: "/auth/register",
                method: "POST",
                body: ["userId": userId, "password": password]
            )
            return try JSONDecoder().decode(AuthResponse.self, from: data)
        } catch {
            logAuthFailure(error, provider: provider, endpoint: "/auth/register")
            throw error
        }
    }

    func login(userId: String, password: String) async throws -> AuthResponse {
        do {
            let data = try await api.request(
                path: "/auth/login",
                method: "POST",
                body: ["userId": userId, "password": password]
            )
            return try JSONDecoder().decode(AuthResponse.self, from: data)
        } catch {
            logAuthFailure(error, provider: provider, endpoint: "/auth/login")
            throw error
        }
    }

    func demoLogin() async throws -> AuthResponse {
        do {
            let data = try await api.request(
                path: "/auth/dev/demo-login",
                method: "POST"
            )
            return try JSONDecoder().decode(AuthResponse.self, from: data)
        } catch {
            logAuthFailure(error, provider: "custom_session_dev", endpoint: "/auth/dev/demo-login")
            throw error
        }
    }

    private func logAuthFailure(_ error: Error, provider: String, endpoint: String) {
        let classified = classify(error)
        let fields: [String: String] = [
            "event": "auth.login.failure",
            "environment": appEnvironment,
            "baseURL": api.baseURL,
            "provider": provider,
            "endpoint": endpoint,
            "reason": classified.reason,
            "bucket": classified.bucket
        ]
        let details = fields
            .map { "\($0.key)=\($0.value)" }
            .sorted()
            .joined(separator: " ")
        print("[Auth] \(details)")
    }

    private func classify(_ error: Error) -> (reason: String, bucket: String) {
        if let apiError = error as? APIError {
            switch apiError {
            case .invalidURL:
                return ("invalid_url", "network_request_failed")
            case .server(let status, _):
                if status == 401 || status == 403 {
                    return ("credentials_rejected", "credentials_rejected")
                }
                if status == 404 {
                    return ("endpoint_unavailable", "network_request_failed")
                }
                return ("server_status_\(status)", "network_request_failed")
            case .unknown:
                return ("unknown_response", "network_request_failed")
            }
        }
        if error is URLError {
            return ("url_session_error", "network_request_failed")
        }
        if error is DecodingError {
            return ("response_decode_failed", "callback_or_session_storage_failed")
        }
        return ("unexpected_error", "network_request_failed")
    }

    private var appEnvironment: String {
        #if DEBUG
        return "DEBUG"
        #else
        return UserDefaults.standard.bool(forKey: "oxy_enable_local_dev_auth") ? "LOCAL_DEV_FLAG" : "RELEASE"
        #endif
    }
}
