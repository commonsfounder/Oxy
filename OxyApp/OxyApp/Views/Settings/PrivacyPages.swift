import SwiftUI

/// What Adam has done, loaded once and shared by the privacy page and the full activity page.
@MainActor
@Observable
final class AuditModel {
    var entries: [AgentAuditEntry] = []
    var isLoading = true
    var failed = false

    func load(isDemo: Bool) async {
#if DEBUG
        if isDemo {
            entries = AuditDemo.entries
            isLoading = false
            return
        }
#endif
        do {
            entries = try await AgentTasksService.fetchAudit()
            failed = false
        } catch {
            failed = entries.isEmpty
        }
        isLoading = false
    }

    /// Everything except internal bookkeeping.
    var visible: [AgentAuditEntry] { entries.filter { $0.hidden != true } }

    /// The few worth showing first: things that changed something, then lookups to fill the gap.
    var highlights: [AgentAuditEntry] {
        let important = visible.filter { ($0.kind ?? "") != "looked" }
        let rest = visible.filter { ($0.kind ?? "") == "looked" }
        let chosen = Set((important + rest).prefix(3).map(\.id))
        return visible.filter { chosen.contains($0.id) }
    }
}

// MARK: - Privacy and control

struct PrivacyPage: View {
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme
    @State private var settings = SettingsStore.load()
    @State private var destination: Destination?

    private enum Destination: Identifiable {
        case permissions, activity
        var id: String { "\(self)" }
    }

    private var level: Binding<Double> {
        Binding(
            get: { Double(OxySettings.autonomyLevels.firstIndex(of: OxySettings.normalizedAutonomy(settings.autonomy)) ?? 2) },
            set: { raw in
                let levels = OxySettings.autonomyLevels
                let next = levels[min(max(Int(raw.rounded()), 0), levels.count - 1)]
                guard next != OxySettings.normalizedAutonomy(settings.autonomy) else { return }
                settings.autonomy = next
                SettingsStore.save(settings, userId: appState.userId)
                HapticManager.shared.impact(.light)
            }
        )
    }

    private var levelLine: String {
        switch OxySettings.normalizedAutonomy(settings.autonomy) {
        case "Reactive": return "Waits until you ask"
        case "Reserved": return "Suggests things now and then"
        case "Proactive": return "Looks for useful things to do"
        case "Autonomous": return "Takes care of everyday things"
        default: return "Helpful, not noisy"
        }
    }

    var body: some View {
        SettingsPage(title: "Privacy and control") {
            VStack(alignment: .leading, spacing: 14) {
                SettingsStatement(text: "Looks things up on its own", solid: true)
                SettingsStatement(text: "Asks before messaging people", solid: false)
                SettingsStatement(text: "Always asks before spending money", solid: false)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface(radius: 20)

            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("When Adam steps in")
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                    Text(levelLine)
                        .font(.appBody(13))
                        .foregroundStyle(Color.appAccent)
                }
                Slider(value: level, in: 0...Double(OxySettings.autonomyLevels.count - 1), step: 1)
                    .tint(Color.appAccent)
                    .accessibilityLabel("When Adam steps in")
                    .accessibilityValue(levelLine)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface()

            SettingsList {
                SettingsNavRow(title: "Permissions", subtitle: "What Adam does on its own") { destination = .permissions }
                SettingsRule()
                SettingsNavRow(title: "Activity", subtitle: "What Adam has done for you") { destination = .activity }
            }
        }
        .fullScreenCover(item: $destination, onDismiss: { settings = SettingsStore.load() }) { dest in
            Group {
                switch dest {
                case .permissions: PermissionsPage()
                case .activity: ActivityPage()
                }
            }
            .swipeToDismiss()
            .environment(\.colorScheme, colorScheme)
        }
    }
}

// MARK: - Permissions

struct PermissionsPage: View {
    @Environment(AppState.self) private var appState
    @State private var settings = SettingsStore.load()

    var body: some View {
        SettingsPage(title: "Permissions") {
            SettingsList {
                permission("Look things up for you", answer: "On its own", solid: true)
                SettingsRule(inset: 34)
                permission("Make changes", answer: settings.guardMode ? "Asks first" : "Asks when it matters", solid: false)
                SettingsRule(inset: 34)
                permission("Message people", answer: "Asks first", solid: false)
                SettingsRule(inset: 34)
                permission("Spend money", answer: "Always asks", solid: false)
                SettingsRule(inset: 34)
                permission(
                    "Open private apps",
                    answer: settings.confirmSensitiveAppOpens ? "Asks first" : "On its own",
                    solid: !settings.confirmSensitiveAppOpens
                )
            }

            SettingsGroup(title: "Extra checks") {
                SettingsList {
                    SettingsToggleRow(title: "Ask before every action", subtitle: "Not just payments", isOn: $settings.guardMode)
                    SettingsRule()
                    SettingsToggleRow(title: "Ask before opening private apps", subtitle: "Like banking and health", isOn: $settings.confirmSensitiveAppOpens)
                }
            }
        }
        .onChange(of: settings.guardMode) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
        .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
    }

