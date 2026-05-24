import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ChatViewModel()
    @FocusState private var isInputFocused: Bool

    var body: some View {
        ZStack {
            Color.oxyBg.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                ChatHeader(onLogout: { appState.logout() })

                // Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(viewModel.messages) { message in
                                MessageBubble(message: message)
                                    .id(message.id)
                            }

                            if let status = viewModel.statusLabel {
                                StatusIndicator(label: status)
                                    .id("status")
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: viewModel.messages.count) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            if let lastId = viewModel.messages.last?.id {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            } else {
                                proxy.scrollTo("status", anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: viewModel.messages.last?.content) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            if let lastId = viewModel.messages.last?.id {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            } else {
                                proxy.scrollTo("status", anchor: .bottom)
                            }
                        }
                    }
                }

                // Input bar
                ChatInputBar(
                    text: $viewModel.inputText,
                    isSending: viewModel.isSending,
                    isFocused: $isInputFocused,
                    onSend: {
                        viewModel.sendMessage(userId: appState.userId)
                    }
                )
            }
        }
        .task {
            await viewModel.loadHistory(userId: appState.userId)
        }
    }
}

// MARK: - Chat Header

private struct ChatHeader: View {
    let onLogout: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Oxy")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.oxyText)

                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.oxyGreen)
                        .frame(width: 6, height: 6)
                    Text("Online")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.oxySub)
                }
            }

            Spacer()

            Button(action: onLogout) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.oxySub)
                    .frame(width: 36, height: 36)
                    .background(Color.oxySurface2)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.oxySurface1)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.oxyLine)
                .frame(height: 1)
        }
    }
}

// MARK: - Chat Input Bar

private struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            TextField("Message Oxy...", text: $text, axis: .vertical)
                .font(.system(size: 14))
                .foregroundStyle(Color.oxyText)
                .lineLimit(1...5)
                .focused(isFocused)
                .onSubmit {
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        onSend()
                    }
                }

            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(canSend ? Color.oxyText : Color.oxyDim)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color.oxySurface1)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.oxyLine)
                .frame(height: 1)
        }
    }

    private var canSend: Bool {
        !isSending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - Status Indicator

private struct StatusIndicator: View {
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .scaleEffect(0.7)
                .tint(Color.oxyStone)
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.oxySub)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 4)
    }
}

#Preview {
    ChatView()
        .environment(AppState())
}
