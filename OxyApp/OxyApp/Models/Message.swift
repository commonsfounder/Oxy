import Foundation

struct Message: Identifiable, Equatable {
    let id: UUID
    let dbId: String?
    let role: Role
    var content: String
    let timestamp: Date
    var actions: [ActionResult]
    var isStreaming: Bool
    /// User turns sent while another request is still running. They stay visible
    /// immediately, then the view model sends them after the active task settles.
    var queuedForActiveTask: Bool
    /// Recoverable per-turn failure copy. Kept on the assistant turn so a failed
    /// request has one inline retry surface instead of a global banner plus a row.
    var turnError: String?
    /// Web sources behind a grounded answer, when the model searched for it.
    var sources: [MessageSource]

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
        isStreaming: Bool = false,
        queuedForActiveTask: Bool = false,
        turnError: String? = nil,
        sources: [MessageSource] = []
    ) {
        self.id = id
        self.dbId = dbId
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.actions = actions
        self.isStreaming = isStreaming
        self.queuedForActiveTask = queuedForActiveTask
        self.turnError = turnError
        self.sources = sources
    }

    static func == (lhs: Message, rhs: Message) -> Bool {
        lhs.id == rhs.id
            && lhs.content == rhs.content
            && lhs.isStreaming == rhs.isStreaming
            && lhs.queuedForActiveTask == rhs.queuedForActiveTask
            && lhs.turnError == rhs.turnError
            && lhs.actions == rhs.actions
            && lhs.sources == rhs.sources
    }
}

/// A web source behind a grounded answer — a publisher title and the link.
struct MessageSource: Codable, Equatable, Identifiable {
    let title: String
    let uri: String
    var id: String { uri }
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
    let outcome: String?
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
    let headline: String?
    let itinerary: [TravelLeg]?
    let routeContext: RouteContext?
    let bookingUrl: String?
    let distanceText: String?
    let recoverable: Bool?
    let recoveryAction: BrowserRecoveryAction?
    /// What this result is ABOUT, whatever kind of thing it is: an order, a booking, a form,
    /// a document, an account. Commerce used to have its own first-class fields here
    /// (productName/price/total/colorOptions), which made every other kind of work a
    /// second-class citizen of the message model.
    let subject: ResultSubject?
    /// Completed browser-task identifier.
    let taskId: String?

    /// Bounded backend outcomes keep handoffs and review pauses visible without
    /// treating their legacy `success` compatibility flag as a completed effect.
    var isCompleted: Bool { outcome == "completed" || (outcome == nil && success) }
    var needsUser: Bool { pending || outcome == "awaiting_user" }
    var isHandoff: Bool { outcome == "handoff_required" }
    var isFailure: Bool {
        switch outcome {
        case "completed", "awaiting_user", "handoff_required", "simulated": return false
        case "failed", "unavailable": return true
        case "incomplete": return false
        default: return !success
        }
    }

    enum CodingKeys: String, CodingKey {
        case action, result, success, outcome, text, error, deepLink, webLink, cardText, actionSummary, risk, confirmation, pending, connectorId, healthStatus
        case headline, itinerary, routeContext, bookingUrl, distanceText, recoverable, recoveryAction
        case subject, taskId
        // Older servers sent these at the top level; decoded into `subject` below.
        case imageUrls, productName, price, total, colorOptions
    }

    init(
        action: String,
        success: Bool,
        outcome: String? = nil,
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
        healthStatus: String? = nil,
        headline: String? = nil,
        itinerary: [TravelLeg]? = nil,
        routeContext: RouteContext? = nil,
        bookingUrl: String? = nil,
        distanceText: String? = nil,
        recoverable: Bool? = nil,
        recoveryAction: BrowserRecoveryAction? = nil,
        subject: ResultSubject? = nil,
        taskId: String? = nil
    ) {
        self.action = action
        self.success = success
        self.outcome = outcome
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
        self.headline = headline
        self.itinerary = itinerary
        self.routeContext = routeContext
        self.bookingUrl = bookingUrl
        self.distanceText = distanceText
        self.recoverable = recoverable
        self.recoveryAction = recoveryAction
        self.subject = subject
        self.taskId = taskId
    }

