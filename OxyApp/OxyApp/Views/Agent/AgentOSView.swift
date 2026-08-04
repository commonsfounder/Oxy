import SwiftUI

/// The durable identity layer: a readable view of what Millie knows and what she
/// is currently carrying forward between conversations.
struct AgentOSView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var context: AgentContextSnapshot?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "Millie", onBack: { dismiss() })

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: {
                                Task { await load() }
                            })
                        }

                        if isLoading {
                            ForEach(0..<4, id: \.self) { _ in
                                OxySkeletonCard(height: 82, cornerRadius: 20)
                            }
                        } else if let context {
                            identityCard(context.agent)
                            profileSection(context.profile)
                            preferenceSection(context.preferences)
                            goalSection(context.goals)
                            connectedAppsSection(context.connectedApps)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await load() }
        }
    }

    private func identityCard(_ agent: AgentIdentity) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AppIcon("sparkles", size: 18)
                    .foregroundStyle(Color.appAccent)
                    .frame(width: 40, height: 40)
                    .background(Color.appAccent.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.name)
                        .font(.appBody(20, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    Text(agent.role.capitalized + " · " + agent.continuity)
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)
                }
            }
            Text("One identity across your conversations, memory, and delegated work.")
                .font(.appBody(13))
                .foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .background { MissionGlassPlate() }
    }

    @ViewBuilder
    private func profileSection(_ profile: AgentProfile) -> some View {
        let groups: [(String, [String])] = [
            ("Identity", profile.identity),
            ("Work", profile.work),
            ("Relationships", profile.relationships),
            ("Goals", profile.goals),
            ("Context", profile.context)
        ]
        let visible = groups.filter { !$0.1.isEmpty }

        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Profile")
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.offset) { _, group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(group.0)
                                .font(.appBody(11, weight: .semibold))
                                .tracking(0.8)
                                .foregroundStyle(Color.appAccent)
                            ForEach(group.1, id: \.self) { line in
                                Text(line)
                                    .font(.appBody(14))
                                    .foregroundStyle(Color.appInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, 12)
                        if group.0 != visible.last?.0 {
                            MilgrainDivider()
                        }
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        } else {
            emptySection(title: "Profile", text: "Nothing saved yet.")
        }
    }

    @ViewBuilder
    private func preferenceSection(_ preferences: [String: String]) -> some View {
        if !preferences.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Preferences")
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                VStack(spacing: 0) {
                    ForEach(preferences.keys.sorted(), id: \.self) { key in
                        HStack {
                            Text(prettyKey(key))
                                .font(.appBody(14))
                                .foregroundStyle(Color.appInk)
                            Spacer(minLength: 12)
                            Text(preferences[key] ?? "")
                                .font(.appBody(13))
                                .foregroundStyle(Color.appMuted)
                                .multilineTextAlignment(.trailing)
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        }
    }

    @ViewBuilder
    private func goalSection(_ goals: [AgentContextGoal]) -> some View {
        let active = goals.filter { ["pending", "running", "paused", "failed"].contains($0.status.lowercased()) }
        if !active.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Carried forward")
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(active) { goal in
                        HStack(alignment: .top, spacing: 10) {
                            AppIcon(goal.status.lowercased() == "running" ? "bolt" : "dotted", size: 15)
                                .foregroundStyle(Color.appAccent)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(goal.goal)
                                    .font(.appBody(14, weight: .medium))
                                    .foregroundStyle(Color.appInk)
                                Text(goal.status.capitalized + " · " + goal.autonomy + " autonomy")
                                    .font(.appBody(12))
                                    .foregroundStyle(Color.appMuted)
                            }
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        }
    }

    @ViewBuilder
    private func connectedAppsSection(_ apps: [String]) -> some View {
        if !apps.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Connected")
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Text(apps.map { $0.capitalized }.joined(separator: " · "))
                    .font(.appBody(14))
                    .foregroundStyle(Color.appInk)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { MissionGlassPlate() }
            }
        }
    }

    private func emptySection(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.appBody(18, weight: .semibold))
                .foregroundStyle(Color.appInk)
            Text(text)
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
        }
    }

    private func prettyKey(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func load() async {
        do {
            let fetched = try await AgentContextService.fetch()
            await MainActor.run {
                context = fetched
                isLoading = false
                errorMessage = nil
            }
        } catch {
            await MainActor.run {
                isLoading = false
                if context == nil {
                    errorMessage = "Could not load Millie's context."
                }
            }
        }
    }
}

#Preview {
    AgentOSView()
        .environment(AppState())
}
