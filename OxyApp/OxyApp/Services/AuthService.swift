import Foundation

struct AuthService {
    private let api = APIClient.shared

    func register(userId: String, password: String) async throws -> AuthResponse {
        let data = try await api.request(
            path: "/auth/register",
            method: "POST",
            body: ["userId": userId, "password": password]
        )
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    func login(userId: String, password: String) async throws -> AuthResponse {
        let data = try await api.request(
            path: "/auth/login",
            method: "POST",
            body: ["userId": userId, "password": password]
        )
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }
}
