import SwiftUI

struct MessageBubble: View {
    let message: Message
    var showsTypingIndicator: Bool = true
    /// True when this message is the first in a run from the same sender.
    var isGroupStart: Bool = true
    /// True when this message is the last in a run from the same sender.
    var isGroupEnd: Bool = true
    var onActionCommand: ((String) -> Void)? = nil
    var onOpenAction: ((ActionResult) -> Void)? = nil

    private var isUser: Bool { message.role == .user }
    private var bubbleStyle: String {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings"),
              let settings = try? JSONDecoder().decode(OxySettings.self, from: data) else {
            return "comfort"
        }
        return settings.bubbleStyle
    }
    private var isCompact: Bool { bubbleStyle == "compact" }
    private var visibleActions: [ActionResult] {
        message.actions.filter { action in
            !action.pending &&
            !(action.action == "send_message" && action.success)
        }
    }

    /// A ride booking gets a dedicated native handoff card; suppress the
    /// assistant's "Opening Uber…" chat text so the card stands alone.
    private var uberAction: ActionResult? {
        message.actions.first { $0.action == "book_uber" && !$0.pending }
    }

    // Outer corners (trailing edge) stay fully round; inner corners (leading edge)
    // tighten when this message is adjacent to another in the same run.
    private var userBubbleShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: isGroupStart ? NMLRadius.bubble : NMLRadius.sm,
            bottomLeadingRadius: isGroupEnd  ? NMLRadius.bubble : NMLRadius.sm,
            bottomTrailingRadius: NMLRadius.bubble,
            topTrailingRadius: NMLRadius.bubble,
            style: .continuous
        )
    }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: isCompact ? 2 : 4) {
            // Message content
            if !message.content.isEmpty && uberAction == nil {
                HStack(alignment: .bottom, spacing: 0) {
                    if isUser { Spacer(minLength: 64) }

                    Group {
                        if message.isStreaming && !isUser {
                            StreamingWordText(
                                text: message.content,
                                fontSize: isCompact ? 14 : 15,
                                lineSpacing: isCompact ? 4 : 6
                            )
                        } else {
                            Text(message.content)
                                .font(.nmlBody(isCompact ? 14 : 15))
                                .foregroundStyle(Color.nmlInk)
                                .lineSpacing(isCompact ? 4 : 6)
                        }
                    }
                    .padding(.horizontal, isUser ? 15 : 0)
                    .padding(.vertical, isUser ? 11 : 0)
                    .background {
                        if isUser {
                            // Shaped bubble: more rounded toward the exterior of the run,
                            // gently squared where messages sit flush against each other.
                            userBubbleShape
                                .fill(Color.nmlFillBubble)
                        }
                    }

                    if !isUser { Spacer(minLength: 64) }
                }
            }

            // Streaming indicator
            if message.isStreaming && message.content.isEmpty && showsTypingIndicator {
                HStack {
                    OxyThinkingIndicator()
                        .padding(.vertical, 4)
                    Spacer(minLength: 64)
                }
            }

            // Action cards
            if !visibleActions.isEmpty {
                VStack(spacing: 6) {
                    ForEach(visibleActions) { action in
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
                        } else if ["get_directions", "plan_trip"].contains(action.action) && action.success {
                            if action.deepLink != nil || action.webLink != nil {
                                DirectionsLink(action: action)
                            }
                        } else {
                            ActionCard(action: action, onCommand: onActionCommand, onOpenAction: onOpenAction)
                        }
                    }
                }
                .padding(.top, 3)
            }

            // Sources
            if !isUser, !message.sources.isEmpty {
                MessageSourceChips(sources: message.sources)
                    .padding(.top, 8)
                    .padding(.trailing, 64)
            }

            // Timestamp — group-end only, very quiet
            if isGroupEnd {
                Text(message.timestamp, style: .time)
                    .font(.nmlBody(10))
                    .monospacedDigit()
                    .foregroundStyle(Color.nmlMuted.opacity(0.6))
                    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
                    .padding(.top, 1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, isCompact ? 1 : 2)
        .transition(.asymmetric(
            insertion: .opacity
                .combined(with: .move(edge: .bottom))
                .combined(with: .scale(scale: 0.97, anchor: isUser ? .bottomTrailing : .bottomLeading)),
            removal: .opacity
        ))
        .animation(.nmlSpring, value: message.content)
    }
}

private struct StreamingWordText: View {
    let text: String
    let fontSize: CGFloat
    let lineSpacing: CGFloat

