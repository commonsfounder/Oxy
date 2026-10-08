import SwiftUI

// MARK: - Reply quoting

/// A reply carries its quote as the first line of the message, so it survives history reloads,
/// reads naturally to Adam, and looks sensible in Telegram without any server change.
enum ReplyQuote {
    static let marker = "↩︎ "

    static func compose(quoting message: Message, body: String) -> String {
        let who = message.role == .user ? "You" : "Adam"
        return "\(marker)\(who): \(snippet(of: message.content))\n\n\(body)"
    }

    static func snippet(of content: String) -> String {
        let plain = (split(content)?.body ?? content)
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return plain.count > 80 ? String(plain.prefix(80)) + "…" : plain
    }

    static func split(_ content: String) -> (who: String, snippet: String, body: String)? {
        guard content.hasPrefix(marker), let end = content.range(of: "\n\n") else { return nil }
        let head = content[content.index(content.startIndex, offsetBy: marker.count)..<end.lowerBound]
        guard let colon = head.firstIndex(of: ":") else { return nil }
        let who = String(head[head.startIndex..<colon])
        let snippet = String(head[head.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        let body = String(content[end.upperBound...])
        return (who, snippet, body)
    }
}

// MARK: - Reactions

/// A tapped reaction travels to Adam as a message in this exact shape (matched on the server by
/// api/services/reactions.js). Neither it nor a "[quiet]" reply is ever drawn in the thread.
enum ReactionText {
    static let quietReply = "[quiet]"

    static func message(_ emoji: String, on message: Message) -> String {
        let quoted = ReplyQuote.snippet(of: message.content).replacingOccurrences(of: "”", with: "\"")
        return "Reacted \(emoji) to “\(quoted)”"
    }

    static func isReaction(_ content: String) -> Bool {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.hasPrefix("Reacted ") && text.contains(" to “") && text.hasSuffix("”")
    }

    /// The emoji when Adam answered with a reaction instead of words: exactly `[react:EMOJI]`.
    static func agentReaction(_ content: String) -> String? {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("[react:"), text.hasSuffix("]") else { return nil }
        let emoji = String(text.dropFirst(7).dropLast())
        return !emoji.isEmpty && emoji.count <= 4 && !emoji.contains(" ") ? emoji : nil
    }

    /// True while a reaction is still arriving ("[re", "[react:👍"), so half a marker never flashes in a bubble.
    static func isAgentReactionInProgress(_ content: String) -> Bool {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty, text.count < 24 else { return false }
        if "[react:".hasPrefix(text) { return true }
        return text.hasPrefix("[react:") && !text.contains("]")
    }

    /// A reaction only stands in for words on a short, plain message. Anything that asked something is
    /// shown as the emoji on its own so the user is never left without an answer.
    static func canReact(to userContent: String) -> Bool {
        let text = (ReplyQuote.split(userContent)?.body ?? userContent).trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.contains("?") && text.split(whereSeparator: { $0.isWhitespace }).count <= 12
    }

    /// True for a quiet reply, including while it is still streaming in.
    static func isQuiet(_ content: String) -> Bool {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !text.isEmpty && quietReply.hasPrefix(text) || text == quietReply
    }
}

/// One emoji per message, kept on this phone. A message that has not been saved yet is recorded
/// by what it says and when, then matched to its saved copy the next time history loads.
@MainActor
@Observable
final class ReactionStore {
    static let shared = ReactionStore()
    static let choices = ["❤️", "👍", "👎", "😂", "‼️", "❓"]
    static let more = [
        "🔥", "🙏", "👏", "🎉", "😍", "🥰", "😊", "😅", "🤣", "😭", "🥲", "😮",
        "😬", "🙄", "😴", "🤔", "🫡", "😎", "🤝", "💯", "✅", "❌", "👀", "💀",
        "🙌", "💪", "🫶", "😤", "🤯", "🥳", "😢", "😡", "🤷", "🫠", "⭐️", "💡"
    ]

    private struct Pending: Codable {
        var key: String
        var role: String
        var content: String
        var at: Date
    }

    private(set) var reactions: [String: String]
    private var pending: [Pending]

    private init() {
        let defaults = UserDefaults.standard
        reactions = (defaults.dictionary(forKey: "adam_reactions") as? [String: String]) ?? [:]
        pending = (defaults.data(forKey: "adam_reactions_pending"))
            .flatMap { try? JSONDecoder().decode([Pending].self, from: $0) } ?? []
    }

    private func key(for message: Message) -> String {
        message.dbId ?? "local-\(message.id.uuidString)"
    }

    func reaction(for message: Message) -> String? {
        reactions[key(for: message)]
    }

    /// Tapping the same emoji again removes it, like a tapback. Returns true when a reaction was added.
    @discardableResult
    func toggle(_ emoji: String, on message: Message) -> Bool {
        let id = key(for: message)
        let added = reactions[id] != emoji
        if !added {
            reactions[id] = nil
            pending.removeAll { $0.key == id }
        } else {
            reactions[id] = emoji
            if message.dbId == nil {
                pending.removeAll { $0.key == id }
                pending.append(Pending(key: id, role: message.role.rawValue,
                                       content: String(message.content.prefix(120)), at: message.timestamp))
            }
        }
        save()
        return added
    }

    func migrate(with messages: [Message]) {
        guard !pending.isEmpty else { return }
        var changed = false
        for item in pending {
            guard let dbId = savedID(matching: item, in: messages) else { continue }
            if let emoji = reactions.removeValue(forKey: item.key) { reactions[dbId] = emoji }
            pending.removeAll { $0.key == item.key }
            changed = true
        }
        if changed { save() }
    }

    private func savedID(matching item: Pending, in messages: [Message]) -> String? {
        for message in messages {
            guard let dbId = message.dbId, message.role.rawValue == item.role else { continue }
            guard String(message.content.prefix(120)) == item.content else { continue }
            if abs(message.timestamp.timeIntervalSince(item.at)) < 180 { return dbId }
        }
        return nil
    }

    private func save() {
        let defaults = UserDefaults.standard
        defaults.set(reactions, forKey: "adam_reactions")
        defaults.set(try? JSONEncoder().encode(pending), forKey: "adam_reactions_pending")
    }
}

// MARK: - The row that wraps every message

/// Adds swipe-to-reply, press-and-hold for reactions, and the reaction badge to a message.
struct ThreadMessageRow<Content: View>: View {
    let message: Message
    var reaction: String?
    var onReply: () -> Void
    var onHold: (CGRect) -> Void
    @ViewBuilder var content: Content

    @State private var dx: CGFloat = 0
    @State private var crossed = false
    @State private var frame: CGRect = .zero

    private var isUser: Bool { message.role == .user }
    private let trigger: CGFloat = 46

    var body: some View {
        content
            .padding(.top, reaction == nil ? 0 : 8)
            .animation(.appSpring, value: reaction)
            .offset(x: dx)
            .background(alignment: .leading) {
                ReplyArrow()
                    .stroke(Color.appMuted, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .frame(width: 18, height: 16)
                    .scaleEffect(0.6 + 0.4 * min(dx / trigger, 1))
                    .opacity(Double(min(dx / trigger, 1)))
                    .padding(.leading, AppSpacing.chatMargin)
                    .accessibilityHidden(true)
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
            .simultaneousGesture(
                DragGesture(minimumDistance: 18)
                    .onChanged { value in
                        guard value.translation.width > 0,
                              value.translation.width > abs(value.translation.height) * 1.4 else { return }
                        dx = min(value.translation.width * 0.55, 78)
                        if dx >= trigger, !crossed {
                            crossed = true
                            HapticManager.shared.impact(.light)
                        }
                    }
                    .onEnded { _ in
                        let fire = dx >= trigger
                        crossed = false
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.8)) { dx = 0 }
                        if fire { onReply() }
                    }
            )
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.35).onEnded { _ in
                    HapticManager.shared.impact(.medium)
                    onHold(frame)
                }
            )
            .accessibilityAction(named: "Reply") { onReply() }
    }
}

