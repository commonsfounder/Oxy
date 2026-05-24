import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ChatViewModel()
    @FocusState private var isInputFocused: Bool
    @State private var showSearch = false
    @State private var isIncognito = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Incognito banner
                    if isIncognito {
                        HStack(spacing: 8) {
                            Image(systemName: "eye.slash.fill")
                                .font(.system(size: 12))
                            Text("Vanish mode — messages won't be saved")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(Color.oxyStone)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color.oxyStone.opacity(0.1))
                    }

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
                    Button(action: { showSearch = true }) {
                        Image(systemName: "magnifyingglass")
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
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                isIncognito.toggle()
                            }
                        }) {
                            Label(
                                isIncognito ? "Turn Off Vanish Mode" : "Vanish Mode",
                                systemImage: isIncognito ? "eye.fill" : "eye.slash.fill"
                            )
                        }
                        Divider()
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
            .sheet(isPresented: $showSearch) {
                ChatSearchView(userId: appState.userId)
            }
        }
        .task {
            await viewModel.loadHistory(userId: appState.userId)
        }
    }
}

// MARK: - Chat Search View

struct ChatSearchView: View {
    let userId: String
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if results.isEmpty && !isSearching && query.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 36))
                            .foregroundStyle(Color.oxyDim)
                        Text("Search conversations")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                        Text("Find messages from your chat history")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.oxyDim)
                    }
                } else if results.isEmpty && !isSearching && !query.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 36))
                            .foregroundStyle(Color.oxyDim)
                        Text("No results found")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(results) { result in
                                SearchResultRow(result: result)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 10)

                                if result.id != results.last?.id {
                                    Divider()
                                        .overlay(Color.oxyLine)
                                        .padding(.leading, 52)
                                }
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }

                if isSearching {
                    ProgressView()
                        .tint(Color.oxyStone)
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.oxyStone)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search messages...")
            .onChange(of: query) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    results = []
                    return
                }
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    await search(trimmed)
                }
            }
        }
    }

    private func search(_ q: String) async {
        isSearching = true
        do {
            let data = try await APIClient.shared.request(
                path: "/history/\(userId)/search",
                queryItems: [URLQueryItem(name: "q", value: q)]
            )
            let response = try JSONDecoder().decode(SearchResponse.self, from: data)
            results = response.results
        } catch {
            results = []
        }
        isSearching = false
    }
}

private struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(result.role == "user" ? Color.oxyStone.opacity(0.15) : Color.oxySurface3)
                    .frame(width: 36, height: 36)
                Image(systemName: result.role == "user" ? "person.fill" : "waveform")
                    .font(.system(size: 13))
                    .foregroundStyle(result.role == "user" ? Color.oxyStone : Color.oxySub)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(result.role == "user" ? "You" : "Oxy")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyText)

                Text(result.content)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .lineLimit(3)

                if let date = result.formattedDate {
                    Text(date)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.oxyDim)
                }
            }

            Spacer()
        }
    }
}

struct SearchResult: Codable, Identifiable {
    let role: String
    let content: String
    let createdAt: String?

    var id: String { (createdAt ?? "") + role + String(content.prefix(20)) }

    enum CodingKeys: String, CodingKey {
        case role, content
        case createdAt = "created_at"
    }

    var formattedDate: String? {
        guard let createdAt else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: createdAt)
            ?? ISO8601DateFormatter().date(from: createdAt)
        guard let date else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "d MMM · HH:mm"
        return fmt.string(from: date)
    }
}

struct SearchResponse: Codable {
    let results: [SearchResult]
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