    private var words: [String] {
        text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    }

    var body: some View {
        Text(attributedText)
            .font(.nmlBody(fontSize))
            .foregroundStyle(Color.nmlInk)
            .lineSpacing(lineSpacing)
            .animation(.nmlRelax, value: words.count)
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
            part.foregroundColor = Color.nmlInk.opacity(opacity)
            output += part
        }
        return output
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
                    .font(.nmlBody(13, weight: .light))
                    .foregroundStyle(Color.nmlTitanium)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.nmlMuted)
            }
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.nmlHairline).frame(height: 0.5)
            }
        }
        .buttonStyle(.nmlScale(0.98))
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
                    .nmlEyebrow()
                    .foregroundStyle(Color.nmlMuted)

                ForEach(sources) { source in
                    Button {
                        guard let url = URL(string: source.uri) else { return }
                        UIApplication.shared.open(url)
                    } label: {
                        HStack(spacing: 4) {
                            Text(source.title)
                                .font(.nmlBody(11))
                                .lineLimit(1)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 8, weight: .semibold))
                        }
                        .foregroundStyle(Color.nmlTitanium)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .overlay(Rectangle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))
                    }
                    .buttonStyle(.nmlScale)
                }
            }
        }
    }
}

// MARK: - Action Card

struct ActionCard: View {
    let action: ActionResult
    var onCommand: ((String) -> Void)? = nil
    var onOpenAction: ((ActionResult) -> Void)? = nil

    private var hasLink: Bool {
        action.deepLink != nil || action.webLink != nil
    }

    private var detailText: String? {
        guard let raw = action.cardText ?? action.text ?? action.error else { return nil }
        let compact = raw
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
        if !action.success && action.action == "book_uber" {
            if compact.localizedCaseInsensitiveContains("need your current location") ||
                compact.localizedCaseInsensitiveContains("enable location") {
                return "Enable location and try again."
            }
            if compact.localizedCaseInsensitiveContains("places api") ||
                compact.localizedCaseInsensitiveContains("google places is not ready") {
                return "Nearby place ranking needs Google Places."
            }
            if compact.localizedCaseInsensitiveContains("nearby match") ||
                compact.localizedCaseInsensitiveContains("couldn't find a nearby") ||
                compact.localizedCaseInsensitiveContains("geocoding error") ||
                compact.localizedCaseInsensitiveContains("no results found") {
                return "Try a different place name or enable location."
            }
        }
        return compact
    }

    var body: some View {
        if action.pending {
            pendingCard
        } else {
            Button(action: openLink) {
                confirmationRow
            }
            .buttonStyle(.nmlScale(0.98))
            .disabled(!hasLink)
        }
    }

