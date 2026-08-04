import Foundation

enum ModelRoutingService {
    static func fetch() async throws -> ModelRoutingSnapshot {
        let data = try await APIClient.shared.request(path: "/model-routing")
        return try JSONDecoder().decode(ModelRoutingSnapshot.self, from: data)
    }

    static func save(provider: String, model: String) async throws -> ModelRoutingSnapshot {
        let data = try await APIClient.shared.request(
            path: "/model-routing",
            method: "PUT",
            body: ["provider": provider, "model": model]
        )
        return try JSONDecoder().decode(ModelRoutingSnapshot.self, from: data)
    }
}
