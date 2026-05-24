import SwiftUI

struct MessageBubble: View {
    let message: Message

    private var isUser: Bool { message.role == .user }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            // Message content
            if !message.content.isEmpty {
                Text(message.content)
                    .font(.system(size: 14))
                    .foregroundStyle(isUser ? Color.oxyBg : Color.oxyText)
                    .lineSpacing(3)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(isUser ? Color.oxyText : Color.oxySurface2)
                    .clipShape(
                        RoundedRectangle(cornerRadius: 16)
                    )
                    .frame(maxWidth: 280, alignment: isUser ? .trailing : .leading)
            }

            // Streaming indicator
            if message.isStreaming && message.content.isEmpty {
                TypingIndicator()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color.oxySurface2)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
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
            Text(message.timestamp, style: .time)
                .font(.system(size: 10))
                .foregroundStyle(Color.oxyDim)
                .padding(.horizontal, 4)
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }
}

// MARK: - Action Card

struct ActionCard: View {
    let action: ActionResult

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: action.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(action.success ? Color.oxyGreen : Color.oxyRed)

            VStack(alignment: .leading, spacing: 2) {
                Text(humanize(action.action))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.oxyText)

                if let text = action.text ?? action.error {
                    Text(text)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.oxySub)
                        .lineLimit(3)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color.oxySurface3)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func humanize(_ type: String) -> String {
        type.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

// MARK: - Typing Indicator

private struct TypingIndicator: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.oxySub)
                    .frame(width: 6, height: 6)
                    .scaleEffect(dotScale(for: i))
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever()
                            .delay(Double(i) * 0.15),
                        value: phase
                    )
            }
        }
        .onAppear { phase = 1 }
    }

    private func dotScale(for index: Int) -> CGFloat {
        phase == 0 ? 0.5 : 1.0
    }
}

#Preview {
    VStack(spacing: 16) {
        MessageBubble(message: Message(role: .user, content: "Book me an Uber to Kings Cross"))
        MessageBubble(message: Message(
            role: .assistant,
            content: "On it! Opening Uber for you.",
            actions: [ActionResult(action: "book_uber", success: true, text: "Uber link opened")]
        ))
        MessageBubble(message: Message(role: .assistant, content: "", isStreaming: true))
    }
    .padding()
    .background(Color.oxyBg)
}
