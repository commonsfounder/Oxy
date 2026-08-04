import Foundation

struct AgentWorkspaceSnapshot: Codable, Equatable {
    let workspace: AgentWorkspace
    let files: [AgentWorkspaceFile]
    let sessions: [AgentWorkspaceSession]
    let capabilities: [String]
}

struct AgentWorkspace: Codable, Identifiable, Equatable {
    let id: String
    let userId: String?
    let name: String
    let metadata: [String: String]?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, metadata
        case userId = "user_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct AgentWorkspaceFile: Codable, Identifiable, Equatable {
    let id: String
    let path: String
    let kind: String
    let sizeBytes: Int?
    let version: Int?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, path, kind, version
        case sizeBytes = "size_bytes"
        case updatedAt = "updated_at"
    }
}

struct AgentWorkspaceSession: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let state: [String: String]?
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, state
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
