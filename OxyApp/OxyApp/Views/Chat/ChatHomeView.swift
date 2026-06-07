import SwiftUI

/// The Chat tab. Shows a live `ChatView` with a slide-in conversation sidebar
/// (Claude/ChatGPT style): New Chat, search, and date-grouped recent chats.
/// Opens via the top-left menu button or a swipe from the left edge.
struct ChatHomeView: View {
    @Environment(AppState.self) private var appState

    // Drawer
    @State private var sidebarOpen = false
    @State private var dragOffset: CGFloat = 0

    // Which conversation the embedded ChatView is showing
    @State private var selectedSession: ChatSessionSummary?
    @State private var startFresh = false
    @State private var startIncognito = false
    @State private var chatReloadToken = UUID()

    // Sidebar data
    @State private var sessions: [ChatSessionSummary] = []
    @State private var isLoadingSessions = true
    @State private var searchQuery = ""
    @State private var searchResults: [SearchResult] = []
    @State private var isSearching = false
    @State private var searchTask: Task<Void, Never>?

    // Pendant
    @State private var pendantBridge = PendantAudioBridge()
    @State private var pendantItem: PendantTranscriptItem?

    private struct PendantTranscriptItem: Identifiable {
        let id = UUID().uuidString
        let transcript: String
    }

    private let sidebarWidth: CGFloat = 312
    private var edgeWidth: CGFloat { 22 }

    var body: some View {
        ZStack(alignment: .leading) {
            // Live chat
            ChatView(
                initialSession: selectedSession,
                startIncognito: startIncognito,
                startFresh: startFresh,
                onMenu: { openSidebar() }
            )
            .id(chatReloadToken)
            .disabled(sidebarOpen)

            // Pendant listening/transcribing overlay
            if pendantBridge.state != .idle {
                VStack {
                    Spacer()
                    PendantOverlay(
                        state: pendantBridge.state,
                        transcript: pendantBridge.lastTranscript,
                        notice: pendantBridge.notice
                    )
                    .padding(.bottom, 12)
                }
                .frame(maxWidth: .infinity)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Left-edge swipe target (only when closed)
            if !sidebarOpen {
                Color.clear
                    .frame(width: edgeWidth)
                    .frame(maxHeight: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .gesture(edgeOpenGesture)
            }

            // Dim backdrop
            if sidebarOpen {
                Color.black.opacity(0.45)
                    .ignoresSafeArea()
                    .onTapGesture { closeSidebar() }
                    .transition(.opacity)
            }

            // Drawer
            sidebar
                .frame(width: sidebarWidth)
                .frame(maxHeight: .infinity)
                .background(Color.oxySurface1.ignoresSafeArea())
                .offset(x: sidebarOpen ? dragOffset : -sidebarWidth)
                .gesture(drawerCloseGesture)
        }
        .animation(.spring(response: 0.34, dampingFraction: 0.86), value: sidebarOpen)
        .task { await loadSessions() }
        .onChange(of: searchQuery) { _, q in handleSearch(q) }
        .onAppear { setupPendantBridge() }
        .fullScreenCover(item: $pendantItem) { item in
            ChatView(autoSendTranscript: item.transcript)
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Chats")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Color.oxyText)
                Spacer()
                Button {
                    HapticManager.shared.impact(.light)
                    startIncognitoChat()
                } label: {
                    Image(systemName: "eye.slash")
                        .font(.system(size: 17))
                        .foregroundStyle(Color.oxySub)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 12)

            // New Chat
            Button {
                HapticManager.shared.impact(.light)
                startNewChat()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 15, weight: .semibold))
                    Text("New Chat")
                        .font(.system(size: 15, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(Color.oxyStone)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color.oxyStone.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)

            // Search
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.oxyDim)
                TextField("Search messages", text: $searchQuery)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.oxyText)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !searchQuery.isEmpty {
                    Button {
                        searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.oxyDim)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)

            Divider().overlay(Color.oxyLine)

            // List
            sidebarList
        }
    }

    @ViewBuilder
    private var sidebarList: some View {
        if isLoadingSessions {
            Spacer()
            ProgressView().tint(Color.oxyStone)
            Spacer()
        } else if !searchQuery.isEmpty {
            searchList
        } else if sessions.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
                    ForEach(groupedSessions, id: \.label) { group in
                        Section {
                            ForEach(group.sessions) { session in
                                Button {
                                    HapticManager.shared.impact(.light)
                                    open(session)
                                } label: {
                                    SidebarRow(title: session.title, trailing: session.relativeTime)
                                }
                                .buttonStyle(.plain)
                            }
                        } header: {
                            SidebarSectionHeader(label: group.label)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
    }

    @ViewBuilder
    private var searchList: some View {
        if isSearching {
            Spacer()
            ProgressView().tint(Color.oxyStone)
            Spacer()
        } else if searchResults.isEmpty {
            emptyState(icon: "doc.text.magnifyingglass", text: "No results")
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(searchResults) { result in
                        Button {
                            openSearchResult(result)
                        } label: {
                            SidebarSearchResultRow(result: result)
                        }
                        .buttonStyle(.plain)
                        Divider().overlay(Color.oxyLine).padding(.leading, 16)
                    }
                }
                .padding(.bottom, 24)
            }
        }
    }

    private var emptyState: some View {
        emptyState(icon: "bubble.left.and.bubble.right", text: "No conversations yet")
    }

