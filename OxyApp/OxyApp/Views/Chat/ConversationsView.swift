import SwiftUI

struct ConversationsView: View {
    @Environment(AppState.self) private var appState
    @State private var sessions: [ChatSessionSummary] = []
    @State private var isLoading = true
    @State private var searchQuery = ""
    @State private var searchResults: [SearchResult] = []
    @State private var isSearching = false
    @State private var searchTask: Task<Void, Never>?
    @State private var selectedSession: ChatSessionSummary?
    @State private var showNewChat = false
    @State private var showIncognitoChat = false
    @State private var pendantItem: PendantTranscriptItem?
    @State private var showMenuSheet = false
    @State private var pendantBridge = PendantAudioBridge()

    private struct PendantTranscriptItem: Identifiable {
        let id = UUID().uuidString
        let transcript: String
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    mainContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    if pendantBridge.state != .idle {
                        HStack {
                            Spacer()
                            PendantOverlay(
                                state: pendantBridge.state,
                                transcript: pendantBridge.lastTranscript,
                                notice: pendantBridge.notice
                            )
                            Spacer()
                        }
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                        .transition(.asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .scale(scale: 0.88)).combined(with: .opacity),
                            removal: .scale(scale: 0.88).combined(with: .opacity)
                        ))
                    }
                }
            }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .searchable(
                text: $searchQuery,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: "Search messages..."
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        HapticManager.shared.impact(.light)
                        showMenuSheet = true
                    } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Color.oxySub)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        HapticManager.shared.impact(.light)
                        showIncognitoChat = true
                    } label: {
                        Image(systemName: "theatermask.and.paintbrush")
                            .font(.system(size: 17))
                            .foregroundStyle(Color.oxySub)
                    }
                }
            }
            .navigationDestination(item: $selectedSession) { session in
                ChatView(initialSession: session)
            }
            .navigationDestination(isPresented: $showNewChat) {
                ChatView()
            }
            .navigationDestination(isPresented: $showIncognitoChat) {
                ChatView(startIncognito: true)
            }
            .fullScreenCover(item: $pendantItem) { item in
                NavigationStack {
                    ChatView(autoSendTranscript: item.transcript)
                }
            }
            .sheet(isPresented: $showMenuSheet) {
                MenuSheet()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .task { await loadSessions() }
            .refreshable { await loadSessions() }
            .onChange(of: searchQuery) { _, q in handleSearch(q) }
            .onAppear { setupPendantBridge() }
        }
    }

    // MARK: - Main content

    @ViewBuilder
    private var mainContent: some View {
        if isLoading {
            ProgressView().tint(Color.oxyStone)
        } else if !searchQuery.isEmpty {
            searchContent
        } else if sessions.isEmpty {
            emptyState
        } else {
            sessionList
        }
    }

    // MARK: - Session list

    private var sessionList: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
                ForEach(groupedSessions, id: \.label) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            Button {
                                HapticManager.shared.impact(.light)
                                selectedSession = session
                            } label: {
                                ConversationRow(session: session)
                            }
                            .buttonStyle(.plain)

                            if session.id != group.sessions.last?.id {
                                Divider()
                                    .overlay(Color.oxyLine)
                                    .padding(.leading, 16)
                            }
                        }
                    } header: {
                        ConversationSectionHeader(label: group.label)
                    }
                }
            }
        }
    }

    // MARK: - Search content

    private var localFiltered: [ChatSessionSummary] {
        sessions.filter {
            $0.title.localizedCaseInsensitiveContains(searchQuery) ||
            $0.preview.localizedCaseInsensitiveContains(searchQuery)
        }
    }

    @ViewBuilder
    private var searchContent: some View {
        if isSearching {
            ProgressView().tint(Color.oxyStone)
        } else if !searchResults.isEmpty {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(searchResults) { result in
                        Button {
                            openSearchResult(result)
                        } label: {
                            ConversationSearchResultRow(result: result)
                        }
                        .buttonStyle(.plain)

                        if result.id != searchResults.last?.id {
                            Divider()
                                .overlay(Color.oxyLine)
                                .padding(.horizontal, 16)
                        }
                    }
                }
                .padding(.vertical, 8)
            }
        } else if !localFiltered.isEmpty {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(localFiltered) { session in
                        Button {
                            HapticManager.shared.impact(.light)
                            selectedSession = session
                        } label: {
                            ConversationRow(session: session)
                        }
                        .buttonStyle(.plain)

                        if session.id != localFiltered.last?.id {
                            Divider()
                                .overlay(Color.oxyLine)
                                .padding(.leading, 16)
                        }
                    }
                }
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 36))
                    .foregroundStyle(Color.oxyDim)
                Text("No results")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.oxySub)
            }
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(Color.oxyDim)
            Text("No conversations yet")
                .font(.system(size: 15))
                .foregroundStyle(Color.oxySub)
        }
    }

    // MARK: - Grouping

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
        isLoading = false
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
            HapticManager.shared.impact(.light)
            selectedSession = session
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

// MARK: - Menu Sheet (hamburger)

private struct MenuSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var destination: MenuDestination?

    enum MenuDestination: Identifiable {
        case connectors, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 12) {
                        menuSection {
                            menuButton(icon: "link", title: "Connectors", color: .oxyStone) {
                                destination = .connectors
                            }
                            Divider().overlay(Color.oxyLine).padding(.leading, 58)
                            menuButton(icon: "gearshape.fill", title: "Settings", color: .oxySub) {
                                destination = .settings
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Menu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.oxyText)
                }
            }
            .fullScreenCover(item: $destination) { dest in
                switch dest {
                case .connectors: ConnectorsView()
                case .settings: SettingsView()
                }
            }
        }
    }

    private func menuSection<C: View>(@ViewBuilder content: () -> C) -> some View {
        VStack(spacing: 0) { content() }
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func menuButton(icon: String, title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: { HapticManager.shared.impact(.light); action() }) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                Text(title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyDim)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Conversation Row

private struct ConversationRow: View {
    let session: ChatSessionSummary

    var body: some View {
        HStack(spacing: 0) {
            Text(session.title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.oxyText)
                .lineLimit(1)

            Spacer(minLength: 12)

            Text(session.relativeTime)
                .font(.system(size: 13))
                .foregroundStyle(Color.oxyDim)
                .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Section Header

private struct ConversationSectionHeader: View {
    let label: String

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.oxyBg)
    }
}

// MARK: - Search Result Row

private struct ConversationSearchResultRow: View {
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
                .lineLimit(3)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview {
    ConversationsView()
        .environment(AppState())
}
