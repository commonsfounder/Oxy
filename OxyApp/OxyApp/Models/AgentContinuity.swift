import Foundation

struct AgentContinuitySnapshot: Codable, Equatable {
    let imports: [AgentContinuityImport]
    let supportedSources: [String]
}

/// What an export would bring across, computed before anything is written.
struct AgentContinuityPreview: Codable, Equatable {
    let source: String
    let counts: AgentContinuityPreviewCounts
    let coverage: [String: AgentContinuityCoverage]
    let workflows: [AgentContinuityWorkflow]
}

struct AgentContinuityPreviewCounts: Codable, Equatable {
    let conversations: Int
    let messages: Int
    let projects: Int
    let documents: Int
    let instructions: Int
    let memories: Int
    let workflows: Int
    let scheduledWorkflows: Int
    let eventWorkflows: Int
}

struct AgentContinuityCoverage: Codable, Equatable {
    let found: Bool
    let count: Int
}

struct AgentContinuityWorkflow: Codable, Equatable, Identifiable {
    let name: String
    let triggerKind: String
    let intervalMinutes: Int?
    let activeAtSource: Bool
    let prompt: String

    var id: String { name }
    var isScheduled: Bool { triggerKind == "schedule" }
}

struct AgentContinuityImport: Codable, Identifiable, Equatable {
    let id: String
    let source: String
    let status: String
    let conversationCount: Int
    let messageCount: Int
    let projectCount: Int
    let documentCount: Int
    let memoryCount: Int
    let metadata: [String: String]?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, source, status, metadata
        case conversationCount = "conversation_count"
        case messageCount = "message_count"
        case projectCount = "project_count"
        case documentCount = "document_count"
        case memoryCount = "memory_count"
        case createdAt = "created_at"
    }
}