    init(native result: NativeLocalActionResult) {
        self.init(
            action: result.action,
            success: result.success,
            outcome: result.success ? "completed" : "failed",
            text: result.text,
            error: result.error,
            deepLink: result.deepLink,
            webLink: nil,
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
            outcome = try result.decodeIfPresent(String.self, forKey: .outcome)
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
            headline = try result.decodeIfPresent(String.self, forKey: .headline)
            itinerary = try result.decodeIfPresent([TravelLeg].self, forKey: .itinerary)
            routeContext = try result.decodeIfPresent(RouteContext.self, forKey: .routeContext)
            bookingUrl = try result.decodeIfPresent(String.self, forKey: .bookingUrl)
            distanceText = try result.decodeIfPresent(String.self, forKey: .distanceText)
            recoverable = try result.decodeIfPresent(Bool.self, forKey: .recoverable)
            recoveryAction = try result.decodeIfPresent(BrowserRecoveryAction.self, forKey: .recoveryAction)
            subject = try ResultSubject.decode(from: result)
            taskId = try result.decodeIfPresent(String.self, forKey: .taskId)
        } else {
            success = try container.decodeIfPresent(Bool.self, forKey: .success) ?? false
            outcome = try container.decodeIfPresent(String.self, forKey: .outcome)
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
            headline = try container.decodeIfPresent(String.self, forKey: .headline)
            itinerary = try container.decodeIfPresent([TravelLeg].self, forKey: .itinerary)
            routeContext = try container.decodeIfPresent(RouteContext.self, forKey: .routeContext)
            bookingUrl = try container.decodeIfPresent(String.self, forKey: .bookingUrl)
            distanceText = try container.decodeIfPresent(String.self, forKey: .distanceText)
            recoverable = try container.decodeIfPresent(Bool.self, forKey: .recoverable)
            recoveryAction = try container.decodeIfPresent(BrowserRecoveryAction.self, forKey: .recoveryAction)
            subject = try ResultSubject.decode(from: container)
            taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encode(success, forKey: .success)
        try container.encodeIfPresent(outcome, forKey: .outcome)
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
        try container.encodeIfPresent(headline, forKey: .headline)
        try container.encodeIfPresent(itinerary, forKey: .itinerary)
        try container.encodeIfPresent(routeContext, forKey: .routeContext)
        try container.encodeIfPresent(bookingUrl, forKey: .bookingUrl)
        try container.encodeIfPresent(distanceText, forKey: .distanceText)
        try container.encodeIfPresent(recoverable, forKey: .recoverable)
        try container.encodeIfPresent(recoveryAction, forKey: .recoveryAction)
        try container.encodeIfPresent(subject, forKey: .subject)
        try container.encodeIfPresent(taskId, forKey: .taskId)
    }
}

/// What a result is about — an order, a booking, an application, a document, an account. General
/// rather than commerce-specific, so a submitted form has somewhere to put its details too. Every
/// field is optional and only ever populated from something observed.
struct ResultSubject: Codable, Equatable {
    /// What it is: "Nike Air Max 90", "Tenancy application", "Council tax account".
    let name: String?
    /// Money involved, exactly as displayed, when there is any.
    let amount: String?
    /// Pictures the page genuinely showed.
    let imageUrls: [String]?
    /// Distinct selectable choices the page genuinely offered (sizes, colours, time slots,
    /// delivery options). Never a fabricated default set.
    let options: [String]?

    var isEmpty: Bool {
        name == nil && amount == nil && (imageUrls?.isEmpty ?? true) && (options?.isEmpty ?? true)
    }

    init(name: String? = nil, amount: String? = nil, imageUrls: [String]? = nil, options: [String]? = nil) {
        self.name = name
        self.amount = amount
        self.imageUrls = imageUrls
        self.options = options
    }

