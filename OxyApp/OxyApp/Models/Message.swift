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
    var id: String { action + (text ?? "") }
    let action: String
    let success: Bool
    let text: String?
    let error: String?
    let deepLink: String?
    let webLink: String?
    let cardText: String?
    let actionSummary: String?
    let risk: String?
    let confirmation: String?
    let pending: Bool

    enum CodingKeys: String, CodingKey {
        case action, result, success, text, error, deepLink, webLink, cardText, actionSummary, risk, confirmation, pending
    }

    init(
        action: String,
        success: Bool,
        text: String? = nil,
        error: String? = nil,
        deepLink: String? = nil,
        webLink: String? = nil,
        cardText: String? = nil,
        actionSummary: String? = nil,
        risk: String? = nil,
        confirmation: String? = nil,
        pending: Bool = false
    ) {
        self.action = action
        self.success = success
        self.text = text
        self.error = error
        self.deepLink = deepLink
        self.webLink = webLink
        self.cardText = cardText
        self.actionSummary = actionSummary
        self.risk = risk
        self.confirmation = confirmation
        self.pending = pending
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        action = try container.decodeIfPresent(String.self, forKey: .action) ?? "unknown"

        if let result = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .result) {
            success = try result.decodeIfPresent(Bool.self, forKey: .success) ?? false
            text = try result.decodeIfPresent(String.self, forKey: .text)
            error = try result.decodeIfPresent(String.self, forKey: .error)
            deepLink = try result.decodeIfPresent(String.self, forKey: .deepLink)
            webLink = try result.decodeIfPresent(String.self, forKey: .webLink)
            cardText = try result.decodeIfPresent(String.self, forKey: .cardText)
            actionSummary = try result.decodeIfPresent(String.self, forKey: .actionSummary)
            risk = try result.decodeIfPresent(String.self, forKey: .risk)
            confirmation = try result.decodeIfPresent(String.self, forKey: .confirmation)
            pending = try result.decodeIfPresent(Bool.self, forKey: .pending) ?? false
        } else {
            success = try container.decodeIfPresent(Bool.self, forKey: .success) ?? false
            text = try container.decodeIfPresent(String.self, forKey: .text)
            error = try container.decodeIfPresent(String.self, forKey: .error)
            deepLink = try container.decodeIfPresent(String.self, forKey: .deepLink)
            webLink = try container.decodeIfPresent(String.self, forKey: .webLink)
            cardText = try container.decodeIfPresent(String.self, forKey: .cardText)
            actionSummary = try container.decodeIfPresent(String.self, forKey: .actionSummary)
            risk = try container.decodeIfPresent(String.self, forKey: .risk)
            confirmation = try container.decodeIfPresent(String.self, forKey: .confirmation)
            pending = try container.decodeIfPresent(Bool.self, forKey: .pending) ?? false
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encode(success, forKey: .success)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encodeIfPresent(deepLink, forKey: .deepLink)
        try container.encodeIfPresent(webLink, forKey: .webLink)
        try container.encodeIfPresent(cardText, forKey: .cardText)
        try container.encodeIfPresent(actionSummary, forKey: .actionSummary)
        try container.encodeIfPresent(risk, forKey: .risk)
        try container.encodeIfPresent(confirmation, forKey: .confirmation)
        try container.encode(pending, forKey: .pending)
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
    let actions: [ActionResult]?

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case actions
        case createdAt = "created_at"
    }

    var stableId: String {
        id ?? UUID().uuidString
    }
}

struct HistoryResponse: Codable {
    let history: [HistoryEntry]
}
