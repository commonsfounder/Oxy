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
    var onRetryFailedTurn: (() -> Void)? = nil

    @State private var showReauthSheet = false

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
    private var browserRecoveryAction: ActionResult? {
        completedActions.first {
            !$0.success &&
            $0.recoveryAction?.type == "continue_browser_task" &&
            $0.recoveryAction?.autoContinue != true
        }
    }

    /// A task hit a login wall it can't get past on its own — offers a sign-in sheet that
    /// posts straight to POST /browser-task/reauth-login instead of resending chat text
    /// (which would just re-hit the same wall; see api/index.js's `reauth` case).
    private var reauthAction: ActionResult? {
        completedActions.first { !$0.success && $0.recoveryAction?.type == "reauth_login" }
    }

    /// A ride booking gets a dedicated native handoff card; suppress the
    /// assistant's "Opening Uber…" chat text so the card stands alone.
    private var uberAction: ActionResult? {
        message.actions.first { $0.action == "book_uber" && !$0.pending }
    }

    /// Deduped product photos across every completed action in this turn (currently
    /// only run_browser_task populates these).
    private var productImageUrls: [String] {
        guard !isUser else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for action in completedActions {
            for url in action.imageUrls ?? [] where seen.insert(url).inserted {
                out.append(url)
            }
        }
        return out
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
                    VStack(alignment: .trailing, spacing: 4) {
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
                        if message.queuedForActiveTask {
                            Text("Queued for this task")
                                .font(.appBody(11.5, weight: .medium))
                                .foregroundStyle(Color.appMuted)
                                .padding(.trailing, 2)
                        }
                    }
                } else {
                    AssistantAnswerView(text: message.content, compact: isCompact, isStreaming: message.isStreaming)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if let turnError = message.turnError {
                FailedTurnView(message: turnError, onRetry: onRetryFailedTurn)
                    .padding(.top, message.content.isEmpty ? 0 : 8)
            }

            // Real product photos the browser-task agent found (og:image, or the largest
            // visible <img>) — previously this capability didn't exist, so the agent could
            // only ever describe what it saw in words.
            if !productImageUrls.isEmpty {
                ProductImageRow(urls: productImageUrls)
                    .padding(.top, message.content.isEmpty ? 0 : 8)
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
                            DirectionsResultCard(action: action)
                        }
                    }

                    if !receiptActions.isEmpty {
                        TurnReceiptRow(actions: receiptActions) { action in
                            onOpenAction?(action)
                        }
                    }

                    if let recovery = browserRecoveryAction,
                       let command = recovery.recoveryAction?.message ?? recovery.recoveryAction?.label {
                        Button {
                            onActionCommand?(command)
                        } label: {
                            HStack(spacing: 8) {
                                AppIcon(sf: "arrow.clockwise", size: 14)
                                Text(recovery.recoveryAction?.label ?? "Keep going")
                                    .font(.appBody(13, weight: .semibold))
                            }
                            .foregroundStyle(Color.appAccent)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.appSurface.opacity(0.84))
                            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                                    .strokeBorder(Color.appHairline, lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(recovery.recoveryAction?.label ?? "Keep going")
                    }

                    if let reauth = reauthAction, let site = reauth.recoveryAction?.site {
                        Button {
                            showReauthSheet = true
                        } label: {
                            HStack(spacing: 8) {
                                AppIcon(sf: "person.crop.circle", size: 14)
                                Text(reauth.recoveryAction?.label ?? "Sign in")
                                    .font(.appBody(13, weight: .semibold))
                            }
                            .foregroundStyle(Color.appAccent)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.appSurface.opacity(0.84))
                            .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                                    .strokeBorder(Color.appHairline, lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(reauth.recoveryAction?.label ?? "Sign in")
                        .sheet(isPresented: $showReauthSheet) {
                            ReauthLoginSheet(site: site) {
                                onActionCommand?("keep going")
                            }
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
        var source = text.normalizingChatBullets
            .replacingOccurrences(
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
            .removingMarkdownTables
            .replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?m)^\s*---+\s*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`~]{1,3}"#, with: "", options: .regularExpression)
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

    var removingMarkdownTables: String {
        let lines = components(separatedBy: "\n")
        var output: [String] = []
        var index = 0
        while index < lines.count {
            if index + 1 < lines.count,
               lines[index].isMarkdownTableRow,
               lines[index + 1].isMarkdownTableDivider {
                index += 2
                while index < lines.count, lines[index].isMarkdownTableRow {
                    index += 1
                }
                continue
            }
            output.append(lines[index])
            index += 1
        }
        return output.joined(separator: "\n")
    }
}

private struct AssistantAnswerView: View {
    let text: String
    let compact: Bool
    var isStreaming = false

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
                        .foregroundStyle(Color.appInk.opacity(isStreaming ? 0.9 : 0.96))
                        .lineSpacing(compact ? 4 : 5.5)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                case .heading(let text):
                    Text(text.strippingMarkdown)
                        .font(.appBody(compact ? 15 : 16, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .padding(.top, compact ? 5 : 8)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                case .bullet(let text):
                    AssistantListRow(marker: "•", text: text, compact: compact)

                case .numbered(let index, let text):
                    AssistantListRow(marker: "\(index)", text: text, compact: compact)

                case .divider:
                    Rectangle()
                        .fill(Color.appHairline)
                        .frame(height: 0.5)
                        .padding(.vertical, compact ? 4 : 6)

                case .codeBlock(let code):
                    AssistantCodeBlock(code: code, compact: compact)

                case .table(let table):
                    AssistantTableView(table: table, compact: compact)
                }
            }
        }
        .animation(isStreaming ? nil : .appStandard, value: blocks.count)
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
    case divider
    case codeBlock(String)
    case table(MarkdownTable)

    static func parse(_ raw: String) -> [AssistantTextBlock] {
        let normalized = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n\n\n+", with: "\n\n", options: .regularExpression)
        let lines = normalized.components(separatedBy: "\n")
        var blocks: [AssistantTextBlock] = []
        var paragraph: [String] = []
        var index = 0

        func flushParagraph() {
            let joined = paragraph
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(.paragraph(joined))
            }
            paragraph.removeAll()
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else {
                flushParagraph()
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                flushParagraph()
                var codeLines: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
                continue
            }

            if index + 1 < lines.count,
               lines[index].isMarkdownTableRow,
               lines[index + 1].isMarkdownTableDivider,
               let table = MarkdownTable.parse(from: lines, start: index) {
                flushParagraph()
                blocks.append(.table(table.value))
                index = table.nextIndex
                continue
            }

            if trimmed.range(of: #"^[-*_]{3,}$"#, options: .regularExpression) != nil {
                flushParagraph()
                blocks.append(.divider)
            } else if let match = trimmed.firstMatch(of: #"^#{1,4}\s+(.+)$"#) {
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
            index += 1
        }
        flushParagraph()
        return blocks.isEmpty ? [.paragraph(raw)] : blocks
    }
}

private struct MarkdownTable {
    let headers: [String]
    let rows: [[String]]

    static func parse(from lines: [String], start: Int) -> (value: MarkdownTable, nextIndex: Int)? {
        guard start + 1 < lines.count,
              lines[start].isMarkdownTableRow,
              lines[start + 1].isMarkdownTableDivider else { return nil }
        let headers = cells(in: lines[start])
        guard !headers.isEmpty else { return nil }
        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count, lines[index].isMarkdownTableRow {
            let row = cells(in: lines[index])
            if !row.isEmpty { rows.append(row) }
            index += 1
        }
        return (MarkdownTable(headers: headers, rows: rows), index)
    }

    private static func cells(in line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}

private struct AssistantTableView: View {
    let table: MarkdownTable
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, value in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(header(for: column))
                                .font(.appBody(compact ? 11.5 : 12, weight: .semibold))
                                .foregroundStyle(Color.appMuted)
                                .frame(width: compact ? 82 : 96, alignment: .leading)
                            Text(.chatMarkdown(value))
                                .font(.appBody(compact ? 13.5 : 14.5))
                                .foregroundStyle(Color.appInk.opacity(0.95))
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color.appSurface.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                        .strokeBorder(Color.appHairline, lineWidth: 0.5)
                )
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func header(for index: Int) -> String {
        guard index < table.headers.count else { return "Column \(index + 1)" }
        return table.headers[index].strippingMarkdown
    }
}

private struct AssistantCodeBlock: View {
    let code: String
    let compact: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(code)
                .font(.appMono(compact ? 12 : 12.5))
                .foregroundStyle(Color.appInk)
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
    }
}

private struct FailedTurnView: View {
    let message: String
    var onRetry: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            AppIcon(sf: "exclamationmark.circle", size: 15)
                .foregroundStyle(Color.appWarning)
            Text(message)
                .font(.appBody(13.5))
                .foregroundStyle(Color.appInk.opacity(0.95))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let onRetry {
                Button("Retry", action: onRetry)
                    .font(.appBody(13, weight: .semibold))
                    .foregroundStyle(Color.appAccent)
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.appSurface.opacity(0.78))
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
    }
}

/// Horizontally-scrolling row of product photos the browser-task agent found on the
/// page it finished on. Thumbnails, not a gallery — tap-to-zoom isn't wired up yet.
private struct ProductImageRow: View {
    let urls: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(urls, id: \.self) { urlString in
                    if let url = URL(string: urlString) {
                        // The load is async and unpredictable in timing — without a
                        // transition the placeholder plate hard-cuts to the photo the
                        // instant it arrives. Fading it in bridges that jump.
                        AsyncImage(url: url, transaction: Transaction(animation: .appFast)) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFill().transition(.opacity)
                            default:
                                Color.appSurface2
                            }
                        }
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                                .strokeBorder(Color.appHairline, lineWidth: 0.5)
                        )
                    }
                }
            }
        }
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

    var isMarkdownTableRow: Bool {
        let trimmed = trimmingCharacters(in: .whitespaces)
        return trimmed.contains("|") && trimmed.filter { $0 == "|" }.count >= 2
    }

    var isMarkdownTableDivider: Bool {
        let trimmed = trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("|") else { return false }
        let cells = trimmed
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        return !cells.isEmpty && cells.allSatisfy { cell in
            cell.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil
        }
    }
}

// MARK: - Directions Result

private struct DirectionsResultCard: View {
    let action: ActionResult

    private var legs: [TravelLeg] { action.itinerary ?? [] }
    private var isDriving: Bool {
        let mode = action.routeContext?.mode?.lowercased() ?? ""
        return mode.contains("driv") || (!legs.contains { ($0.type ?? "").lowercased().contains("rail") || ($0.type ?? "").lowercased().contains("transit") } && (action.deepLink != nil || action.webLink != nil))
    }
    private var title: String {
        if isDriving { return action.routeContext?.destination ?? destinationFromText ?? "Destination" }
        return action.routeContext?.destination ?? "Journey"
    }
    private var duration: String? {
        action.routeContext?.duration ?? firstMatch(#"(\d+\s*(?:h|hr|hrs|hour|hours|min|mins|minutes)(?:\s+\d+\s*(?:min|mins|minutes))?)"#, in: action.headline ?? action.cardText ?? action.text ?? "")
    }
    private var price: String? {
        firstMatch(#"[£$€]\s?\d+(?:\.\d{1,2})?"#, in: action.cardText ?? action.text ?? "")
    }
    private var timeRange: String? {
        if let departure = action.routeContext?.departure, let arrival = action.routeContext?.arrival {
            return "\(departure)-\(arrival)"
        }
        return firstMatch(#"\b\d{1,2}:\d{2}\s?(?:am|pm)?\s*[-–]\s*\d{1,2}:\d{2}\s?(?:am|pm)?\b"#, in: action.headline ?? "")
    }
    private var destinationFromText: String? {
        guard let text = action.text else { return nil }
        return firstMatch(#"(?i)(?:directions to|to arrive by .*? to|by driving to)\s+([^\.]+)"#, in: text)
    }
    private var mapsUrl: String? { action.deepLink ?? action.webLink }
    private var fareUrl: String? { action.bookingUrl ?? action.webLink }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ToolHeader(
                icon: isDriving ? "car" : "train.side.front.car",
                eyebrow: isDriving ? "DIRECTIONS" : "JOURNEY",
                state: action.success ? .success : .failure
            )

            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.appBody(15, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let duration {
                        metric("Duration", duration)
                    }
                    if isDriving, let distance = action.distanceText ?? action.routeContext?.distance {
                        metric("Distance", distance)
                    }
                    if !isDriving, let price {
                        metric("Price", price)
                    }
                    if !isDriving, let timeRange {
                        metric("Time", timeRange)
                    }
                }
            }

            if !isDriving, !legs.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(legs.prefix(5)) { leg in
                        JourneyLegRow(leg: leg)
                    }
                }
                .padding(.top, 2)
            } else if let summary = action.cardText?.strippingMarkdown, !summary.isEmpty {
                Text(summary)
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(3)
            }

            HStack(spacing: 8) {
                if mapsUrl != nil {
                    directionButton("Open in Maps", systemImage: "map", urlString: mapsUrl)
                }
                if !isDriving, !legs.isEmpty {
                    directionButton("View journey", systemImage: "list.bullet", urlString: mapsUrl ?? fareUrl)
                }
                if !isDriving, fareUrl != nil {
                    directionButton(price == nil ? "Check fares" : "Buy ticket", systemImage: "ticket", urlString: fareUrl)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface.opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.5))
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .appEyebrow()
                .foregroundStyle(Color.appMuted.opacity(0.8))
            Text(value)
                .font(.appBody(12.5, weight: .medium))
                .foregroundStyle(Color.appInk.opacity(0.94))
                .lineLimit(1)
        }
    }

    private func directionButton(_ label: String, systemImage: String, urlString: String?) -> some View {
        Button {
            guard let urlString, let url = URL(string: urlString) else { return }
            UIApplication.shared.open(url)
        } label: {
            HStack(spacing: 5) {
                AppIcon(sf: systemImage, size: 13)
                Text(label)
                    .font(.appBody(12.5, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.appTitanium)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                    .strokeBorder(Color.appHairline, lineWidth: 0.5)
            )
        }
        .buttonStyle(.appScale(0.98))
        .disabled(urlString == nil)
    }

    private func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else { return nil }
        let target = match.numberOfRanges > 1 && match.range(at: 1).location != NSNotFound
            ? match.range(at: 1) : match.range
        guard let r = Range(target, in: text) else { return nil }
        return String(text[r]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct JourneyLegRow: View {
    let leg: TravelLeg

    private var fromTo: String {
        [leg.from, leg.to].compactMap { value -> String? in
            guard let value else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }.joined(separator: " → ")
    }

    private var detail: String {
        let service = leg.service ?? leg.line ?? transportLabel
        let duration = leg.duration
        return [service, duration].compactMap { $0 }.joined(separator: " · ")
    }

    private var transportLabel: String {
        let type = (leg.type ?? "").lowercased()
        if type.contains("rail") { return "Train" }
        if type.contains("bus") { return "Bus" }
        return "Transit"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(Color.appMuted.opacity(0.55))
                .frame(width: 5, height: 5)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(fromTo.isEmpty ? transportLabel : fromTo)
                    .font(.appBody(13.5, weight: .medium))
                    .foregroundStyle(Color.appInk.opacity(0.95))
                    .lineLimit(2)
                Text(detail)
                    .font(.appBody(12.5))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }
        }
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
                            AppIcon(sf: "arrow.up.right", size: 10)
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
                AppIcon(sf: "checkmark", size: 13)
                    .foregroundStyle(Color.appSuccess)
            case .failure:
                AppIcon(sf: "exclamationmark", size: 13)
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
            AppIcon(sf: icon, size: 13)
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
                        AppIcon(sf: "car", size: 14)
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