    /// A completed action, rendered as a quiet receipt line — a status mark, a
    /// confident Title Case confirmation, optional detail, and an Open affordance
    /// when there's somewhere to go. Flat (a single hairline), never a boxed card.
    private var confirmationRow: some View {
        HStack(alignment: .top, spacing: 12) {
            statusGlyph

            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .font(.nmlBody(14))
                    .foregroundStyle(action.success ? Color.nmlInk : Color.nmlDanger)
                if let detail = detailText {
                    Text(detail)
                        .font(.nmlBody(13, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 8)

            if hasLink {
                HStack(spacing: 3) {
                    Text("Open")
                        .font(.nmlBody(13))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(Color.nmlTitanium)
            }
        }
        .padding(.vertical, 15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.nmlHairline).frame(height: 0.5)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var statusGlyph: some View {
        Image(systemName: action.success ? "checkmark" : "exclamationmark")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(action.success ? Color.nmlGlow : Color.nmlDanger)
            .frame(width: 16, height: 19, alignment: .center)
    }

    /// Title Case confirmation copy, e.g. "Email Sent", "Place Found".
    private var headline: String {
        actionSummary.capitalized
    }

    /// A high-risk action awaiting the user's confirmation keeps a bordered
    /// surface — it's a decision to make, not a receipt, so it should hold the eye.
    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(headline)
                    .font(.nmlBody(14))
                    .foregroundStyle(Color.nmlInk)
                if let detail = detailText {
                    Text(detail)
                        .font(.nmlBody(13, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if let onCommand {
                HStack(spacing: 0) {
                    pendingButton("Confirm") { onCommand("confirm") }
                    pendingButton("Cancel", muted: true) { onCommand("cancel") }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nmlObsidian)
        .overlay(Rectangle().strokeBorder(Color.nmlCardBorder, lineWidth: 0.5))
    }

    private func pendingButton(_ label: String, muted: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.nmlBody(13, weight: .medium))
                .foregroundStyle(muted ? Color.nmlMuted : Color.nmlInk)
                .frame(maxWidth: .infinity)
                .frame(height: 42)
                .overlay(Rectangle().strokeBorder(Color.nmlCardBorder, lineWidth: 0.5))
        }
        .buttonStyle(.nmlScale)
    }

    private func openLink() {
        guard !action.pending else { return }
        if let onOpenAction {
            onOpenAction(action)
            return
        }
        if let link = action.deepLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        } else if let link = action.webLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        }
    }

    private func humanize(_ type: String) -> String {
        type.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private var actionSummary: String {
        if let summary = action.actionSummary, !summary.isEmpty { return summary }
        switch action.action {
        case "send_email": return action.success ? "Email sent" : "Email failed"
        case "send_message": return action.success ? "Message ready" : "Message failed"
        case "send_telegram": return action.success ? "Telegram sent" : "Telegram failed"
        case "book_uber": return action.success ? "Uber opened" : "Uber needs attention"
        case "find_place": return action.success ? "Place found" : "Place search failed"
        case "get_directions": return action.success ? "Directions ready" : "Directions failed"
        case "plan_trip": return action.success ? "Trip planned" : "Trip failed"
        case "station_board": return action.success ? "Station board ready" : "Station board failed"
        case "open_app": return action.success ? "App opened" : "App unavailable"
        case "play_music": return action.success ? "Music opened" : "Music failed"
        case "add_to_music_playlist": return action.success ? "Music added" : "Music add failed"
        case "create_reminder": return action.success ? "Reminder created" : "Reminder failed"
        case "create_calendar_event": return action.success ? "Calendar updated" : "Calendar failed"
        case "check_health": return action.success ? "Health checked" : "Health unavailable"
        default: return action.success ? "\(humanize(action.action)) done" : "\(humanize(action.action)) failed"
        }
    }

}

// MARK: - Uber Handoff Card

/// A native ride-booking transition card. Pure black with a 0.5px gray border,
/// minimalist left-aligned monospace readout (destination / ETA / estimate), and
/// a silent confirm indicator that animates on appear before the tap hands off
/// to the Uber deep link.
struct UberHandoffCard: View {
    let action: ActionResult
    var onOpen: () -> Void

    @State private var confirmed = false

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

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("RIDE · UBER")
                        .font(.nmlMono(11))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlMuted)
                    Spacer()
                    ConfirmTick(active: confirmed)
                }

                VStack(alignment: .leading, spacing: 6) {
                    handoffRow("DEST", destination)
                    handoffRow("ETA", eta == "—" ? "—" : "\(eta) MIN")
                    handoffRow("EST", estimate)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.nmlObsidian)
            .border(Color.nmlCardBorder, width: 0.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.nmlScale(0.98))
        .onAppear {
            withAnimation(.nmlRelax.delay(0.15)) { confirmed = true }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Ride to \(destination). Tap to open Uber.")
    }

    private func handoffRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.nmlMono(11))
                .foregroundStyle(Color.nmlMuted)
                .frame(width: 38, alignment: .leading)
            Text(value)
                .font(.nmlMono(11))
                .foregroundStyle(Color.nmlInk)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
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

/// A 1px silver ring that draws a check on appear — a quiet "confirmed" beat.
private struct ConfirmTick: View {
    let active: Bool

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
                .frame(width: 18, height: 18)
            CheckPath()
                .trim(from: 0, to: active ? 1 : 0)
                .stroke(Color.nmlTitanium, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
                .frame(width: 9, height: 7)
        }
        .frame(width: 18, height: 18)
    }
}

private struct CheckPath: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
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
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .light))
                    .foregroundStyle(Color.nmlTitanium)
                Text(eyebrow)
                    .font(.nmlMono(11))
                    .tracking(0.8)
                    .foregroundStyle(Color.nmlMuted)
                Spacer()
                if action.success {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.nmlTitanium)
                } else {
                    Image(systemName: "exclamationmark")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.nmlMuted)
                }
            }

            if let text = action.text, !text.isEmpty {
                Text(text)
                    .font(.nmlBody(13, weight: .light))
                    .foregroundStyle(action.success ? Color.nmlInk : Color.nmlMuted)
                    .lineLimit(6)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nmlSurface)
        .overlay(Rectangle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))
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
    .background(Color.nmlObsidian)
}
