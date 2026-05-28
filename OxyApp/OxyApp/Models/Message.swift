import Foundation

struct Message: Identifiable, Equatable {
    let id: UUID
    let dbId: String?
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
        dbId: String? = nil,
        role: Role,
        content: String,
        timestamp: Date = Date(),
        actions: [ActionResult] = [],
        isStreaming: Bool = false
    ) {
        self.id = id
        self.dbId = dbId
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

extension Date {
    static func oxyParse(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        if let date = ISO8601DateFormatter().date(from: value) { return date }

        let normalized = value.replacingOccurrences(of: " ", with: "T")
        if let date = fractional.date(from: Self.trimFractionalSeconds(normalized)) { return date }
        if let date = ISO8601DateFormatter().date(from: Self.trimFractionalSeconds(normalized)) { return date }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        for format in [
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
            "yyyy-MM-dd'T'HH:mm:ssZ"
        ] {
            formatter.dateFormat = format
            if let date = formatter.date(from: Self.trimFractionalSeconds(normalized)) {
                return date
            }
        }
        return nil
    }

    var oxyISO8601String: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: self)
    }

    private static func trimFractionalSeconds(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"\.(\d{3})\d+([Zz]|[+-]\d{2}:?\d{2})"#,
            with: ".$1$2",
            options: .regularExpression
        )
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
    let connectorId: String?
    let healthStatus: String?

    enum CodingKeys: String, CodingKey {
        case action, result, success, text, error, deepLink, webLink, cardText, actionSummary, risk, confirmation, pending, connectorId, healthStatus
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
        pending: Bool = false,
        connectorId: String? = nil,
        healthStatus: String? = nil
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
        self.connectorId = connectorId
        self.healthStatus = healthStatus
    }

    init(native result: NativeLocalActionResult) {
        self.init(
            action: result.action,
            success: result.success,
            text: result.text,
            error: result.error,
            deepLink: result.deepLink,
            webLink: result.deepLink,
            cardText: result.cardText,
            actionSummary: result.actionSummary,
            risk: result.risk,
            confirmation: result.confirmation
        )
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
            connectorId = try result.decodeIfPresent(String.self, forKey: .connectorId)
            healthStatus = try result.decodeIfPresent(String.self, forKey: .healthStatus)
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
            connectorId = try container.decodeIfPresent(String.self, forKey: .connectorId)
            healthStatus = try container.decodeIfPresent(String.self, forKey: .healthStatus)
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
        try container.encodeIfPresent(connectorId, forKey: .connectorId)
        try container.encodeIfPresent(healthStatus, forKey: .healthStatus)
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

struct Briefing: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String?
    let body: String
    let source: String?
    let read: Bool?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, body, source, read
        case createdAt = "created_at"
    }

    var isUnread: Bool {
        read == false
    }
}

struct BriefingsResponse: Codable {
    let briefings: [Briefing]
}