    /// Reads the nested `subject` object, falling back to the flat commerce keys an older
    /// server still sends so an app update does not have to be lockstep with a deploy.
    static func decode<K: CodingKey>(from container: KeyedDecodingContainer<K>) throws -> ResultSubject? {
        // `try?` flattens the optional here, so one unwrap is enough.
        if let key = K(stringValue: "subject"),
           let nested = try? container.decodeIfPresent(ResultSubject.self, forKey: key),
           !nested.isEmpty {
            return nested
        }
        func string(_ name: String) -> String? {
            guard let key = K(stringValue: name),
                  let value = try? container.decodeIfPresent(String.self, forKey: key) else { return nil }
            return value
        }
        func strings(_ name: String) -> [String]? {
            guard let key = K(stringValue: name),
                  let value = try? container.decodeIfPresent([String].self, forKey: key) else { return nil }
            return value
        }
        let legacy = ResultSubject(
            name: string("productName"),
            amount: string("total") ?? string("price"),
            imageUrls: strings("imageUrls"),
            options: strings("colorOptions")
        )
        return legacy.isEmpty ? nil : legacy
    }
}

struct BrowserRecoveryAction: Codable, Equatable {
    let type: String?
    let message: String?
    let label: String?
    let autoContinue: Bool?
    let code: String?
    let reason: String?
    /// Set on `reauth_login` — the site the sign-in sheet should post the typed
    /// credential for (POST /browser-task/reauth-login).
    let site: String?
    /// Portable checkout profile categories currently required by the visible merchant
    /// form. No values or merchant DOM data are returned to the chat layer.
    let fields: [String]?
}

struct TravelLeg: Codable, Equatable, Identifiable {
    var id: String {
        [from, to, service, line, departure, arrival].compactMap { $0 }.joined(separator: "|")
    }

    let type: String?
    let service: String?
    let line: String?
    let from: String?
    let to: String?
    let departure: String?
    let arrival: String?
    let platform: String?
    let stops: Int?
    let duration: String?
}

struct RouteContext: Codable, Equatable {
    let origin: String?
    let destination: String?
    let mode: String?
    let departure: String?
    let arrival: String?
    let duration: String?
    let distance: String?
    let leaveBy: String?
    let reason: String?
}

extension Array where Element == ActionResult {
    /// Folds a new batch of `.actions` results into the existing list rather than replacing it.
    /// A turn can fire several tool calls, and overwriting keeps only the last — leaving the
    /// visible receipt showing a different call than the assistant's text just narrated.
    mutating func merging(_ incoming: [ActionResult]) {
        for result in incoming {
            if let idx = firstIndex(where: { $0.pending && $0.action == result.action }) {
                // A pending confirmation resolving to its final state — update in place.
                self[idx] = result
            } else if let idx = firstIndex(where: { $0.mergeKey == result.mergeKey }) {
                self[idx] = result
            } else {
                append(result)
            }
        }
    }
}

private extension ActionResult {
    /// `id` intentionally stays short for SwiftUI identity, but merging SSE action
    /// batches needs a wider key. Several tool calls can share the same action and
    /// empty text while differing in card/deep-link payload; matching only on
    /// `action + text` can overwrite an earlier receipt in the same assistant turn.
    var mergeKey: String {
        [
            action,
            text ?? "",
            error ?? "",
            deepLink ?? "",
            webLink ?? "",
            cardText ?? "",
            actionSummary ?? "",
            confirmation ?? "",
            connectorId ?? "",
            healthStatus ?? "",
            pending ? "pending" : "done"
        ].joined(separator: "\u{1F}")
    }
}

struct AuthResponse: Codable {
    let success: Bool
    let token: String?
    let userId: String?
    let error: String?
    let demo: Bool?
}

struct HistoryEntry: Codable, Identifiable {
    let id: String?
    let role: String
    let content: String
    let createdAt: String?
    let actions: [ActionResult]?
    let sources: [MessageSource]?

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case actions
        case sources
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
    let metadata: BriefingMetadata?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, body, source, read, metadata
        case createdAt = "created_at"
    }

    var isUnread: Bool {
        read == false
    }

    var emails: [BriefingEmail] {
        metadata?.emails ?? []
    }

    var incoming: [BriefingIncoming] {
        metadata?.incoming ?? []
    }

    var lead: String? { metadata?.lead }
    var signals: [BriefingSignal] { metadata?.signals ?? [] }

    /// Editorial day narrative for the Today hero ("This evening" voice). Server prose.
    var narrative: String? { metadata?.narrative?.nonEmpty }
    /// One-line wellbeing reflection grounded in the day's health data. Server prose.
    var wellbeing: String? { metadata?.wellbeing?.nonEmpty }
}

/// A bounded, ranked answer to the ambient question "what matters?". It is deliberately
/// smaller than the underlying inbox, calendar, or task payloads so Home can lead with a
/// useful human summary and let Chat handle the follow-up.
struct LifeBriefing: Codable, Equatable {
    let headline: String
    let items: [LifeBriefingItem]
    let empty: Bool
    let generatedAt: String?
    let coverage: LifeBriefingCoverage?
}

