import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var settings = OxySettings()
    @State private var showSignOutConfirm = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 24) {
                        // Identity
                        settingsSection(title: "Identity") {
                            settingRow(label: "Assistant Name", description: nil) {
                                TextField("Oxy", text: $settings.name)
                                    .font(.system(size: 15))
                                    .foregroundStyle(Color.oxyText)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 120)
                                    .onChange(of: settings.name) { _, _ in saveSettings() }
                            }
                        }

                        // Voice
                        settingsSection(title: "Voice") {
                            settingRow(label: "Voice Playback", description: "Generate audio for responses") {
                                Toggle("", isOn: $settings.voiceOn)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.voiceOn) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Voice Engine", description: nil) {
                                Picker("", selection: $settings.voiceEngine) {
                                    Text("Current").tag("current")
                                    Text("Gemini Live").tag("gemini-live-prototype")
                                }
                                .pickerStyle(.segmented)
                                .frame(width: 200)
                                .onChange(of: settings.voiceEngine) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            VStack(alignment: .leading, spacing: 10) {
                                Text("Gemini Voice")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Color.oxyText)

                                Text("Choose the voice used for spoken replies")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.oxySub)

                                LazyVGrid(columns: [
                                    GridItem(.flexible()),
                                    GridItem(.flexible()),
                                    GridItem(.flexible())
                                ], spacing: 8) {
                                    ForEach(OxySettings.voiceOptions, id: \.value) { voice in
                                        VoiceChip(
                                            label: voice.label,
                                            isSelected: settings.voice == voice.value,
                                            onTap: {
                                                settings.voice = voice.value
                                                saveSettings()
                                            }
                                        )
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }

                        // Autonomy
                        settingsSection(title: "Autonomy") {
                            settingRow(label: "Initiative Level", description: "How often Oxy proactively reaches out") {
                                HStack(spacing: 6) {
                                    ForEach(["Low", "Medium", "High"], id: \.self) { level in
                                        Button(action: {
                                            settings.autonomy = level
                                            saveSettings()
                                        }) {
                                            Text(level)
                                                .font(.system(size: 12, weight: .medium))
                                                .foregroundStyle(
                                                    settings.autonomy == level
                                                        ? Color.oxyBg
                                                        : Color.oxySub
                                                )
                                                .padding(.horizontal, 12)
                                                .padding(.vertical, 7)
                                                .background(
                                                    settings.autonomy == level
                                                        ? Color.oxyStone
                                                        : Color.oxySurface3
                                                )
                                                .clipShape(Capsule())
                                        }
                                    }
                                }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Briefings", description: "Wake, midday, and evening proactive updates") {
                                Toggle("", isOn: $settings.proactiveBriefings)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.proactiveBriefings) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Health Alerts", description: "Use HealthKit summaries for useful checks") {
                                Toggle("", isOn: $settings.healthAlerts)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.healthAlerts) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Location Reminders", description: "Food and context nudges near important places") {
                                Toggle("", isOn: $settings.locationReminders)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.locationReminders) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            Button {
                                Task {
                                    await NativeIntegrationManager.shared.requestNativePermissions(userId: appState.userId)
                                }
                            } label: {
                                HStack {
                                    Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                                    Text("Enable Native Context")
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.oxyDim)
                                }
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyText)
                                .padding(.vertical, 4)
                            }

                            Divider().overlay(Color.oxyLine)

                            Button {
                                Task {
                                    await NativeIntegrationManager.shared.markCurrentLocationAsHome(userId: appState.userId)
                                    await MainActor.run { loadSettings() }
                                }
                            } label: {
                                HStack {
                                    Image(systemName: "house.and.flag.fill")
                                    Text("Set Current Location as Home")
                                    Spacer()
                                    Image(systemName: settings.homeLatitude == nil ? "location" : "checkmark.circle.fill")
                                        .foregroundStyle(settings.homeLatitude == nil ? Color.oxyDim : Color.oxyGreen)
                                }
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyText)
                                .padding(.vertical, 4)
                            }
                        }

                        // Account
                        settingsSection(title: "Account") {
                            Button(action: { showSignOutConfirm = true }) {
                                HStack {
                                    Image(systemName: "rectangle.portrait.and.arrow.right")
                                        .font(.system(size: 14))
                                    Text("Sign Out")
                                        .font(.system(size: 15, weight: .medium))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.oxyDim)
                                }
                                .foregroundStyle(Color.oxyRed)
                                .padding(.vertical, 4)
                            }
                        }

                        // App info
                        VStack(spacing: 4) {
                            Text("Oxy")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.oxyDim)
                            Text("Wearable AI")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(Color.oxyDim)
                                .tracking(1)
                                .textCase(.uppercase)
                        }
                        .padding(.top, 8)
                        .padding(.bottom, 32)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .alert("Sign Out", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
            .onAppear { loadSettings() }
        }
    }

    // MARK: - Helpers

    private func settingsSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)

            VStack(spacing: 0) {
                content()
            }
            .padding(16)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
        }
    }

    private func settingRow<Accessory: View>(
        label: String,
        description: String?,
        @ViewBuilder accessory: () -> Accessory
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                if let description {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)
                }
            }
            Spacer()
            accessory()
        }
        .padding(.vertical, 4)
    }

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
    }

    private func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
        Task {
            await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        }
    }
}

