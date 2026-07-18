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
    /// Product photo(s) the browser-task agent found on the page it finished on (og:image,
    /// falling back to the largest visible <img>) — up to 3, shown as an image row in chat.
    let imageUrls: [String]?
    /// Real product name/price/checkout-total/color-options the browser-task agent read off
    /// the page it's on — used by the native buy-flow step UI. Never fabricated: absent
    /// whenever the model didn't genuinely observe the field on the page.
    let productName: String?
    let price: String?
    let total: String?
    let colorOptions: [String]?

    enum CodingKeys: String, CodingKey {
        case action, result, success, text, error, deepLink, webLink, cardText, actionSummary, risk, confirmation, pending, connectorId, healthStatus
        case headline, itinerary, routeContext, bookingUrl, distanceText, recoverable, recoveryAction, imageUrls
        case productName, price, total, colorOptions
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
        healthStatus: String? = nil,
        headline: String? = nil,
        itinerary: [TravelLeg]? = nil,
        routeContext: RouteContext? = nil,
        bookingUrl: String? = nil,
        distanceText: String? = nil,
        recoverable: Bool? = nil,
        recoveryAction: BrowserRecoveryAction? = nil,
        imageUrls: [String]? = nil,
        productName: String? = nil,
        price: String? = nil,
        total: String? = nil,
        colorOptions: [String]? = nil
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
        self.headline = headline
        self.itinerary = itinerary
        self.routeContext = routeContext
        self.bookingUrl = bookingUrl
        self.distanceText = distanceText
        self.recoverable = recoverable
        self.recoveryAction = recoveryAction
        self.imageUrls = imageUrls
        self.productName = productName
        self.price = price
        self.total = total
        self.colorOptions = colorOptions
    }

    init(native result: NativeLocalActionResult) {
        self.init(
            action: result.action,
            success: result.success,
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
            imageUrls = try result.decodeIfPresent([String].self, forKey: .imageUrls)
            productName = try result.decodeIfPresent(String.self, forKey: .productName)
            price = try result.decodeIfPresent(String.self, forKey: .price)
            total = try result.decodeIfPresent(String.self, forKey: .total)
            colorOptions = try result.decodeIfPresent([String].self, forKey: .colorOptions)
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
            headline = try container.decodeIfPresent(String.self, forKey: .headline)
            itinerary = try container.decodeIfPresent([TravelLeg].self, forKey: .itinerary)
            routeContext = try container.decodeIfPresent(RouteContext.self, forKey: .routeContext)
            bookingUrl = try container.decodeIfPresent(String.self, forKey: .bookingUrl)
            distanceText = try container.decodeIfPresent(String.self, forKey: .distanceText)
            recoverable = try container.decodeIfPresent(Bool.self, forKey: .recoverable)
            recoveryAction = try container.decodeIfPresent(BrowserRecoveryAction.self, forKey: .recoveryAction)
            imageUrls = try container.decodeIfPresent([String].self, forKey: .imageUrls)
            productName = try container.decodeIfPresent(String.self, forKey: .productName)
            price = try container.decodeIfPresent(String.self, forKey: .price)
            total = try container.decodeIfPresent(String.self, forKey: .total)
            colorOptions = try container.decodeIfPresent([String].self, forKey: .colorOptions)
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
        try container.encodeIfPresent(headline, forKey: .headline)
        try container.encodeIfPresent(itinerary, forKey: .itinerary)
        try container.encodeIfPresent(routeContext, forKey: .routeContext)
        try container.encodeIfPresent(bookingUrl, forKey: .bookingUrl)
        try container.encodeIfPresent(distanceText, forKey: .distanceText)
        try container.encodeIfPresent(recoverable, forKey: .recoverable)
        try container.encodeIfPresent(recoveryAction, forKey: .recoveryAction)
        try container.encodeIfPresent(imageUrls, forKey: .imageUrls)
        try container.encodeIfPresent(productName, forKey: .productName)
        try container.encodeIfPresent(price, forKey: .price)
        try container.encodeIfPresent(total, forKey: .total)
        try container.encodeIfPresent(colorOptions, forKey: .colorOptions)
    }
}

struct BrowserRecoveryAction: Codable, Equatable {
    let type: String?
    let message: String?
    let label: String?
    let autoContinue: Bool?
    let code: String?
    let reason: String?
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
    /// Folds a new batch of `.actions` SSE results into the existing list instead of
    /// replacing it outright. A turn can fire several distinct tool calls (e.g. two
    /// separate email searches); overwriting the array on every event silently dropped
    /// every result but the last one, so the visible receipt could show a completely
    /// different tool call than the one the assistant's own text just narrated.
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
    /// Stakes-first, casual one-liner from a server-side model pass — states the real
    /// consequence/deadline when there is one, not a neutral restatement of the email.
    /// Nil for older briefings created before this existed, or if that pass failed.
    let summary: String?
    /// Short server-judged action verb for the ONE useful next step ("Pay it", "Sort it",
    /// "Reply", "Ignore"...) — nil falls back to a generic "Draft reply" on the card.
    let cta: String?
    /// Which connected inbox this came from ("gmail" / "outlook") — nil for briefings
    /// created before multi-provider tagging existed. Drives the provider badge on the
    /// Home inbox card so a user with more than one connected account can tell them apart.
    let provider: String?

    var id: String { from + "|" + subject }

    // Inbox snippets arrive as raw HTML-ish text (&#39; &amp; &lt; …). Decode for display.
    var cleanFrom: String { from.decodingHTMLEntities() }
    var cleanSubject: String { subject.decodingHTMLEntities() }
    var cleanSnippet: String? { snippet?.decodingHTMLEntities() }

    /// Prefer a human name over `Name <addr@…>` so Today Inbox stays glanceable.
    var displayFrom: String {
        let raw = cleanFrom.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = raw.firstIndex(of: "<"), open > raw.startIndex {
            let name = raw[..<open].trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return name }
        }
        if let at = raw.firstIndex(of: "@"), raw.startIndex < at {
            let local = raw[..<at]
            // Bare addresses → local-part only when it looks like an email.
            if raw.contains("."), local.count >= 2 { return String(local) }
        }
        return raw
    }

    /// Marketing / bulk mail the dashboard shouldn't surface as something that needs you.
    /// ponytail: keyword heuristic; move to a server-side classifier if it misfires.
    var isLikelyPromotional: Bool {
        let haystack = "\(from) \(subject) \(snippet ?? "")".lowercased()
        let signals = [
            "% off", " off ", "sale", "deal", "discount", "coupon", "promo", "offer",
            "unsubscribe", "newsletter", "no-reply", "noreply", "do-not-reply",
            "free costume", "free gift", "streak", "festival", "limited time",
            "shop now", "buy now", "save up", "win ", "prize", "pool is closing",
            "premium", "upgrade now", "flash", "clearance", "lowest price", "best price"
        ]
        return signals.contains { haystack.contains($0) }
    }
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