    private func permission(_ title: String, answer: String, solid: Bool) -> some View {
        SettingsRow(title: title, lead: .dot(solid: solid)) {
            Text(answer)
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
        }
    }
}

// MARK: - Activity

struct ActivityPage: View {
    @Environment(AppState.self) private var appState
    @State private var audit = AuditModel()

    private var shown: [AgentAuditEntry] { audit.visible }

    private var days: [(title: String, entries: [AgentAuditEntry])] {
        let calendar = Calendar.current
        var order: [Date] = []
        var buckets: [Date: [AgentAuditEntry]] = [:]
        for entry in shown {
            let when = entry.createdAt.flatMap(DisplayTimestampParser.date(from:)) ?? .distantPast
            let day = calendar.startOfDay(for: when)
            if buckets[day] == nil { order.append(day) }
            buckets[day, default: []].append(entry)
        }
        return order.map { day in
            let title: String
            if calendar.isDateInToday(day) { title = "Today" }
            else if calendar.isDateInYesterday(day) { title = "Yesterday" }
            else if day == .distantPast { title = "Earlier" }
            else { title = day.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) }
            return (title, buckets[day] ?? [])
        }
    }

    var body: some View {
        SettingsPage(title: "Activity") {
            if audit.failed {
                ErrorBanner(message: "Couldn't load activity.", onRetry: { Task { await audit.load(isDemo: appState.isDemoSession) } })
            } else if audit.isLoading {
                OxySkeletonCard(height: 200, cornerRadius: 16)
            } else if shown.isEmpty {
                Text("Nothing yet.")
                    .font(.appBody(15))
                    .foregroundStyle(Color.appMuted)
            } else {
                ForEach(days, id: \.title) { day in
                    SettingsGroup(title: day.title) {
                        SettingsList {
                            ForEach(Array(day.entries.enumerated()), id: \.element.id) { index, entry in
                                if index > 0 { SettingsRule(inset: 34) }
                                ActivityRow(entry: entry)
                            }
                        }
                    }
                }
            }
        }
        .task { await audit.load(isDemo: appState.isDemoSession) }
    }
}

/// One thing Adam did, in a sentence, with how it ended. A ring means you approved it first.
struct ActivityRow: View {
    let entry: AgentAuditEntry

    private var failed: Bool { entry.status.lowercased() != "executed" }

    var body: some View {
        SettingsRow(title: title, subtitle: detail, lead: .dot(solid: !entry.reviewRequired))
            .accessibilityElement(children: .combine)
    }

    private var title: String {
        if let summary = entry.summary, !summary.isEmpty { return summary }
        let spaced = entry.type.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }

    private var detail: String {
        var parts: [String] = []
        if let when = entry.createdAt.flatMap(DisplayTimestampParser.date(from:)) {
            if Date().timeIntervalSince(when) < 60 {
                parts.append("Just now")
            } else {
                let formatter = RelativeDateTimeFormatter()
                formatter.unitsStyle = .full
                parts.append(formatter.localizedString(for: when, relativeTo: Date()))
            }
        }
        if failed {
            parts.append("Didn't go through")
        } else if (entry.kind ?? "") == "looked" {
            parts.append("Nothing changed")
        } else if entry.reviewRequired {
            parts.append("Approved by you")
        } else {
            parts.append("Done for you")
        }
        if entry.usedLocation == true { parts.append("Used your location") }
        return parts.joined(separator: " · ")
    }
}

#if DEBUG
enum AuditDemo {
    private static func entry(_ type: String, _ summary: String, kind: String, review: Bool = false, location: Bool = false, minutesAgo: Double) -> AgentAuditEntry {
        let when = Date().addingTimeInterval(-minutesAgo * 60)
        return AgentAuditEntry(
            type: type, status: "executed", error: nil,
            createdAt: ISO8601DateFormatter().string(from: when),
            risk: review ? "high" : "low", executionMode: review ? "review" : "direct",
            reviewRequired: review, undo: nil,
            summary: summary, kind: kind, usedLocation: location, hidden: false
        )
    }

    static let entries: [AgentAuditEntry] = [
        entry("send_message", "Messaged Sarah", kind: "sent", review: true, minutesAgo: 180),
        entry("web_search", "Searched for replacement AirPods cases", kind: "looked", minutesAgo: 190),
        entry("find_place", "Looked for electronics shops", kind: "looked", location: true, minutesAgo: 60 * 30),
        entry("create_calendar_event", "Added “Dinner with Sarah” to your calendar", kind: "did", review: true, minutesAgo: 60 * 31),
        entry("get_calendar_events", "Checked your calendar", kind: "looked", minutesAgo: 60 * 52)
    ]
}
#endif
