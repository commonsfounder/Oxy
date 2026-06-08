import SwiftUI

struct ProactiveView: View {
    @Environment(AppState.self) private var appState
    @State private var briefings: [Briefing] = []
    @State private var isLoading = false
    @State private var isChecking = false
    @State private var errorMessage: String?

    private let service = ChatService()
    private var visibleBriefings: [Briefing] {
        briefings.filter(\.isWorthShowing)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                                .padding(.bottom, 20)
                        }

                        ProactiveHeader(
                            isChecking: isChecking,
                            onCheckNow: { Task { await checkNow() } }
                        )
                        .padding(.top, 8)
                        .padding(.bottom, 28)

                        if isLoading && briefings.isEmpty {
                            ProgressView()
                                .tint(Color.nmlTitanium)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if visibleBriefings.isEmpty {
                            EmptyProactiveState()
                                .padding(.top, 24)
                        } else {
                            ForEach(Array(visibleBriefings.enumerated()), id: \.element.id) { index, briefing in
                                if index != 0 { NamelessDivider() }
                                BriefingRow(briefing: briefing) {
                                    Task { await markRead(briefing) }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
                .refreshable {
                    await loadBriefings()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .task {
            await loadBriefings()
        }
    }

    private func loadBriefings() async {
        isLoading = true
        errorMessage = nil
        do {
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func checkNow() async {
        guard !isChecking else { return }
        isChecking = true
        errorMessage = nil
        await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        do {
            try await service.runProactiveCheck(userId: appState.userId)
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }
        isChecking = false
    }

    private func markRead(_ briefing: Briefing) async {
        await service.markBriefingRead(userId: appState.userId, briefingId: briefing.id)
        if let index = briefings.firstIndex(where: { $0.id == briefing.id }) {
            briefings.remove(at: index)
        }
    }
}

private struct ProactiveHeader: View {
    let isChecking: Bool
    let onCheckNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Today")
                    .font(.system(size: 30, weight: .regular, design: .serif))
                    .foregroundStyle(Color.nmlInk)
                Spacer()
                Button(action: onCheckNow) {
                    if isChecking {
                        ProgressView()
                            .scaleEffect(0.7)
                            .tint(Color.nmlMuted)
                    } else {
                        Text("REFRESH")
                            .font(.nmlMono(11, weight: .medium))
                            .tracking(1.4)
                            .foregroundStyle(Color.nmlTitanium)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isChecking)
            }
        }
    }
}

private struct BriefingRow: View {
    let briefing: Briefing
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(briefing.title ?? title)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Spacer(minLength: 12)
                Text(timeLabel)
                    .font(.nmlMono(10))
                    .foregroundStyle(Color.nmlMuted)
            }

            Text(cleanBody)
                .font(.system(size: 14, weight: .light))
                .foregroundStyle(Color.nmlMuted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Text(sourceLabel.uppercased())
                    .font(.nmlMono(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(Color.nmlMuted)
                Spacer()
                Button("DISMISS", action: onDismiss)
                    .font(.nmlMono(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(Color.nmlTitanium)
                    .buttonStyle(.plain)
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 20)
    }

    private var title: String {
        briefing.kind
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

    private var cleanBody: String {
        briefing.body
            .replacingOccurrences(of: #"\([^)]*(unknown|\.unknown|Maps error|couldn't find)[^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var sourceLabel: String {
        switch briefing.source {
        case "healthkit": return "HealthKit"
        case "location": return "Location"
        case "action_log": return "Action follow-up"
        case "schedule": return "Scheduled"
        default: return "Proactive"
        }
    }

    private var timeLabel: String {
        guard let createdAt = briefing.createdAt,
              let date = ISO8601DateFormatter().date(from: createdAt) else {
            return ""
        }
        return DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
    }
}

private struct EmptyProactiveState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing needs you right now.")
                .font(.system(size: 17, weight: .regular, design: .serif))
                .foregroundStyle(Color.nmlInk)
            Text("Nameless will only interrupt when there's something actually useful.")
                .font(.system(size: 13, weight: .light))
                .foregroundStyle(Color.nmlMuted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
    }
}

private extension Briefing {
    var isWorthShowing: Bool {
        if source == "action_log" { return false }
        let lowerKind = kind.lowercased()
        if lowerKind.contains("failed") || lowerKind.contains("cancel") { return false }
        let lower = body.lowercased()
        let noisyFragments = [
            ".unknown",
            "maps error",
            "try a diff",
            "that hit a snag",
            "cancelled",
            "canceled",
            "was cancelled",
            "was canceled"
        ]
        if noisyFragments.contains(where: { lower.contains($0) }) {
            return false
        }
        return true
    }
}

#Preview {
    ProactiveView()
        .environment(AppState())
}