    private func emptyState(icon: String, text: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: icon)
                .font(.system(size: 34))
                .foregroundStyle(Color.oxyDim)
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Color.oxySub)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Drawer control

    private func openSidebar() {
        dragOffset = 0
        sidebarOpen = true
        Task { await loadSessions() }
    }

    private func closeSidebar() {
        dragOffset = 0
        sidebarOpen = false
    }

    private var edgeOpenGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onEnded { value in
                if value.translation.width > 40 { openSidebar() }
            }
    }

    private var drawerCloseGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if value.translation.width < 0 {
                    dragOffset = max(value.translation.width, -sidebarWidth)
                }
            }
            .onEnded { value in
                if value.translation.width < -60 {
                    closeSidebar()
                } else {
                    dragOffset = 0
                }
            }
    }

    // MARK: - Chat switching

    private func startNewChat() {
        selectedSession = nil
        startIncognito = false
        startFresh = true
        chatReloadToken = UUID()
        closeSidebar()
    }

    private func startIncognitoChat() {
        selectedSession = nil
        startFresh = false
        startIncognito = true
        chatReloadToken = UUID()
        closeSidebar()
    }

    private func open(_ session: ChatSessionSummary) {
        selectedSession = session
        startFresh = false
        startIncognito = false
        chatReloadToken = UUID()
        closeSidebar()
    }

    // MARK: - Date grouping

    private struct SessionGroup {
        let label: String
        let sessions: [ChatSessionSummary]
    }

    private var groupedSessions: [SessionGroup] {
        let calendar = Calendar.current
        let now = Date()
        var today: [ChatSessionSummary] = []
        var yesterday: [ChatSessionSummary] = []
        var prev7Days: [ChatSessionSummary] = []
        var prev30Days: [ChatSessionSummary] = []
        var earlier: [ChatSessionSummary] = []

        for session in sessions {
            guard let date = Date.oxyParse(session.lastAt ?? session.startedAt) else {
                earlier.append(session); continue
            }
            if calendar.isDateInToday(date) {
                today.append(session)
            } else if calendar.isDateInYesterday(date) {
                yesterday.append(session)
            } else if let ago7 = calendar.date(byAdding: .day, value: -7, to: now), date >= ago7 {
                prev7Days.append(session)
            } else if let ago30 = calendar.date(byAdding: .day, value: -30, to: now), date >= ago30 {
                prev30Days.append(session)
            } else {
                earlier.append(session)
            }
        }

        var groups: [SessionGroup] = []
        if !today.isEmpty     { groups.append(.init(label: "Today",            sessions: today)) }
        if !yesterday.isEmpty { groups.append(.init(label: "Yesterday",        sessions: yesterday)) }
        if !prev7Days.isEmpty { groups.append(.init(label: "Previous 7 Days",  sessions: prev7Days)) }
        if !prev30Days.isEmpty{ groups.append(.init(label: "Previous 30 Days", sessions: prev30Days)) }
        if !earlier.isEmpty   { groups.append(.init(label: "Earlier",          sessions: earlier)) }
        return groups
    }

    // MARK: - API

    private func loadSessions() async {
        do {
            let data = try await APIClient.shared.request(path: "/history/\(appState.userId)/sessions")
            let decoded = try JSONDecoder().decode(ChatSessionsResponse.self, from: data)
            sessions = decoded.sessions
        } catch {}
        isLoadingSessions = false
    }

    private func handleSearch(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask?.cancel()
        searchResults = []
        guard !trimmed.isEmpty else { isSearching = false; return }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await searchMessages(trimmed)
        }
    }

    private func searchMessages(_ q: String) async {
        isSearching = true
        defer { if !Task.isCancelled { isSearching = false } }
        do {
            let data = try await APIClient.shared.request(
                path: "/history/\(appState.userId)/search",
                queryItems: [URLQueryItem(name: "q", value: q)]
            )
            guard !Task.isCancelled else { return }
            let decoded = try JSONDecoder().decode(SearchResponse.self, from: data)
            searchResults = decoded.results
        } catch {
            if !Task.isCancelled { searchResults = [] }
        }
    }

    private func openSearchResult(_ result: SearchResult) {
        guard let createdAt = result.createdAt, let resultDate = Date.oxyParse(createdAt) else { return }
        let match = sessions
            .filter { session in
                guard let startDate = Date.oxyParse(session.startedAt ?? session.lastAt) else { return false }
                return startDate <= resultDate
            }
            .sorted {
                guard let d1 = Date.oxyParse($0.startedAt ?? $0.lastAt),
                      let d2 = Date.oxyParse($1.startedAt ?? $1.lastAt) else { return false }
                return d1 > d2
            }
            .first
        if let session = match {
            open(session)
        }
    }

    // MARK: - Pendant bridge

    private func setupPendantBridge() {
        let bridge = pendantBridge
        bridge.userId = appState.userId

        bridge.onTranscript = { transcript in
            Task { @MainActor in
                HapticManager.shared.impact(.medium)
                NativeIntegrationManager.shared.pendant.sendCommand("THINK")
                self.pendantItem = PendantTranscriptItem(transcript: transcript)
            }
        }

        NativeIntegrationManager.shared.pendant.onAudioData = { @MainActor data in
            bridge.ingest(data)
        }
    }
}

// MARK: - Sidebar rows

private struct SidebarRow: View {
    let title: String
    let trailing: String

    var body: some View {
        HStack(spacing: 0) {
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.oxyText)
                .lineLimit(1)
            Spacer(minLength: 12)
            Text(trailing)
                .font(.system(size: 12))
                .foregroundStyle(Color.oxyDim)
                .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct SidebarSectionHeader: View {
    let label: String

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.oxySurface1)
    }
}

private struct SidebarSearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(result.role == "user" ? "You" : "Oxy")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.oxySub)
                Spacer()
                if let date = result.formattedDate {
                    Text(date)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.oxyDim)
                }
            }
            Text(result.content)
                .font(.system(size: 14))
                .foregroundStyle(Color.oxyText)
                .lineLimit(2)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#Preview {
    ChatHomeView()
        .environment(AppState())
}
