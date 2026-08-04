import Foundation

enum AgentContextService {
    static func fetch() async throws -> AgentContextSnapshot {
        let data = try await APIClient.shared.request(path: "/agent/context")
        return try JSONDecoder().decode(AgentContextEnvelope.self, from: data).context
    }
}

private struct AgentContextEnvelope: Codable {
    let context: AgentContextSnapshot
}
