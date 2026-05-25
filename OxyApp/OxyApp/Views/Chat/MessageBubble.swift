import SwiftUI

struct MessageBubble: View {
    let message: Message

    private var isUser: Bool { message.role == .user }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
            // Message content
            if !message.content.isEmpty {
                HStack {
                    if isUser { Spacer(minLength: 60) }

                    VStack(alignment: .leading, spacing: 0) {
                        Text(message.content)
                            .font(.system(size: 15))
                            .foregroundStyle(isUser ? .white : Color.oxyText)
                            .lineSpacing(4)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
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
                            bottomLeadingRadius: 20,
                            bottomTrailingRadius: isUser ? 6 : 20,
                            topTrailingRadius: 20
                        )
                    )

                    if !isUser { Spacer(minLength: 60) }
                }
            }

            // Streaming indicator
            if message.isStreaming && message.content.isEmpty {
                HStack {
                    TypingIndicator()
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
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
                        ActionCard(action: action)
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
        .padding(.vertical, 4)
    }
}

// MARK: - Action Card

struct ActionCard: View {
    let action: ActionResult

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
        Button(action: openLink) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(action.success ? Color.oxyGreen.opacity(0.15) : Color.oxyRed.opacity(0.15))
                        .frame(width: 32, height: 32)

                    Image(systemName: action.success ? "checkmark" : "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(action.success ? Color.oxyGreen : Color.oxyRed)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(humanize(action.action))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.oxyText)

                    if let text = detailText {
                        Text(text)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.oxySub)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                    }
                }

                Spacer()

                if hasLink {
                    Image(systemName: "arrow.up.right.square.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.oxyStone)
                } else {
                    Image(systemName: iconForAction(action.action))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.oxyDim)
                }
            }
            .padding(12)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(hasLink ? Color.oxyStone.opacity(0.3) : Color.oxyLine2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(!hasLink)
    }

    private func openLink() {
        if let link = action.deepLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        } else if let link = action.webLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        }
    }

    private func humanize(_ type: String) -> String {
        type.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func iconForAction(_ type: String) -> String {
        switch type {
        case "send_email", "get_emails", "search_emails": return "envelope.fill"
        case "create_calendar_event", "get_calendar_events": return "calendar"
        case "book_uber": return "car.fill"
        case "find_place": return "map.fill"
        case "send_telegram", "get_telegram_contacts": return "paperplane.fill"
        case "search_trains": return "tram.fill"
        case "order_uber_eats", "order_deliveroo": return "fork.knife"
        case "search_netflix_title", "add_to_netflix_list": return "play.tv.fill"
        case "create_reminder": return "bell.fill"
        case "send_message": return "message.fill"
        case "play_music": return "music.note"
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