// MARK: - Voice Chip

private struct VoiceChip: View {
    let label: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isSelected ? Color.oxyBg : Color.oxySub)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(isSelected ? Color.oxyStone : Color.oxySurface3)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(isSelected ? Color.clear : Color.oxyLine2, lineWidth: 1)
                )
        }
    }
}

// MARK: - Settings Model

struct OxySettings: Codable {
    var name: String = "Oxy"
    var voice: String = "Aoede"
    var voiceOn: Bool = true
    var voiceEngine: String = "current"
    var autonomy: String = "Medium"
    var proactiveBriefings: Bool = true
    var healthAlerts: Bool = true
    var locationReminders: Bool = true
    var homeLatitude: Double?
    var homeLongitude: Double?

    struct VoiceOption: Identifiable {
        let value: String
        let label: String
        var id: String { value }
    }

    static let voiceOptions: [VoiceOption] = [
        VoiceOption(value: "Aoede", label: "Breezy"),
        VoiceOption(value: "Achernar", label: "Soft"),
        VoiceOption(value: "Achird", label: "Friendly"),
        VoiceOption(value: "Algenib", label: "Gravelly"),
        VoiceOption(value: "Algieba", label: "Smooth"),
        VoiceOption(value: "Alnilam", label: "Firm"),
        VoiceOption(value: "Autonoe", label: "Bright"),
        VoiceOption(value: "Callirrhoe", label: "Easy-going"),
        VoiceOption(value: "Charon", label: "Informative"),
        VoiceOption(value: "Despina", label: "Polished"),
        VoiceOption(value: "Enceladus", label: "Breathy"),
        VoiceOption(value: "Erinome", label: "Clear"),
        VoiceOption(value: "Fenrir", label: "Excitable"),
        VoiceOption(value: "Gacrux", label: "Mature"),
        VoiceOption(value: "Iapetus", label: "Measured"),
        VoiceOption(value: "Kore", label: "Stoic"),
        VoiceOption(value: "Laomedeia", label: "Upbeat"),
        VoiceOption(value: "Leda", label: "Youthful"),
        VoiceOption(value: "Orus", label: "Grounded"),
        VoiceOption(value: "Puck", label: "Playful"),
        VoiceOption(value: "Pulcherrima", label: "Forward"),
        VoiceOption(value: "Rasalgethi", label: "Guide"),
        VoiceOption(value: "Sadachbia", label: "Lively"),
        VoiceOption(value: "Sadaltager", label: "Wise"),
        VoiceOption(value: "Schedar", label: "Even"),
        VoiceOption(value: "Sulafat", label: "Warm"),
        VoiceOption(value: "Umbriel", label: "Relaxed"),
        VoiceOption(value: "Vindemiatrix", label: "Gentle"),
        VoiceOption(value: "Zephyr", label: "Spark"),
        VoiceOption(value: "Zubenelgenubi", label: "Casual"),
    ]
}

#Preview {
    SettingsView()
        .environment(AppState())
}
