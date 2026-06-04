import SwiftUI

struct HistoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var sessions: [ChatSessionSummary] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .tint(Color.oxyStone)
                } else if sessions.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 40))
                            .foregroundStyle(Color.oxyDim)
                        Text("No conversations yet")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
                            ForEach(groupedSessions, id: \.label) { group in
                                Section {
                                    ForEach(group.sessions) { session in
                                        Button {
                                            NotificationCenter.default.post(
                                                name: .oxyJumpToChat,
                                                object: nil,
                                                userInfo: [
                                                    "sessionId": session.id,
                                                    "lastAt": session.lastAt ?? ""
                                                ]
                                            )
                                        } label: {
                                            SessionRow(session: session)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                } header: {
                                    SectionHeader(label: group.label)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.oxySub)
                            .frame(width: 30, height: 30)
                            .background(Color.oxySurface2)
                            .clipShape(Circle())
                    }
                }
            }
            .task {
                await loadSessions()
            }
            .refreshable {
                await loadSessions()
            }
        }
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
        var thisWeek: [ChatSessionSummary] = []
        var earlier: [ChatSessionSummary] = []

        for session in sessions {
            guard let date = Date.oxyParse(session.lastAt ?? session.startedAt) else {
                earlier.append(session)
                continue
            }
            if calendar.isDateInToday(date) {
                today.append(session)
            } else if calendar.isDateInYesterday(date) {
                yesterday.append(session)
            } else if let weekAgo = calendar.date(byAdding: .day, value: -7, to: now), date >= weekAgo {
                thisWeek.append(session)
            } else {
                earlier.append(session)
            }
        }

        var groups: [SessionGroup] = []
        if !today.isEmpty { groups.append(SessionGroup(label: "Today", sessions: today)) }
        if !yesterday.isEmpty { groups.append(SessionGroup(label: "Yesterday", sessions: yesterday)) }
        if !thisWeek.isEmpty { groups.append(SessionGroup(label: "This Week", sessions: thisWeek)) }
        if !earlier.isEmpty { groups.append(SessionGroup(label: "Earlier", sessions: earlier)) }
        return groups
    }

    private func loadSessions() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/history/\(appState.userId)/sessions"
            )
            let response = try JSONDecoder().decode(ChatSessionsResponse.self, from: data)
            sessions = response.sessions
            isLoading = false
        } catch {
            isLoading = false
        }
    }
}

// MARK: - Section Header

private struct SectionHeader: View {
    let label: String

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
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

// MARK: - Session Row

private struct SessionRow: View {
    let session: ChatSessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.oxyText)
                    .lineLimit(1)

                Spacer(minLength: 12)

                Text(session.relativeTime)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxyDim)
            }

            if !session.preview.isEmpty {
                Text(session.preview)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

#Preview {
    HistoryView()
        .environment(AppState())
}
