import SwiftUI

struct HistoryView: View {
    @Environment(AppState.self) private var appState
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
                        LazyVStack(spacing: 0) {
                            ForEach(sessions) { session in
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

                                if session.id != sessions.last?.id {
                                    Divider()
                                        .overlay(Color.oxyLine)
                                        .padding(.horizontal, 16)
                                }
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .task {
                await loadSessions()
            }
            .refreshable {
                await loadSessions()
            }
        }
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

// MARK: - Session Row

private struct SessionRow: View {
    let session: ChatSessionSummary

    var body: some View {
        HStack(spacing: 0) {
            Text(session.title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.oxyText)
                .lineLimit(1)

            Spacer(minLength: 12)

            Text(session.relativeTime)
                .font(.system(size: 13))
                .foregroundStyle(Color.oxyDim)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

// MARK: - ChatSessionSummary extension

private extension ChatSessionSummary {
    var relativeTime: String {
        guard let date = Date.oxyParse(lastAt ?? startedAt) else { return "" }
        let diff = Date().timeIntervalSince(date)
        if diff < 60 { return "just now" }
        if diff < 3600 { return "\(Int(diff / 60))m ago" }
        if diff < 86400 { return "\(Int(diff / 3600))h ago" }
        if diff < 7 * 86400 { return "\(Int(diff / 86400))d ago" }
        let fmt = DateFormatter()
        fmt.dateFormat = "d MMM"
        return fmt.string(from: date)
    }
}

#Preview {
    HistoryView()
        .environment(AppState())
}
