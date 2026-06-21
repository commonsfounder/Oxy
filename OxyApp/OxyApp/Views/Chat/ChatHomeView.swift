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

    private let sidebarWidth: CGFloat = 312
    private var edgeWidth: CGFloat { 22 }

    var body: some View {
        ZStack(alignment: .leading) {
            // Live chat
            ChatView(
                initialSession: selectedSession,
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
                Color.nmlFillScrim
                    .ignoresSafeArea()
                    .onTapGesture { closeSidebar() }
                    .transition(.opacity)
            }

            // Drawer
            sidebar
                .frame(width: sidebarWidth)
                .frame(maxHeight: .infinity)
                .background(Color.nmlObsidian.ignoresSafeArea())
                .offset(x: sidebarOpen ? dragOffset : -sidebarWidth)
                .gesture(drawerCloseGesture)
        }
        .animation(.nmlSpring, value: sidebarOpen)
        .task { await loadSessions() }
        .onChange(of: searchQuery) { _, q in handleSearch(q) }
        .onAppear {
            setupPendantBridge()
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            // Header — Milgrain wordmark above the label for editorial weight
            VStack(alignment: .leading, spacing: 10) {
                BrandWordmark(height: 12)
                Text("CONVERSATIONS")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(3.5)
                    .foregroundStyle(Color.nmlMuted.opacity(0.6))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 52)
            .padding(.bottom, 16)

            // New Chat
            Button {
                HapticManager.shared.impact(.light)
                startNewChat()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 14, weight: .medium))
                    Text("New conversation")
                        .font(.system(size: 14, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(Color.nmlInk)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous).strokeBorder(Color.nmlHairline, lineWidth: 0.5))
            }
            .buttonStyle(.nmlScale(0.97))
            .padding(.horizontal, 16)

            // Search
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.nmlMuted)
                TextField("Search", text: $searchQuery)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.nmlInk)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !searchQuery.isEmpty {
                    Button {
                        searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    .buttonStyle(.nmlScale)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(Color.nmlSurface)
            .clipShape(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous).strokeBorder(Color.nmlHairline, lineWidth: 0.5))
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            Rectangle().fill(Color.nmlHairline).frame(height: 0.5)

            // List
            sidebarList
        }
    }

    @ViewBuilder
    private var sidebarList: some View {
        if isLoadingSessions {
            Spacer()
            ProgressView().tint(Color.nmlTitanium)
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
                                .buttonStyle(.nmlScale(0.98))
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
            ProgressView().tint(Color.nmlTitanium)
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
                        .buttonStyle(.nmlScale(0.98))
                        Divider().overlay(Color.nmlHairline).padding(.leading, 16)
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
                .foregroundStyle(Color.nmlMuted)
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Color.nmlMuted)
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
        startFresh = true
        chatReloadToken = UUID()
        closeSidebar()
    }

    private func open(_ session: ChatSessionSummary) {
        selectedSession = session
        startFresh = false
        chatReloadToken = UUID()
        closeSidebar()
    }

    // MARK: - Date grouping

    private struct SessionGroup {
        let label: String
        let sessions: [ChatSessionSummary]
    }

    /// Every conversation, always — grouped only by the natural Today / Yesterday /
    /// Earlier rhythm. No rolling 7- or 30-day cutoff: nothing is ever hidden by age.
    private var groupedSessions: [SessionGroup] {
        let calendar = Calendar.current
        var today: [ChatSessionSummary] = []
        var yesterday: [ChatSessionSummary] = []
        var earlier: [ChatSessionSummary] = []

        for session in sessions {
            guard let date = Date.oxyParse(session.lastAt ?? session.startedAt) else {
                earlier.append(session); continue
            }
            if calendar.isDateInToday(date) {
                today.append(session)
            } else if calendar.isDateInYesterday(date) {
                yesterday.append(session)
            } else {
                earlier.append(session)
            }
        }

        var groups: [SessionGroup] = []
        if !today.isEmpty     { groups.append(.init(label: "Today",     sessions: today)) }
        if !yesterday.isEmpty { groups.append(.init(label: "Yesterday", sessions: yesterday)) }
        if !earlier.isEmpty   { groups.append(.init(label: "Earlier",   sessions: earlier)) }
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
                // Send into the chat the user is already looking at, rather than
                // presenting a second ChatView on top (the old duplicate-screen bug).
                NotificationCenter.default.post(
                    name: .oxyVoiceMessage,
                    object: nil,
                    userInfo: ["text": transcript]
                )
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
                .font(.nmlBody(14, weight: .light))
                .foregroundStyle(Color.nmlInk)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 12)
            Text(trailing)
                .font(.nmlMono(11))
                .monospacedDigit()
                .foregroundStyle(Color.nmlMuted.opacity(0.7))
                .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct SidebarSectionHeader: View {
    let label: String

    var body: some View {
        HStack {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .regular))
                .tracking(2.8)
                .foregroundStyle(Color.nmlMuted.opacity(0.5))
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Color.nmlObsidian)
    }
}

private struct SidebarSearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(result.role == "user" ? "You" : "Millie")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.nmlMuted)
                Spacer()
                if let date = result.formattedDate {
                    Text(date)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.nmlMuted)
                }
            }
            Text(result.content)
                .font(.system(size: 14))
                .foregroundStyle(Color.nmlInk)
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
