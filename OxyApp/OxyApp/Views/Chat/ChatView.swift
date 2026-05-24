import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ChatViewModel()
    @FocusState private var isInputFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                if viewModel.messages.isEmpty && !viewModel.isSending {
                                    WelcomeCard(onQuickAction: { action in
                                        viewModel.inputText = action
                                        viewModel.sendMessage(userId: appState.userId)
                                    })
                                    .padding(.top, 40)
                                    .padding(.bottom, 20)
                                }

                                ForEach(viewModel.messages) { message in
                                    MessageBubble(message: message)
                                        .id(message.id)
                                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                                }

                                if let status = viewModel.statusLabel {
                                    StatusIndicator(label: status)
                                        .id("status")
                                        .padding(.horizontal, 16)
                                        .padding(.top, 4)
                                }
                            }
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: { viewModel.clearChat() }) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 17))
                            .foregroundStyle(Color.oxySub)
                    }
                }

                ToolbarItem(placement: .principal) {
                    HStack(spacing: 10) {
                        ZStack {
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [Color.oxyStone.opacity(0.3), Color.oxyStone.opacity(0.15)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 34, height: 34)

                            Image(systemName: "waveform")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyStone)
                        }

                        VStack(alignment: .leading, spacing: 1) {
                            Text("Oxy")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Color.oxyText)
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(Color.oxyGreen)
                                    .frame(width: 6, height: 6)
                                Text("Online")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Color.oxySub)
                            }
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: { viewModel.clearChat() }) {
                            Label("New Chat", systemImage: "plus.bubble")
                        }
                        Button(role: .destructive, action: { appState.logout() }) {
                            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.oxySub)
                    }
                }
            }
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .task {
            await viewModel.loadHistory(userId: appState.userId)
        }
    }
}

// MARK: - Welcome Card

private struct WelcomeCard: View {
    let onQuickAction: (String) -> Void

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color.oxyStone.opacity(0.2), Color.oxyStone.opacity(0.05)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 72, height: 72)

                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(Color.oxyStone)
            }

            VStack(spacing: 6) {
                Text("Hey! I'm Oxy")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.oxyText)

                Text("Your AI assistant. Ask me anything\nor tell me to do something.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: 8) {
                QuickChip(icon: "envelope.fill", label: "Check emails") {
                    onQuickAction("Check my emails")
                }
                QuickChip(icon: "calendar", label: "My schedule") {
                    onQuickAction("What's my schedule today?")
                }
                QuickChip(icon: "car.fill", label: "Book a ride") {
                    onQuickAction("Book me a ride")
                }
            }
        }
        .padding(.horizontal, 32)
    }
}

private struct QuickChip: View {
    let icon: String
    let label: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.oxyStone)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.oxySub)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chat Input Bar

private struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider()
                .overlay(Color.oxyLine2)

            HStack(alignment: .bottom, spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Message Oxy...", text: $text, axis: .vertical)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.oxyText)
                        .lineLimit(1...5)
                        .focused(isFocused)
                        .onSubmit {
                            if canSend { onSend() }
                        }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.oxySurface2)
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .overlay(
                    RoundedRectangle(cornerRadius: 22)
                        .stroke(Color.oxyLine2, lineWidth: 1)
                )

                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(canSend ? Color.oxyBg : Color.oxyDim)
                        .frame(width: 36, height: 36)
                        .background(canSend ? Color.oxyStone : Color.oxySurface3)
                        .clipShape(Circle())
                }
                .disabled(!canSend)
                .animation(.easeInOut(duration: 0.15), value: canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.oxySurface1)
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
        .padding(.leading, 20)
    }
}

#Preview {
    ChatView()
        .environment(AppState())
}
