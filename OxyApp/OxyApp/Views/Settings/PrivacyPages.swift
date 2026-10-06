import SwiftUI

/// How much Adam does on its own: five steps, one line saying what the current step means.
struct AutonomyDial: View {
    @Environment(AppState.self) private var appState
    @State private var settings = SettingsStore.load()

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
