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
                    .foregroundStyle(Color.appMuted)
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

/// What Adam may do on its own. Sits inline on the Settings screen.
struct PrivacyContent: View {
    @Environment(AppState.self) private var appState
    @State private var settings = SettingsStore.load()
    @AppStorage(PhotoLearner.enabledKey) private var photoLearningEnabled = false
    @State private var photoAccessDenied = false
    @State private var confirmsForgetPhotos = false
    @State private var photoStatus = UserDefaults.standard.string(forKey: PhotoLearner.statusKey) ?? "Not scanned yet."
    @State private var isScanning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            AutonomyDial()

            SettingsGroup(title: "What Adam may do") {
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
            }

            SettingsGroup(title: "Extra checks") {
                SettingsList {
                    SettingsToggleRow(title: "Ask before every action", subtitle: "Not just payments", isOn: $settings.guardMode)
                    SettingsRule()
                    SettingsToggleRow(title: "Ask before opening private apps", subtitle: "Like banking and health", isOn: $settings.confirmSensitiveAppOpens)
                }
            }

            SettingsGroup(title: "Photos") {
                SettingsList {
                    SettingsToggleRow(
                        title: "Learn from my photos",
                        subtitle: "Adam reads your photos on this iPhone and remembers short notes. The pictures never leave your phone",
                        isOn: $photoLearningEnabled
                    )
                    if photoLearningEnabled {
                        SettingsRule()
                        SettingsRow(title: "Scan now", subtitle: isScanning ? "Looking through your photos…" : photoStatus, action: {
                            guard !isScanning else { return }
                            isScanning = true
                            Task {
                                await PhotoLearner.shared.run()
                                photoStatus = UserDefaults.standard.string(forKey: PhotoLearner.statusKey) ?? "Done."
                                isScanning = false
                            }
                        })
                        SettingsRule()
                        SettingsNavRow(title: "Forget what Adam learned from photos") { confirmsForgetPhotos = true }
                    }
                }
                if photoAccessDenied {
                    Text("Allow photo access in the Settings app, then switch this on again.")
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)
                }
            }
        }
        .onChange(of: photoLearningEnabled) { _, enabled in
            guard enabled else { return }
            Task {
                if await PhotoLearner.shared.requestAccess() {
                    photoAccessDenied = false
                    await PhotoLearner.shared.run()
                } else {
                    photoLearningEnabled = false
                    photoAccessDenied = true
                }
            }
        }
        .confirmationDialog("Forget what Adam learned from your photos?", isPresented: $confirmsForgetPhotos, titleVisibility: .visible) {
            Button("Forget it all", role: .destructive) {
                Task { await PhotoLearner.shared.forgetEverything() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The notes are deleted. Your photos are not touched.")
        }
        .onChange(of: settings.guardMode) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
        .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
    }

    private func permission(_ title: String, answer: String, solid: Bool) -> some View {
        SettingsRow(title: title, lead: .dot(solid: solid)) {
            Text(answer)
                .font(.appBody(13))
                .foregroundStyle(Color.appMuted.opacity(0.85))
        }
    }
}
