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
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    LazyVStack(spacing: 12) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                                .padding(.horizontal, 16)
                        }

                        ProactiveHeader(
                            isChecking: isChecking,
                            onCheckNow: { Task { await checkNow() } }
                        )
                        .padding(.horizontal, 16)
                        .padding(.top, 12)

                        if isLoading && briefings.isEmpty {
                            ProgressView()
                                .tint(Color.oxyStone)
                                .padding(.top, 28)
                        } else if visibleBriefings.isEmpty {
                            EmptyProactiveState()
                                .padding(.horizontal, 16)
                                .padding(.top, 24)
                        } else {
                            ForEach(visibleBriefings) { briefing in
                                BriefingCard(briefing: briefing) {
                                    Task { await markRead(briefing) }
                                }
                                .padding(.horizontal, 16)
                            }
                        }
                    }
                    .padding(.bottom, 24)
                }
                .refreshable {
                    await loadBriefings()
                }
            }
            .navigationTitle("Today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
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
        HStack(spacing: 12) {
            Image(systemName: "sparkles")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.oxyStone)
                .frame(width: 34, height: 34)
                .background(Color.oxyStone.opacity(0.12))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text("Today's insights")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.oxyText)
                Text("Only useful nudges. No noise.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.oxySub)
            }

            Spacer()

            Button(action: onCheckNow) {
                if isChecking {
                    ProgressView()
                        .tint(Color.oxyOnAccent)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 14, weight: .semibold))
                }
            }
            .frame(width: 38, height: 34)
            .foregroundStyle(Color.oxyOnAccent)
            .background(Color.oxyStone)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .disabled(isChecking)
        }
        .padding(14)
        .background(Color.oxySurface2.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.oxyLine, lineWidth: 1)
        )
    }
}

private struct BriefingCard: View {
    let briefing: Briefing
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: iconName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyStone)
                Text(briefing.title ?? title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.oxyText)
                Spacer()
                Text(timeLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.oxyDim)
            }

            Text(cleanBody)
                .font(.system(size: 14))
                .foregroundStyle(Color.oxyText)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Text(sourceLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.oxySub)
                Spacer()
                Button("Done", action: onDismiss)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.oxyStone)
            }
        }
        .padding(14)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }

    private var title: String {
        briefing.kind
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

    private var iconName: String {
        let k = briefing.kind.lowercased()
        if k.contains("health") { return "heart.fill" }
        if k.contains("location") { return "location.fill" }
        if k.contains("recipe") { return "bookmark.fill" }
        if k.contains("agent_task") || k.contains("task") { return "target" }
        if k.contains("email") { return "envelope.fill" }
        if k.contains("calendar") { return "calendar" }
        if k.contains("failed") { return "exclamationmark.arrow.triangle.2.circlepath" }
        return "sparkles"
    }

    private var cleanBody: String {
        briefing.body
            .replacingOccurrences(of: #"\([^)]*(unknown|\.unknown|Maps error|couldn't find)[^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var sourceLabel: String {
        let s = briefing.source?.lowercased() ?? ""
        let k = briefing.kind.lowercased()
        if s.contains("healthkit") || k.contains("health") { return "Health" }
        if s.contains("location") { return "Location" }
        if s.contains("agent") || k.contains("agent") || k.contains("task") { return "Agent" }
        if s.contains("email") { return "Email" }
        if s.contains("calendar") { return "Calendar" }
        if k.contains("recipe") { return "Recipe" }
        if s.contains("schedule") { return "Scheduled" }
        return "Insight"
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
        VStack(spacing: 10) {
            Image(systemName: "moon.zzz.fill")
                .font(.system(size: 26))
                .foregroundStyle(Color.oxyStone)
            Text("Nothing needs you right now.")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.oxyText)
            Text("The assistant will only interrupt when there’s something actually useful.")
                .font(.system(size: 13))
                .foregroundStyle(Color.oxySub)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
        .padding(.horizontal, 18)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

private extension Briefing {
    var isWorthShowing: Bool {
        // Only hide real noise/errors. Allow agent tasks, recipes, email/calendar nudges, etc.
        let lowerKind = kind.lowercased()
        // Still hide pure failed/cancelled noise, but let agent follow-ups through if useful
        if lowerKind.contains("failed") && !lowerKind.contains("agent") { return false }
        if lowerKind.contains("cancel") && !lowerKind.contains("agent") { return false }
        let lower = body.lowercased()
        let noisyFragments = [
            ".unknown",
            "maps error",
            "try a diff",
            "that hit a snag"
        ]
        if noisyFragments.contains(where: { lower.contains($0) }) {
            return false
        }
        // Allow everything else: nudges, recipes, agent_tasks, normal briefings
        return true
    }
}

#Preview {
    ProactiveView()
        .environment(AppState())
}
