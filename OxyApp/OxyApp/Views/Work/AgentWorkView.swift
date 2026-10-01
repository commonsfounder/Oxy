import SwiftUI

struct TrustCenterView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var policy: AgentPermissionPolicy?
    @State private var entries: [AgentAuditEntry] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "Privacy and safety", onBack: { dismiss() })

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                        }

                        if isLoading {
                            OxySkeletonCard(height: 170, cornerRadius: 20)
                            OxySkeletonCard(height: 250, cornerRadius: 20)
                        } else if let policy {
                            policySection(policy)
                            auditSection(policy)
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

    private func policySection(_ policy: AgentPermissionPolicy) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Permission policy")
                .font(.appBody(18, weight: .semibold))
                .foregroundStyle(Color.appInk)

            VStack(spacing: 0) {
                policyRow("Read", policy.read.defaultRule, policy.read.description)
                divider
                policyRow("Write", policy.write.defaultRule, policy.write.description)
                divider
                policyRow("Payments", policy.payment.defaultRule, policy.payment.description)
            }
            .padding(.horizontal, 16)
            .background { MissionGlassPlate() }
        }
    }

    private func auditSection(_ policy: AgentPermissionPolicy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Action history")
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Spacer(minLength: 0)
                Text(policy.audit.enabled ? "Enabled" : "Off")
                    .font(.appBody(12, weight: .medium))
                    .foregroundStyle(policy.audit.enabled ? Color.appSuccess : Color.appMuted)
            }

            if entries.isEmpty {
                Text("No actions recorded yet.")
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .padding(.vertical, 8)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(entries) { entry in
                        auditRow(entry)
                        if entry.id != entries.last?.id { divider }
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }

            Text("Undo is available where the connected service supports it.")
                .font(.appBody(12))
                .foregroundStyle(Color.appMuted)
        }
    }

    private func policyRow(_ title: String, _ rule: String, _ description: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Text(description)
                    .font(.appBody(12))
                    .foregroundStyle(Color.appMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 10)
            Text(rule.capitalized)
                .font(.appBody(11, weight: .semibold))
                .foregroundStyle(Color.appAccent)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(Color.appAccent.opacity(0.12), in: Capsule())
        }
        .padding(.vertical, 13)
    }

    private func auditRow(_ entry: AgentAuditEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            AppIcon(entry.status.lowercased() == "executed" ? "check-circle" : "alert-circle", size: 15)
                .foregroundStyle(entry.status.lowercased() == "executed" ? Color.appSuccess : Color.appAccent)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.type.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.appBody(13, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Text(entry.error ?? entry.status.capitalized)
                    .font(.appBody(12))
                    .foregroundStyle(entry.error == nil ? Color.appMuted : Color.appDestructive)
            }
            Spacer(minLength: 0)
            Text(entry.risk.capitalized)
                .font(.appBody(10, weight: .medium))
                .foregroundStyle(Color.appMuted)
        }
        .padding(.vertical, 12)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.appHairline)
            .frame(height: 0.5)
    }

    private func load() async {
        do {
            async let fetchedPolicy = AgentTasksService.fetchPermissionPolicy()
            async let fetchedAudit = AgentTasksService.fetchAudit()
            let (nextPolicy, nextEntries) = try await (fetchedPolicy, fetchedAudit)
            await MainActor.run {
                policy = nextPolicy
                entries = nextEntries
                isLoading = false
                errorMessage = nil
            }
        } catch {
            await MainActor.run {
                isLoading = false
                errorMessage = "Couldn't load this right now."
            }
        }
    }
}