struct LifeBriefingItem: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let detail: String
    let urgency: String
    let prompt: String?
    let taskId: String?
    let approvalId: String?
    let review: LifeBriefingReview?

    init(
        id: String,
        kind: String,
        title: String,
        detail: String,
        urgency: String,
        prompt: String?,
        taskId: String?,
        approvalId: String?,
        review: LifeBriefingReview? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.urgency = urgency
        self.prompt = prompt
        self.taskId = taskId
        self.approvalId = approvalId
        self.review = review
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, title, detail, urgency, prompt, taskId, approvalId, review
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.kind = try container.decode(String.self, forKey: .kind)
        self.title = try container.decode(String.self, forKey: .title)
        self.detail = try container.decode(String.self, forKey: .detail)
        self.urgency = try container.decode(String.self, forKey: .urgency)
        self.prompt = try container.decodeIfPresent(String.self, forKey: .prompt)
        self.taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        self.approvalId = try container.decodeIfPresent(String.self, forKey: .approvalId)
        self.review = try container.decodeIfPresent(LifeBriefingReview.self, forKey: .review)
    }

    var iconName: String {
        switch kind.lowercased() {
        case "calendar": return "calendar"
        case "message": return "envelope"
        case "approval": return "shield-check"
        case "goal": return "bolt"
        case "watch": return "clock"
        default: return "sparkles"
        }
    }

    var reviewAction: ActionResult? {
        guard kind.caseInsensitiveCompare("approval") == .orderedSame,
              let review else { return nil }
        let detail = [review.recipient, review.subject, review.body, review.detail]
            .compactMap { value -> String? in
                guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
        let isEmail = ["send_email", "send_outlook_email"].contains(review.action)
        return ActionResult(
            action: review.action,
            success: false,
            outcome: "awaiting_user",
            text: isEmail ? "Check the email, then tap Send." : "Check the details, then choose what to do.",
            cardText: detail.isEmpty ? nil : detail,
            actionSummary: isEmail ? "Email ready to send" : nil,
            risk: "high",
            confirmation: "review_required",
            pending: true
        )
    }

    var displayTitle: String {
        var words = title.split(separator: " ").map(String.init)
        while words.count > 1,
              words[words.count - 1].caseInsensitiveCompare(words[words.count - 2]) == .orderedSame {
            words.removeLast()
        }
        return words.joined(separator: " ")
            .replacingOccurrences(of: "a appointment", with: "an appointment", options: .caseInsensitive)
    }

    var displayDetail: String? {
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        guard !trimmed.isEmpty,
              !lower.contains("needs your attention"),
              !lower.contains("millie can continue") else {
            return nil
        }
        return trimmed
    }
}

struct LifeBriefingReview: Codable, Equatable {
    let action: String
    let recipient: String?
    let subject: String?
    let body: String?
    let detail: String?

    init(
        action: String,
        recipient: String? = nil,
        subject: String? = nil,
        body: String? = nil,
        detail: String? = nil
    ) {
        self.action = action
        self.recipient = recipient
        self.subject = subject
        self.body = body
        self.detail = detail
    }
}

struct LifeBriefingCoverage: Codable, Equatable {
    let goals: Bool
    let approvals: Bool
    let messages: Bool
    let calendar: Bool
    let watches: Bool
}

struct BriefingMetadata: Codable, Equatable {
    let emails: [BriefingEmail]?
    let incoming: [BriefingIncoming]?
    let lead: String?
    let signals: [BriefingSignal]?
    let narrative: String?
    let wellbeing: String?
}

private extension String {
    /// nil when empty/whitespace, so the UI can fall back to local copy.
    var nonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

/// One ranked "what matters today" item. `status` is server-set:
/// - `done`    — a safe action already auto-ran; `receipt` describes it.
/// - `pending` — a sensitive action waiting on a tap; `label`+`prompt` drive it (sent into chat).
/// - `info`    — informational only, no action.
struct BriefingSignal: Codable, Equatable, Identifiable {
    let title: String
    let detail: String?
    let status: String?
    let receipt: String?
    let label: String?
    let prompt: String?
    /// Present only on auto-executed actions that can be reversed (the server holds the
    /// actual descriptor; the app just needs to know an Undo exists and send the title back).
    let undo: BriefingSignalUndo?

