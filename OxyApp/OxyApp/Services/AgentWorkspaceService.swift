import Foundation

enum AgentWorkspaceService {
    static func fetch() async throws -> AgentWorkspaceSnapshot {
        let data = try await APIClient.shared.request(path: "/agent/workspace")
        return try JSONDecoder().decode(AgentWorkspaceSnapshot.self, from: data)
    }

    static func createSession(title: String, kind: String = "project") async throws -> AgentWorkspaceSession {
        let data = try await APIClient.shared.request(
            path: "/agent/workspace/sessions",
            method: "POST",
            body: ["title": title, "kind": kind]
        )
        return try JSONDecoder().decode(AgentWorkspaceSessionEnvelope.self, from: data).session
    }
}

private struct AgentWorkspaceSessionEnvelope: Codable {
    let session: AgentWorkspaceSession
}
