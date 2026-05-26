import SwiftUI

struct MessageBubble: View {
    let message: Message
    var showsTypingIndicator: Bool = true
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

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: isCompact ? 2 : 4) {
            // Message content
            if !message.content.isEmpty {
                HStack {
                    if isUser { Spacer(minLength: 60) }

                    VStack(alignment: .leading, spacing: 0) {
                        Text(message.content)
                            .font(.system(size: isCompact ? 14 : 15))
                            .foregroundStyle(isUser ? .white : Color.oxyText)
                            .lineSpacing(isCompact ? 2 : 4)
                    }
                    .padding(.horizontal, isCompact ? 13 : 16)
                    .padding(.vertical, isCompact ? 9 : 12)
                    .background(
                        isUser
                            ? AnyShapeStyle(
                                LinearGradient(
                                    colors: [Color.oxyStone, Color.oxyStone.opacity(0.85)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            : AnyShapeStyle(Color.oxySurface2)
                    )
                    .clipShape(
                        UnevenRoundedRectangle(
                            topLeadingRadius: isUser ? 20 : 6,
                            bottomLeadingRadius: isCompact ? 16 : 20,
                            bottomTrailingRadius: isUser ? 6 : (isCompact ? 16 : 20),
                            topTrailingRadius: isCompact ? 16 : 20
                        )
                    )

                    if !isUser { Spacer(minLength: 60) }
                }
            }

            // Streaming indicator
            if message.isStreaming && message.content.isEmpty && showsTypingIndicator {
                HStack {
                    TypingIndicator()
                        .padding(.horizontal, 16)
                        .padding(.vertical, isCompact ? 10 : 14)
                        .background(Color.oxySurface2)
                        .clipShape(
                            UnevenRoundedRectangle(
                                topLeadingRadius: 6,
                                bottomLeadingRadius: 20,
                                bottomTrailingRadius: 20,
                                topTrailingRadius: 20
                            )
                        )
                    Spacer(minLength: 60)
                }
            }

            // Action cards
            if !message.actions.isEmpty {
                VStack(spacing: 6) {
                    ForEach(message.actions) { action in
                        ActionCard(action: action, onCommand: onActionCommand, onOpenAction: onOpenAction)
                    }
                }
            }

            // Timestamp
            HStack(spacing: 4) {
                if isUser {
                    Spacer()
                    if !message.isStreaming {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color.oxyDim)
                    }
                }
                Text(message.timestamp, style: .time)
                    .font(.system(size: 10))
                    .foregroundStyle(Color.oxyDim)
                if !isUser { Spacer() }
            }
            .padding(.horizontal, 4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, isCompact ? 2 : 4)
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
        Group {
            if action.pending {
                cardContent
            } else {
                Button(action: openLink) {
                    cardContent
                }
                .buttonStyle(.plain)
                .disabled(!hasLink)
            }
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: action.pending ? 10 : 0) {
            HStack(spacing: 10) {
                Image(systemName: action.success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(action.success ? Color.oxyGreen : Color.oxyRed)

                VStack(alignment: .leading, spacing: 3) {
                    Text(actionSummary)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.oxyText)

                    if let text = detailText {
                        Text(text)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.oxySub)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }

                Spacer()

                if hasLink {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.oxyStone)
                } else {
                    Image(systemName: iconForAction(action.action))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.oxyDim)
                }
            }

            if action.pending, let onCommand {
                HStack(spacing: 8) {
                    Button {
                        onCommand("confirm")
                    } label: {
                        Label("Confirm", systemImage: "checkmark")
                            .font(.system(size: 12, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.oxyOnAccent)
                    .padding(.vertical, 8)
                    .background(Color.oxyStone)
                    .clipShape(RoundedRectangle(cornerRadius: 9))

                    Button {
                        onCommand("cancel")
                    } label: {
                        Label("Cancel", systemImage: "xmark")
                            .font(.system(size: 12, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.oxySub)
                    .padding(.vertical, 8)
                    .background(Color.oxySurface3)
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(action.success ? Color.oxyLine2 : Color.oxyRed.opacity(0.22), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.08), radius: 10, x: 0, y: 4)
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
        case "search_trains": return action.success ? "Trainline ready" : "Train search failed"
        case "order_uber_eats": return action.success ? "Uber Eats opened" : "Uber Eats failed"
        case "order_deliveroo": return action.success ? "Deliveroo opened" : "Deliveroo failed"
        case "play_music": return action.success ? "Music opened" : "Music failed"
        case "add_to_music_playlist": return action.success ? "Music added" : "Music add failed"
        case "create_reminder": return action.success ? "Reminder created" : "Reminder failed"
        case "create_calendar_event": return action.success ? "Calendar updated" : "Calendar failed"
        case "check_health": return action.success ? "Health checked" : "Health unavailable"
        default: return action.success ? "\(humanize(action.action)) done" : "\(humanize(action.action)) failed"
        }
    }

    private func iconForAction(_ type: String) -> String {
        switch type {
        case "send_email", "get_emails", "search_emails": return "envelope.fill"
        case "create_calendar_event", "get_calendar_events": return "calendar"
        case "book_uber": return "car.fill"
        case "find_place", "get_directions": return "map.fill"
        case "send_telegram", "get_telegram_contacts": return "paperplane.fill"
        case "search_trains": return "tram.fill"
        case "order_uber_eats", "order_deliveroo": return "fork.knife"
        case "search_netflix_title", "add_to_netflix_list": return "play.tv.fill"
        case "create_reminder": return "bell.fill"
        case "send_message": return "message.fill"
        case "play_music", "add_to_music_playlist": return "music.note"
        case "check_health": return "heart.fill"
        default: return "bolt.fill"
        }
    }
}

// MARK: - Typing Indicator

private struct TypingIndicator: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.oxySub)
                    .frame(width: 7, height: 7)
                    .scaleEffect(phase ? 1.0 : 0.5)
                    .opacity(phase ? 1.0 : 0.4)
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever(autoreverses: true)
                            .delay(Double(i) * 0.15),
                        value: phase
                    )
            }
        }
        .onAppear { phase = true }
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
    .background(Color.oxyBg)
}