    var id: String { title + "|" + (status ?? "") }
    var isDone: Bool { status == "done" }
    var isPending: Bool { status == "pending" }
    var canUndo: Bool { isDone && undo != nil }
}

struct BriefingSignalUndo: Codable, Equatable {
    let type: String?
}

struct BriefingEmail: Codable, Equatable, Identifiable {
    let from: String
    let subject: String
    let snippet: String?
    let date: String?
    /// Brief stakes or next step.
    let summary: String?
    /// Suggested next step.
    let cta: String?
    /// Connected inbox source.
    let provider: String?
    /// Provider message ID.
    let messageId: String?

    var id: String { from + "|" + subject }

    var cleanFrom: String { from.decodingHTMLEntities() }
    var cleanSubject: String { subject.decodingHTMLEntities() }
    var cleanSnippet: String? { snippet?.decodingHTMLEntities() }

    var displayFrom: String {
        let raw = cleanFrom.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = raw.firstIndex(of: "<"), open > raw.startIndex {
            let name = raw[..<open].trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return name }
        }
        if let at = raw.firstIndex(of: "@"), raw.startIndex < at {
            let local = raw[..<at]
            if raw.contains("."), local.count >= 2 { return String(local) }
        }
        return raw
    }

    var isLikelyPromotional: Bool {
        let haystack = "\(from) \(subject) \(snippet ?? "") \(summary ?? "")".lowercased()
        let signals = [
            "% off", " off ", "sale", "deal", "discount", "coupon", "promo", "offer",
            "unsubscribe", "newsletter", "no-reply", "noreply", "do-not-reply",
            "free costume", "free gift", "streak", "festival", "limited time",
            "shop now", "buy now", "save up", "win ", "prize", "pool is closing",
            "premium", "upgrade now", "flash", "clearance", "lowest price", "best price",
            "leaderboard", "enter to win", "cup challenge", "daily news digest",
            "weekly update", "great opportunity", "new features and product"
        ]
        return signals.contains { haystack.contains($0) }
    }
}

/// Response from POST /emails/action-plan — the server mines the real email for real
/// links it already contained and writes manual steps, it never attempts to log into
/// anything on the user's behalf. See buildEmailActionPlan in api/index.js.
struct EmailActionPlan: Codable, Equatable {
    let success: Bool
    let error: String?
    let steps: [String]?
    let links: [EmailActionLink]?
}

struct EmailActionLink: Codable, Equatable, Identifiable {
    let label: String
    let url: String
    var id: String { url }
}

/// A delivery, order, or reservation parsed server-side from the user's inbox.
/// `stage` is delivery progress 0…3 (ordered→delivered); nil for reservations.
struct BriefingIncoming: Codable, Equatable, Identifiable {
    let kind: String        // "delivery" | "reservation"
    let title: String
    let vendor: String
    let status: String
    let eta: String?
    let stage: Int?

    var id: String { vendor + "|" + title }
    var isDelivery: Bool { kind == "delivery" }
    var cleanTitle: String { title.decodingHTMLEntities() }
}

extension String {
    /// Lightweight HTML entity decode covering what inbox snippets actually contain
    /// (numeric &#NN; / &#xNN; plus the handful of common named entities). Avoids
    /// NSAttributedString's slow per-call HTML parse.
    func decodingHTMLEntities() -> String {
        guard contains("&") else { return self }
        var result = self
        let named = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&apos;": "'", "&nbsp;": " ", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–"
        ]
        for (entity, char) in named {
            result = result.replacingOccurrences(of: entity, with: char)
        }
        // Numeric entities: &#39; and &#x27;
        if let regex = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);") {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed()
            for m in matches {
                guard let full = Range(m.range, in: result),
                      let hexFlag = Range(m.range(at: 1), in: result),
                      let codeRange = Range(m.range(at: 2), in: result) else { continue }
                let isHex = !result[hexFlag].isEmpty
                let code = String(result[codeRange])
                guard let value = UInt32(code, radix: isHex ? 16 : 10),
                      let scalar = Unicode.Scalar(value) else { continue }
                result.replaceSubrange(full, with: String(Character(scalar)))
            }
        }
        return result
    }
}

struct BriefingsResponse: Codable {
    let briefings: [Briefing]
}
