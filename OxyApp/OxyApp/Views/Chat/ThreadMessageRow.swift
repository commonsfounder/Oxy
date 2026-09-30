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

/// One emoji per message, kept on this phone. A message that has not been saved yet is recorded
/// by what it says and when, then matched to its saved copy the next time history loads.
@MainActor
@Observable
final class ReactionStore {
    static let shared = ReactionStore()
    static let choices = ["❤️", "👍", "👎", "😂", "‼️", "❓"]

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

    /// Tapping the same emoji again removes it, like a tapback.
    func toggle(_ emoji: String, on message: Message) {
        let id = key(for: message)
        if reactions[id] == emoji {
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
            .overlay(alignment: isUser ? .topTrailing : .topLeading) {
                if let reaction {
                    Text(reaction)
                        .font(.appBody(15))
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Color.appBackground))
                        .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
                        .padding(.horizontal, isUser ? 6 : 10)
                        .offset(y: -12)
                        .transition(.scale.combined(with: .opacity))
                }
            }
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
                    }
                    .padding(6)
                    .background(Capsule().fill(Color.appBackground))
                    .overlay(Capsule().strokeBorder(Color.appCardOutline, lineWidth: 1))

                    HStack(spacing: 8) {
                        menuPill("Reply", action: onReply)
                        menuPill("Copy", action: onCopy)
                        if let onShowOnDisplay, !isUser {
                            menuPill("Show on display", action: onShowOnDisplay)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
                .offset(y: top)
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

/// Shown while Adam is working on a reply: the three channels of the Adam mark rise and fall
/// in a slow wave. No guessed step names — only what is true: Adam is on it.
struct WorkingBubble: View {
    /// A step the server actually reported ("Checking calendar"), or nil to show the bars alone.
    var label: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 10) {
            TimelineView(.animation(minimumInterval: nil, paused: reduceMotion)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(alignment: .center, spacing: 5) {
                    ForEach(0..<3, id: \.self) { index in
                        let phase = reduceMotion ? 0.5 : 0.5 + 0.5 * sin(t * 4.2 - Double(index) * 0.9)
                        Capsule()
                            .fill(Color.appWorking.opacity(0.55 + 0.45 * phase))
                            .frame(width: 5, height: 8 + 12 * phase)
                    }
                }
                .frame(width: 40, height: 22)
            }
                if let label {
                    Text(label)
                        .font(.appBody(14))
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                        .id(label)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .animation(.appSpring, value: label)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.appReceivedBubble))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, AppSpacing.chatMargin)
        .transition(.asymmetric(
            insertion: .scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity),
            removal: .opacity
        ))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.map { "Adam is working: \($0)" } ?? "Adam is working")
    }
}