private struct ReplyArrow: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.42, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.42))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.42, y: rect.minY + rect.height * 0.84))
        path.move(to: CGPoint(x: rect.minX + 1, y: rect.minY + rect.height * 0.42))
        path.addCurve(
            to: CGPoint(x: rect.maxX, y: rect.maxY),
            control1: CGPoint(x: rect.maxX * 0.75, y: rect.minY + rect.height * 0.42),
            control2: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.62)
        )
        return path
    }
}

// MARK: - Reaction picker

/// Shown when a message is held: six reactions, then Reply and Copy.
struct ReactionPicker: View {
    let message: Message
    let anchor: CGRect
    let current: String?
    var onReact: (String) -> Void
    var onReply: () -> Void
    var onCopy: () -> Void
    var onShowOnDisplay: (() -> Void)?
    var onClose: () -> Void

    @State private var shown = false
    @State private var showsMore = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isUser: Bool { message.role == .user }

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            let top = max(anchor.minY - origin.y - 118, 56)
            ZStack(alignment: .topLeading) {
                Color.appBackground.opacity(0.86)
                    .ignoresSafeArea()
                    .onTapGesture(perform: onClose)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Close")

                MessageBubble(message: message, showsTypingIndicator: false, isGroupStart: true,
                              isGroupEnd: true, showsTimestamp: false)
                    .frame(width: anchor.width)
                    .offset(x: anchor.minX - origin.x, y: anchor.minY - origin.y)
                    .allowsHitTesting(false)

                VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
                    HStack(spacing: 2) {
                        ForEach(ReactionStore.choices, id: \.self) { emoji in
                            Button { onReact(emoji) } label: {
                                Text(emoji)
                                    .font(.appBody(26))
                                    .frame(width: 44, height: 44)
                                    .background(Circle().fill(current == emoji ? Color.appReceivedBubble : Color.clear))
                            }
                            .buttonStyle(.appScale(0.85))
                            .accessibilityLabel("React \(emoji)")
                        }
                        Button {
                            HapticManager.shared.impact(.light)
                            withAnimation(.appSpring) { showsMore.toggle() }
                        } label: {
                            AppIcon(showsMore ? "xmark" : "plus", size: 16)
                                .foregroundColor(Color.appInk)
                                .frame(width: 44, height: 44)
                                .background(Circle().fill(Color.appReceivedBubble))
                        }
                        .buttonStyle(.appScale(0.85))
                        .accessibilityLabel(showsMore ? "Fewer reactions" : "More reactions")
                    }
                    .padding(6)
                    .background(Capsule().fill(Color.appBackground))
                    .overlay(Capsule().strokeBorder(Color.appCardOutline, lineWidth: 1))

                    if showsMore {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 6), spacing: 2) {
                            ForEach(ReactionStore.more, id: \.self) { emoji in
                                Button { onReact(emoji) } label: {
                                    Text(emoji)
                                        .font(.system(size: 26))
                                        .frame(width: 44, height: 44)
                                        .background(Circle().fill(current == emoji ? Color.appReceivedBubble : Color.clear))
                                }
                                .buttonStyle(.appScale(0.85))
                                .accessibilityLabel("React \(emoji)")
                            }
                        }
                        .padding(10)
                        .frame(width: 300)
                        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.appBackground))
                        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.appCardOutline, lineWidth: 1))
                        .transition(.scale(scale: 0.9, anchor: isUser ? .topTrailing : .topLeading).combined(with: .opacity))
                    }

                    if !showsMore {
                        HStack(spacing: 8) {
                            menuPill("Reply", action: onReply)
                            menuPill("Copy", action: onCopy)
                            if let onShowOnDisplay, !isUser {
                                menuPill("Show on display", action: onShowOnDisplay)
                            }
                        }
                        .transition(.opacity)
                    }
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
                .offset(y: showsMore ? max(56, min(top, proxy.size.height - 420)) : top)
                .animation(.appSpring, value: showsMore)
                .scaleEffect(shown || reduceMotion ? 1 : 0.7, anchor: isUser ? .bottomTrailing : .bottomLeading)
                .opacity(shown || reduceMotion ? 1 : 0)
            }
        }
        .onAppear {
            if reduceMotion { shown = true; return }
            withAnimation(.spring(response: 0.36, dampingFraction: 0.72)) { shown = true }
        }
    }

    private func menuPill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(Color.appInk)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(Capsule().fill(Color.appBackground))
                .overlay(Capsule().strokeBorder(Color.appCardOutline, lineWidth: 1))
        }
        .buttonStyle(.appScale(0.95))
    }
}

