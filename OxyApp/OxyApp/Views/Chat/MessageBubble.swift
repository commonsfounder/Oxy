import SwiftUI

struct MessageBubble: View {
    let message: Message
    var showsTypingIndicator: Bool = true
    /// True when this message is the first in a run from the same sender.
    var isGroupStart: Bool = true
    /// True when this message is the last in a run from the same sender.
    var isGroupEnd: Bool = true
    /// Parent-level decision so timestamps can be grouped by conversation cadence,
    /// not blindly emitted after every transient action/status update.
    var showsTimestamp: Bool = true
    var onActionCommand: ((String) -> Void)? = nil
    var onOpenAction: ((ActionResult) -> Void)? = nil

    private var isUser: Bool { message.role == .user }
    private var isCompact: Bool { OxySettingsCache.current.bubbleStyle == "compact" }

    /// Completed, renderable actions. Pending confirmations are handled by the
    /// review flow in ChatView; a successful send_message hands off to the native
    /// composer. Neither belongs in the stream.
    private var completedActions: [ActionResult] {
        message.actions.filter {
            !$0.pending && !($0.action == "send_message" && $0.success)
        }
    }

    /// Actions that keep a dedicated rich card (native handoffs and results the
    /// prose can't carry). Everything else folds into the one-line turn receipt.
    private static func isRichAction(_ action: ActionResult) -> Bool {
        switch action.action {
        case "book_uber",
             "search_flights", "get_flight_prices",
             "search_hotels", "check_hotel_availability",
             "search_activities", "get_activity_details",
             "save_trip":
            return true
        case "get_directions", "plan_trip":
            return action.success && (action.deepLink != nil || action.webLink != nil)
        default:
            return false
        }
    }

    private var richActions: [ActionResult] { completedActions.filter(Self.isRichAction) }
    private var receiptActions: [ActionResult] { completedActions.filter { !Self.isRichAction($0) } }

    /// A ride booking gets a dedicated native handoff card; suppress the
    /// assistant's "Opening Uber…" chat text so the card stands alone.
    private var uberAction: ActionResult? {
        message.actions.first { $0.action == "book_uber" && !$0.pending }
    }

