import Foundation

struct Message: Identifiable, Equatable {
    let id: UUID
    let role: Role
    var content: String
    let timestamp: Date
    var actions: [ActionResult]
    var isStreaming: Bool

    enum Role: String, Codable {
        case user
        case assistant
    }

    init(
        id: UUID = UUID(),
        role: Role,
        content: String,
        timestamp: Date = Date(),
        actions: [ActionResult] = [],
        isStreaming: Bool = false
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.actions = actions
        self.isStreaming = isStreaming
    }

    static func == (lhs: Message, rhs: Message) -> Bool {
        lhs.id == rhs.id
            && lhs.content == rhs.content
            && lhs.isStreaming == rhs.isStreaming
            && lhs.actions == rhs.actions
    }
}

struct ActionResult: Codable, Identifiable, Equatable {
    var id: String { action }
    let action: String
    let success: Bool
    let text: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case action
        case success
        case text
        case error
    }

    init(action: String, success: Bool, text: String? = nil, error: String? = nil) {
        self.action = action
        self.success = success
        self.text = text
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        action = try container.decodeIfPresent(String.self, forKey: .action) ?? "unknown"
        success = try container.decodeIfPresent(Bool.self, forKey: .success) ?? false
        text = try container.decodeIfPresent(String.self, forKey: .text)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

struct AuthResponse: Codable {
    let success: Bool
    let token: String?
    let userId: String?
    let error: String?
}

struct HistoryEntry: Codable, Identifiable {
    let id: String?
    let role: String
    let content: String
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case createdAt = "created_at"
    }

    var stableId: String {
        id ?? UUID().uuidString
    }
}