// MARK: - Reply preview above the ask bar

struct ReplyPreviewBar: View {
    let message: Message
    var onClose: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Replying to \(message.role == .user ? "yourself" : "Adam")")
                    .font(.appBody(12, weight: .medium))
                    .foregroundStyle(Color.appMuted)
                Text(ReplyQuote.snippet(of: message.content))
                    .font(.appBody(14))
                    .foregroundStyle(Color.appInk)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                AppIcon("xmark", size: 13)
                    .foregroundColor(Color.appMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.appScale)
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, 16)
        .padding(.trailing, 2)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appReceivedBubble))
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

// MARK: - Working

/// Text with a slow highlight sweeping across it.
struct ShimmerText: View {
    let text: String
    var font: Font = .appBody(14)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let phase = reduceMotion ? 1.0 : (t / 1.8).truncatingRemainder(dividingBy: 1) * 2
            Text(text)
                .font(font)
                .foregroundStyle(LinearGradient(
                    stops: [
                        .init(color: Color.appMuted, location: 0),
                        .init(color: Color.appInk, location: 0.5),
                        .init(color: Color.appMuted, location: 1)
                    ],
                    startPoint: UnitPoint(x: phase - 1, y: 0),
                    endPoint: UnitPoint(x: phase, y: 0)
                ))
        }
    }
}

/// Shown while Adam works on a reply, as the dot at the left of the step being worked on, with no
/// bubble behind it. Only a real step is ever named; otherwise it is just the dot.
struct WorkingBubble: View {
    var label: String? = nil

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 10) {
                AdamActivityMark(state: .working, size: 28)
                if let label {
                    ShimmerText(text: label)
                        .lineLimit(1)
                        .id(label)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .animation(.appSpring, value: label)
            .padding(.vertical, 9)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, AppSpacing.chatMargin)
        .transition(.asymmetric(
            insertion: .scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity),
            removal: .opacity
        ))
        .onAppear { HapticManager.shared.impact(.soft) }
        .onChange(of: label) { _, new in
            if new != nil { HapticManager.shared.select() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.map { "Adam is working: \($0)" } ?? "Adam is working")
    }
}

/// The reaction badge, pinned to the corner of the bubble itself.
struct ReactionBadge: View {
    let emoji: String

    var body: some View {
        Text(emoji)
            .font(.appBody(15))
            .frame(width: 28, height: 28)
            .background(Circle().fill(Color.appBackground))
            .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Reacted \(emoji)")
    }
}