    // User turns stay compact rounded bubbles, right-aligned. Assistant turns sit
    // as plain text directly on the canvas — no fill, no accent bar — so the
    // conversation reads like a considered reply, not a chat-widget echo.
    private var bubbleShape: some Shape {
        RoundedRectangle(cornerRadius: AppRadius.bubble, style: .continuous)
    }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: isCompact ? 2 : 6) {
            // Message content
            if !message.content.isEmpty && uberAction == nil {
                if isUser {
                    HStack(alignment: .bottom, spacing: 0) {
                        Spacer(minLength: 48)
                        Text(AttributedString(message.content))
                            .font(.appBody(isCompact ? 15 : 16))
                            .foregroundStyle(Color.appInk)
                            .lineSpacing(isCompact ? 4 : 5)
                            .textSelection(.enabled)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(bubbleShape.fill(Color.appUserBubble))
                    }
                } else {
                    Group {
                        if message.isStreaming {
                            StreamingWordText(
                                text: message.content,
                                fontSize: isCompact ? 15 : 15.5,
                                lineSpacing: isCompact ? 4 : 5
                            )
                        } else {
                            AssistantAnswerView(text: message.content, compact: isCompact)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            // Streaming indicator
            if message.isStreaming && message.content.isEmpty && showsTypingIndicator {
                HStack {
                    OxyThinkingIndicator(label: "Millie is working")
                        .padding(.vertical, 6)
                    Spacer(minLength: 64)
                }
            }

            // Agent work: rich handoff cards keep their surface; everything else
            // collapses into one quiet receipt line per turn.
            if !richActions.isEmpty || !receiptActions.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(richActions) { action in
                        if action.action == "book_uber" {
                            UberHandoffCard(action: action) { onOpenAction?(action) }
                        } else if ["search_flights", "get_flight_prices"].contains(action.action) {
                            TravelResultCard(action: action, kind: .flights)
                        } else if ["search_hotels", "check_hotel_availability"].contains(action.action) {
                            TravelResultCard(action: action, kind: .hotels)
                        } else if ["search_activities", "get_activity_details"].contains(action.action) {
                            TravelResultCard(action: action, kind: .activities)
                        } else if action.action == "save_trip" {
                            TravelResultCard(action: action, kind: .trip)
                        } else if ["get_directions", "plan_trip"].contains(action.action) {
                            DirectionsLink(action: action)
                        }
                    }

                    if !receiptActions.isEmpty {
                        TurnReceiptRow(actions: receiptActions) { action in
                            onOpenAction?(action)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
            }

            // Sources
            if !isUser, !message.sources.isEmpty {
                MessageSourceChips(sources: message.sources)
                    .padding(.top, 8)
                    .padding(.trailing, 64)
            }

            // Timestamp — group-end only, very quiet
            if showsTimestamp {
                Text(message.timestamp, style: .time)
                    .font(.appBody(10))
                    .monospacedDigit()
                    .foregroundStyle(Color.appMuted.opacity(0.72))
                    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, AppSpacing.chatMargin)
        .padding(.vertical, isCompact ? 2 : 4)
        .transition(.asymmetric(
            insertion: .opacity
                .combined(with: .move(edge: .bottom))
                .combined(with: .scale(scale: 0.97, anchor: isUser ? .bottomTrailing : .bottomLeading)),
            removal: .opacity
        ))
        // Animate the streaming→settled flip, not every token. Animating on
        // `content` re-ran a spring layout pass per streamed word — a stutter source.
        .animation(.appSpring, value: message.isStreaming)
    }
}

// MARK: - Chat markdown

extension AttributedString {
    /// Markdown for chat prose: inline styles and tappable links, with heading
    /// markers flattened to plain lines — full block parsing would collapse the
    /// newlines chat text relies on. Bare URLs are promoted to links first.
    static func chatMarkdown(_ text: String) -> AttributedString {
        var source = text.normalizingChatBullets.replacingOccurrences(
            of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        source = source.replacingOccurrences(
            of: #"(?<![("\[])(https?://[^\s<>()\[\]]+)"#,
            with: "[$1]($1)", options: .regularExpression)
        guard var parsed = try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return AttributedString(text.strippingMarkdown) }
        for run in parsed.runs where run.link != nil {
            parsed[run.range].underlineStyle = .single
        }
        return parsed
    }
}

extension String {
    /// Plain-prose version for card excerpts — heading, emphasis, and code
    /// markers removed rather than rendered.
    var strippingMarkdown: String {
        self
            .normalizingChatBullets
            .replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`]{1,3}"#, with: "", options: .regularExpression)
    }

    /// Turns a leading `*`/`-`/`+` list marker at the start of a line into a plain
    /// "•" bullet. `AttributedString(markdown:)` is parsed with `.inlineOnlyPreservingWhitespace`
    /// (block-level parsing would collapse the newlines chat prose relies on), so it
    /// never recognizes `* item` as a real list — the asterisk survives verbatim as a
    /// literal character. Converting it before parsing removes the raw symbol without
    /// needing block-level markdown support.
    var normalizingChatBullets: String {
        replacingOccurrences(
            of: #"(?m)^(\s*)[*+-]\s+"#,
            with: "$1• ",
            options: .regularExpression
        )
    }
}

private struct StreamingWordText: View {
    let text: String
    let fontSize: CGFloat
    let lineSpacing: CGFloat

    private var words: [String] {
        // Streaming renders raw text with no markdown parsing (word-by-word fades
        // can't wait for a full AttributedString pass), so at minimum strip the
        // literal bullet markers here too — otherwise every list leaks `*`/`-` for
        // the entire duration of the stream, not just a brief flash.
        text.strippingMarkdown.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    }

    var body: some View {
        Text(attributedText)
            .font(.appBody(fontSize))
            .foregroundStyle(Color.appInk)
            .lineSpacing(lineSpacing)
            .animation(.appRelax, value: words.count)
    }

    private var attributedText: AttributedString {
        var output = AttributedString()
        for (index, word) in words.enumerated() {
            var part = AttributedString(index == words.count - 1 ? word : "\(word) ")
            let distanceFromEnd = words.count - index
            // Five-step fade: trailing words glow up to 1.0, farthest recede to 0.55.
            let opacity: Double = switch distanceFromEnd {
            case 1:       1.00
            case 2:       0.95
            case 3:       0.85
            case 4:       0.72
            case 5:       0.62
            default:      0.55
            }
            part.foregroundColor = Color.appInk.opacity(opacity)
            output += part
        }
        return output
    }
}

private struct AssistantAnswerView: View {
    let text: String
    let compact: Bool

    private var blocks: [AssistantTextBlock] {
        AssistantTextBlock.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 9 : 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(.chatMarkdown(text))
                        .font(.appBody(compact ? 14.5 : 15.5))
                        .foregroundStyle(Color.appInk.opacity(0.96))
                        .lineSpacing(compact ? 4 : 5.5)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                case .heading(let text):
                    Text(text.strippingMarkdown)
                        .font(.appBody(compact ? 14 : 15, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .padding(.top, 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                case .bullet(let text):
                    AssistantListRow(marker: "•", text: text, compact: compact)

                case .numbered(let index, let text):
                    AssistantListRow(marker: "\(index)", text: text, compact: compact)
                }
            }
        }
    }
}

private struct AssistantListRow: View {
    let marker: String
    let text: String
    let compact: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(marker)
                .font(.appBody(compact ? 12 : 13, weight: .medium))
                .foregroundStyle(Color.appAccent.opacity(0.86))
                .frame(width: marker == "•" ? 14 : 18, alignment: .trailing)
            Text(.chatMarkdown(text))
                .font(.appBody(compact ? 14.5 : 15.5))
                .foregroundStyle(Color.appInk.opacity(0.94))
                .lineSpacing(compact ? 4 : 5)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

private enum AssistantTextBlock {
    case heading(String)
    case paragraph(String)
    case bullet(String)
    case numbered(Int, String)

    static func parse(_ raw: String) -> [AssistantTextBlock] {
        let normalized = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n\n\n+", with: "\n\n", options: .regularExpression)
        var blocks: [AssistantTextBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            let joined = paragraph
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(.paragraph(joined))
            }
            paragraph.removeAll()
        }

        for line in normalized.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else {
                flushParagraph()
                continue
            }

            if let match = trimmed.firstMatch(of: #"^#{1,4}\s+(.+)$"#) {
                flushParagraph()
                blocks.append(.heading(match))
            } else if let match = trimmed.firstMatch(of: #"^[*+-]\s+(.+)$"#) {
                flushParagraph()
                blocks.append(.bullet(match))
            } else if let match = trimmed.firstNumberedListItem {
                flushParagraph()
                blocks.append(.numbered(match.index, match.text))
            } else {
                paragraph.append(trimmed)
            }
        }
        flushParagraph()
        return blocks.isEmpty ? [.paragraph(raw)] : blocks
    }
}

private extension String {
    func firstMatch(of pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(startIndex..., in: self)
        guard let match = regex.firstMatch(in: self, range: range),
              match.numberOfRanges > 1,
              let bodyRange = Range(match.range(at: 1), in: self) else {
            return nil
        }
        return String(self[bodyRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var firstNumberedListItem: (index: Int, text: String)? {
        guard let regex = try? NSRegularExpression(pattern: #"^(\d+)[.)]\s+(.+)$"#) else { return nil }
        let range = NSRange(startIndex..., in: self)
        guard let match = regex.firstMatch(in: self, range: range),
              match.numberOfRanges > 2,
              let indexRange = Range(match.range(at: 1), in: self),
              let bodyRange = Range(match.range(at: 2), in: self),
              let index = Int(self[indexRange]) else {
            return nil
        }
        return (index, String(self[bodyRange]).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

// MARK: - Directions Link

/// A flat, minimal tap target that opens a route in Maps. Replaces the full
/// ActionCard for directions/transit results — the text is already the answer.
private struct DirectionsLink: View {
    let action: ActionResult

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Text("Open in Maps")
                    .font(.appBody(13))
                    .foregroundStyle(Color.appTitanium)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.appHairline).frame(height: 0.5)
            }
        }
        .buttonStyle(.appScale(0.98))
        .contentShape(Rectangle())
    }

    private func open() {
        let urlString = action.deepLink ?? action.webLink
        guard let urlString, let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - Source Chips

/// A restrained row of web sources beneath a grounded answer: a quiet eyebrow and
/// tappable publisher chips. The trust signal that the answer was looked up, not
/// guessed. Sharp-edged and muted to stay in the luxury language.
private struct MessageSourceChips: View {
    let sources: [MessageSource]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Text("Sources")
                    .appEyebrow()
                    .foregroundStyle(Color.appMuted)

                ForEach(sources) { source in
                    Button {
                        guard let url = URL(string: source.uri) else { return }
                        UIApplication.shared.open(url)
                    } label: {
                        HStack(spacing: 4) {
                            Text(source.title)
                                .font(.appBody(11))
                                .lineLimit(1)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 8, weight: .semibold))
                        }
                        .foregroundStyle(Color.appTitanium)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .overlay(Rectangle().strokeBorder(Color.appHairline, lineWidth: 0.5))
                    }
                    .buttonStyle(.appScale)
                }
            }
        }
    }
}

// MARK: - Action Card

private enum ToolStatusState {
    case success
    case failure
    case neutral
}

private struct ToolStatusGlyph: View {
    let state: ToolStatusState

    var body: some View {
        Group {
            switch state {
            case .success:
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.appSuccess)
            case .failure:
                Image(systemName: "exclamationmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.appDanger)
            case .neutral:
                Circle()
                    .fill(Color.appMuted.opacity(0.5))
                    .frame(width: 6, height: 6)
            }
        }
        .frame(width: 16, height: 19, alignment: .center)
    }
}

private struct ToolHeader: View {
    let icon: String
    let eyebrow: String
    let state: ToolStatusState

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .regular))
                .foregroundStyle(Color.appMuted)
                .frame(width: 14, alignment: .center)
            Text(eyebrow)
                .appEyebrow()
            Spacer()
            ToolStatusGlyph(state: state)
        }
    }
}

// MARK: - Uber Handoff Card

/// A native ride-booking transition card. Keeps the deep-link handoff, but reads
/// like a consumer choice rather than a telemetry panel.
struct UberHandoffCard: View {
    let action: ActionResult
    var onOpen: () -> Void

    // Destination comes from the assistant text ("Opening Uber to X…"); the
    // metrics live in cardText ("X · 9 min · £8.40").
    private var destinationSource: String {
        action.text ?? action.actionSummary ?? action.cardText ?? ""
    }
    private var metricSource: String {
        "\(action.cardText ?? "") \(action.text ?? "")"
    }

    private var destination: String {
        var tail = destinationSource
        // TODO(backend): destination selection can resolve "King's Cross" to a
        // nearby POI such as the Harry Potter Shop. Fix ranking/canonical
        // destination choice server-side rather than special-casing it here.
        if let range = tail.range(of: " to ", options: .caseInsensitive) {
            tail = String(tail[range.upperBound...])
        }
        // Trim at the first sentence end or the " · " metrics separator.
        if let dot = tail.firstIndex(of: ".") { tail = String(tail[..<dot]) }
        if let sep = tail.range(of: " · ") { tail = String(tail[..<sep.lowerBound]) }
        tail = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        return tail.isEmpty ? "—" : tail
    }

    private var eta: String { firstMatch(#"(\d+)\s*min"#, in: metricSource) ?? "—" }
    private var estimate: String { firstMatch(#"[£$€]\s?\d+(?:\.\d{1,2})?"#, in: metricSource) ?? "—" }
    private var etaPhrase: String {
        guard let minutes = Int(eta) else { return "time estimate unavailable" }
        if minutes < 60 { return "about \(minutes) min" }
        let hours = minutes / 60
        let mins = minutes % 60
        return mins == 0 ? "about \(hours) hr" : "about \(hours) hr \(mins) min"
    }

    var body: some View {
        Button(action: onOpen) {
            TodayCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "car")
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(Color.appMuted)
                        Text("Ride to \(destination)")
                            .font(.appBody(14.5, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .lineLimit(2)
                        Spacer(minLength: 8)
                        ToolStatusGlyph(state: action.success ? .success : .failure)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Uber · \(etaPhrase)")
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                        if estimate != "—" {
                            Text("\(estimate) estimated")
                                .font(.appBody(13))
                                .foregroundStyle(Color.appMuted)
                        }
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.98))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Ride to \(destination). Tap to open Uber.")
    }

    private func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else { return nil }
        // Prefer the first capture group if present, else the whole match.
        let target = match.numberOfRanges > 1 && match.range(at: 1).location != NSNotFound
            ? match.range(at: 1) : match.range
        guard let r = Range(target, in: text) else { return nil }
        return String(text[r])
    }
}

// MARK: - Travel Result Card

struct TravelResultCard: View {
    enum Kind { case flights, hotels, activities, trip }

    let action: ActionResult
    let kind: Kind

    private var eyebrow: String {
        switch kind {
        case .flights:    return "FLIGHTS"
        case .hotels:     return "HOTELS"
        case .activities: return "ACTIVITIES"
        case .trip:       return "TRIP SAVED"
        }
    }

    private var icon: String {
        switch kind {
        case .flights:    return "airplane"
        case .hotels:     return "bed.double"
        case .activities: return "ticket"
        case .trip:       return "suitcase"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ToolHeader(icon: icon, eyebrow: eyebrow, state: action.success ? .success : .failure)

            if let text = action.text, !text.isEmpty {
                Text(text.strippingMarkdown)
                    .font(.appBody(13))
                    .foregroundStyle(action.success ? Color.appInk : Color.appMuted)
                    .lineLimit(6)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface)
        // Rounded card silhouette to match every other card in the message stream
        // (UberHandoffCard/ActionCard/pendingCard) — was the lone sharp-edged Rectangle.
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.5))
    }
}

#Preview {
    ScrollView {
        VStack(spacing: 4) {
            MessageBubble(message: Message(role: .user, content: "Book me an Uber to Kings Cross"))
            MessageBubble(message: Message(
                role: .assistant,
                content: "On it! Opening Uber for you.",
                actions: [ActionResult(
                    action: "book_uber",
                    success: true,
                    text: "Opening Uber to Kings Cross",
                    deepLink: "uber://?action=setPickup",
                    webLink: "https://m.uber.com/ul/"
                )]
            ))
            MessageBubble(message: Message(role: .assistant, content: "", isStreaming: true))
        }
    }
    .background(Color.appObsidian)
}
