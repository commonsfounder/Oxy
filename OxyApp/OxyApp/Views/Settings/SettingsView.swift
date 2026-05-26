import AVFoundation
import Contacts
import CoreLocation
import EventKit
import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var settings = OxySettings()
    @State private var showSignOutConfirm = false
    @State private var voicePreview = VoicePreviewPlayer()
    @State private var showAdvanced = false
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        // Identity
                        settingsSection(title: "Profile") {
                            settingRow(label: "Assistant Name", description: nil) {
                                TextField("Oxy", text: $settings.name)
                                    .font(.system(size: 15))
                                    .foregroundStyle(Color.oxyText)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 120)
                                    .onChange(of: settings.name) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Appearance") {
                            settingRow(label: "Accent", description: selectedAccentLabel) {
                                HStack(spacing: 8) {
                                    ForEach(OxySettings.accentOptions, id: \.value) { option in
                                        Button {
                                            settings.accentColor = option.value
                                            saveSettings()
                                        } label: {
                                            Circle()
                                                .fill(option.color)
                                                .frame(width: 28, height: 28)
                                                .overlay(
                                                    Circle()
                                                        .stroke(settings.accentColor == option.value ? Color.oxyText : Color.clear, lineWidth: 2)
                                                )
                                        }
                                        .accessibilityLabel(option.label)
                                    }
                                }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Theme", description: "Chat surface") {
                                Picker("Theme", selection: $settings.appTheme) {
                                    Text("True Black").tag("trueBlack")
                                    Text("Soft Dark").tag("softDark")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.appTheme) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Bubbles", description: "Message density") {
                                Picker("Bubbles", selection: $settings.bubbleStyle) {
                                    Text("Comfort").tag("comfort")
                                    Text("Compact").tag("compact")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.bubbleStyle) { _, _ in saveSettings() }
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

                            settingRow(label: "Voice", description: selectedVoiceLabel) {
                                Picker("Voice", selection: $settings.voice) {
                                    ForEach(OxySettings.voiceOptions, id: \.value) { voice in
                                        Text(voice.label).tag(voice.value)
                                    }
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.voice) { _, newVoice in
                                    saveSettings()
                                    previewVoice(newVoice)
                                }
                            }

                            Divider().overlay(Color.oxyLine)

                            Button {
                                previewVoice(settings.voice)
                            } label: {
                                HStack {
                                    Image(systemName: voicePreview.isPlaying ? "waveform" : "play.fill")
                                    Text(voicePreview.isPlaying ? "Playing Preview" : "Play Preview")
                                    Spacer()
                                    if voicePreview.isLoading {
                                        ProgressView()
                                            .controlSize(.small)
                                    }
                                }
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyText)
                                .padding(.vertical, 4)
                            }
                        }

                        // Autonomy
                        settingsSection(title: "Behaviour") {
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

                            settingRow(label: "Proactive Briefings", description: "Wake, midday, and evening updates") {
                                Toggle("", isOn: $settings.proactiveBriefings)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.proactiveBriefings) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Action Defaults") {
                            settingRow(label: "Preferred Maps", description: "Used for directions links") {
                                Picker("Preferred Maps", selection: $settings.preferredMapsApp) {
                                    Text("Apple Maps").tag("apple")
                                    Text("Google Maps").tag("google")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.preferredMapsApp) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Transport", description: "Default route mode") {
                                Picker("Transport", selection: $settings.preferredTransportMode) {
                                    Text("Driving").tag("driving")
                                    Text("Transit").tag("transit")
                                    Text("Walking").tag("walking")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.preferredTransportMode) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Review App Opens", description: "Ask before opening Maps/Uber-style links") {
                                Toggle("", isOn: $settings.reviewBeforeOpeningApps)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.reviewBeforeOpeningApps) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Apple") {
                            VStack(spacing: 0) {
                                PermissionStatusRow(label: "Location", systemImage: "location.fill", state: locationPermissionLabel)
                                Divider().overlay(Color.oxyLine)
                                PermissionStatusRow(label: "Contacts", systemImage: "person.crop.circle.fill", state: contactsPermissionLabel)
                                Divider().overlay(Color.oxyLine)
                                PermissionStatusRow(label: "Calendar", systemImage: "calendar", state: calendarPermissionLabel)
                                Divider().overlay(Color.oxyLine)
                                PermissionStatusRow(label: "Reminders", systemImage: "bell.fill", state: remindersPermissionLabel)
                                Divider().overlay(Color.oxyLine)
                                PermissionStatusRow(label: "Notifications", systemImage: "app.badge.fill", state: notificationPermissionLabel)
                            }

                            Divider().overlay(Color.oxyLine)

                            Button {
                                Task {
                                    await NativeIntegrationManager.shared.requestNativePermissions(userId: appState.userId)
                                    await refreshPermissionStatus()
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

                        settingsSection(title: "Advanced") {
                            DisclosureGroup(isExpanded: $showAdvanced) {
                                VStack(spacing: 0) {
                                    Divider().overlay(Color.oxyLine)

                                    settingRow(label: "Voice Engine", description: nil) {
                                        Picker("", selection: $settings.voiceEngine) {
                                            Text("Current").tag("current")
                                            Text("Gemini Live").tag("gemini-live-prototype")
                                        }
                                        .pickerStyle(.menu)
                                        .tint(Color.oxyStone)
                                        .onChange(of: settings.voiceEngine) { _, _ in saveSettings() }
                                    }

                                    Divider().overlay(Color.oxyLine)

                                    settingRow(label: "Health Alerts", description: "Use HealthKit summaries for checks") {
                                        Toggle("", isOn: $settings.healthAlerts)
                                            .labelsHidden()
                                            .tint(Color.oxyGreen)
                                            .onChange(of: settings.healthAlerts) { _, _ in saveSettings() }
                                    }

                                    Divider().overlay(Color.oxyLine)

                                    settingRow(label: "Location Reminders", description: "Context nudges near important places") {
                                        Toggle("", isOn: $settings.locationReminders)
                                            .labelsHidden()
                                            .tint(Color.oxyGreen)
                                            .onChange(of: settings.locationReminders) { _, _ in saveSettings() }
                                    }

                                    Divider().overlay(Color.oxyLine)

                                    DesignPreview(
                                        template: settings.designTemplate,
                                        palette: settings.designPalette,
                                        motion: settings.designMotion
                                    )
                                    .padding(.top, 14)

                                    DesignChoiceGroup(
                                        title: "Template",
                                        selection: $settings.designTemplate,
                                        options: OxySettings.designTemplates,
                                        onChange: saveSettings
                                    )
                                    .padding(.top, 16)

                                    Divider().overlay(Color.oxyLine).padding(.vertical, 10)

                                    DesignChoiceGroup(
                                        title: "Palette",
                                        selection: $settings.designPalette,
                                        options: OxySettings.designPalettes,
                                        onChange: saveSettings
                                    )

                                    Divider().overlay(Color.oxyLine).padding(.vertical, 10)

                                    DesignChoiceGroup(
                                        title: "Motion",
                                        selection: $settings.designMotion,
                                        options: OxySettings.designMotions,
                                        onChange: saveSettings
                                    )
                                }
                                .padding(.top, 10)
                            } label: {
                                HStack {
                                    Image(systemName: "slider.horizontal.3")
                                    Text("Developer and visual tuning")
                                    Spacer()
                                }
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyText)
                            }
                            .tint(Color.oxySub)
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
            .onAppear {
                loadSettings()
                Task { await refreshPermissionStatus() }
            }
        }
    }

    // MARK: - Helpers

    private var selectedVoiceLabel: String {
        OxySettings.voiceOptions.first(where: { $0.value == settings.voice })?.label ?? settings.voice
    }

    private var selectedAccentLabel: String {
        OxySettings.accentOptions.first(where: { $0.value == settings.accentColor })?.label ?? "Stone"
    }

    private var locationPermissionLabel: PermissionState {
        switch LocationManager.shared.authorizationStatus {
        case .authorizedAlways: return .good("Always")
        case .authorizedWhenInUse: return .good("While Using")
        case .denied, .restricted: return .blocked("Off")
        default: return .needsSetup("Ask")
        }
    }

    private var contactsPermissionLabel: PermissionState {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .good("On")
        case .denied, .restricted: return .blocked("Off")
        default: return .needsSetup("Ask")
        }
    }

    private var calendarPermissionLabel: PermissionState {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            if status == .fullAccess || status == .writeOnly { return .good("On") }
        } else if status == .authorized {
            return .good("On")
        }
        return status == .denied || status == .restricted ? .blocked("Off") : .needsSetup("Ask")
    }

    private var remindersPermissionLabel: PermissionState {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        if #available(iOS 17.0, *) {
            if status == .fullAccess || status == .writeOnly { return .good("On") }
        } else if status == .authorized {
            return .good("On")
        }
        return status == .denied || status == .restricted ? .blocked("Off") : .needsSetup("Ask")
    }

    private var notificationPermissionLabel: PermissionState {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral: return .good("On")
        case .denied: return .blocked("Off")
        default: return .needsSetup("Ask")
        }
    }

    private func previewVoice(_ voice: String) {
        Task {
            await voicePreview.preview(voice: voice)
        }
    }

    private func refreshPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationStatus = settings.authorizationStatus
    }

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

// MARK: - Voice Preview

@Observable
@MainActor
private final class VoicePreviewPlayer: NSObject, AVAudioPlayerDelegate {
    var isLoading = false
    var isPlaying = false
    private var player: AVAudioPlayer?

    func preview(voice: String) async {
        isLoading = true
        isPlaying = false
        player?.stop()

        do {
            let data = try await APIClient.shared.request(
                path: "/tts-preview",
                method: "POST",
                body: [
                    "voice": voice,
                    "text": "Hey, I am Oxy. This is how I sound."
                ]
            )
            let response = try JSONDecoder().decode(TTSPreviewResponse.self, from: data)
            guard let audioData = Data(base64Encoded: response.audio) else {
                isLoading = false
                return
            }
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try audioSession.setActive(true)
            let nextPlayer = try AVAudioPlayer(data: audioData)
            nextPlayer.delegate = self
            nextPlayer.prepareToPlay()
            player = nextPlayer
            isLoading = false
            isPlaying = nextPlayer.play()
        } catch {
            isLoading = false
            isPlaying = false
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
        }
    }
}

private struct TTSPreviewResponse: Codable {
    let audio: String
}

// MARK: - Permissions

private enum PermissionState: Equatable {
    case good(String)
    case needsSetup(String)
    case blocked(String)

    var text: String {
        switch self {
        case .good(let text), .needsSetup(let text), .blocked(let text): return text
        }
    }

    var color: Color {
        switch self {
        case .good: return Color.oxyGreen
        case .needsSetup: return Color.oxyStone
        case .blocked: return Color.oxyRed
        }
    }

    var icon: String {
        switch self {
        case .good: return "checkmark.circle.fill"
        case .needsSetup: return "circle.dashed"
        case .blocked: return "xmark.circle.fill"
        }
    }
}

private struct PermissionStatusRow: View {
    let label: String
    let systemImage: String
    let state: PermissionState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .frame(width: 20)
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.oxyText)
            Spacer()
            Label(state.text, systemImage: state.icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(state.color)
        }
        .padding(.vertical, 8)
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
    var designTemplate: String = "compact"
    var designPalette: String = "stone"
    var designMotion: String = "calm"
    var accentColor: String = "stone"
    var appTheme: String = "trueBlack"
    var bubbleStyle: String = "comfort"
    var preferredMapsApp: String = "apple"
    var preferredTransportMode: String = "driving"
    var reviewBeforeOpeningApps: Bool = false

    enum CodingKeys: String, CodingKey {
        case name, voice, voiceOn, voiceEngine, autonomy, proactiveBriefings, healthAlerts, locationReminders
        case homeLatitude, homeLongitude, designTemplate, designPalette, designMotion
        case accentColor, appTheme, bubbleStyle, preferredMapsApp, preferredTransportMode, reviewBeforeOpeningApps
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Oxy"
        voice = try container.decodeIfPresent(String.self, forKey: .voice) ?? "Aoede"
        voiceOn = try container.decodeIfPresent(Bool.self, forKey: .voiceOn) ?? true
        voiceEngine = try container.decodeIfPresent(String.self, forKey: .voiceEngine) ?? "current"
        autonomy = try container.decodeIfPresent(String.self, forKey: .autonomy) ?? "Medium"
        proactiveBriefings = try container.decodeIfPresent(Bool.self, forKey: .proactiveBriefings) ?? true
        healthAlerts = try container.decodeIfPresent(Bool.self, forKey: .healthAlerts) ?? true
        locationReminders = try container.decodeIfPresent(Bool.self, forKey: .locationReminders) ?? true
        homeLatitude = try container.decodeIfPresent(Double.self, forKey: .homeLatitude)
        homeLongitude = try container.decodeIfPresent(Double.self, forKey: .homeLongitude)
        designTemplate = try container.decodeIfPresent(String.self, forKey: .designTemplate) ?? "compact"
        designPalette = try container.decodeIfPresent(String.self, forKey: .designPalette) ?? "stone"
        designMotion = try container.decodeIfPresent(String.self, forKey: .designMotion) ?? "calm"
        accentColor = try container.decodeIfPresent(String.self, forKey: .accentColor) ?? designPalette
        appTheme = try container.decodeIfPresent(String.self, forKey: .appTheme) ?? "trueBlack"
        bubbleStyle = try container.decodeIfPresent(String.self, forKey: .bubbleStyle) ?? "comfort"
        preferredMapsApp = try container.decodeIfPresent(String.self, forKey: .preferredMapsApp) ?? "apple"
        preferredTransportMode = try container.decodeIfPresent(String.self, forKey: .preferredTransportMode) ?? "driving"
        reviewBeforeOpeningApps = try container.decodeIfPresent(Bool.self, forKey: .reviewBeforeOpeningApps) ?? false
    }

    struct VoiceOption: Identifiable {
        let value: String
        let label: String
        var id: String { value }
    }

    struct AccentOption: Identifiable {
        let value: String
        let label: String
        let color: Color
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

    static let designTemplates = ["compact", "glass", "dense"]
    static let designPalettes = ["stone", "mint", "ember", "mono"]
    static let designMotions = ["calm", "snappy", "none"]
    static let accentOptions = [
        AccentOption(value: "stone", label: "Stone", color: Color.oxyDefaultStone),
        AccentOption(value: "mint", label: "Mint", color: Color.oxyGreen),
        AccentOption(value: "blue", label: "Blue", color: Color(red: 92/255, green: 154/255, blue: 245/255)),
        AccentOption(value: "rose", label: "Rose", color: Color(red: 230/255, green: 124/255, blue: 154/255)),
        AccentOption(value: "violet", label: "Violet", color: Color(red: 162/255, green: 132/255, blue: 245/255)),
        AccentOption(value: "mono", label: "Mono", color: Color.oxyText)
    ]
}

// MARK: - Appearance Lab

private struct DesignChoiceGroup: View {
    let title: String
    @Binding var selection: String
    let options: [String]
    let onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxyText)

            HStack(spacing: 8) {
                ForEach(options, id: \.self) { option in
                    Button {
                        withAnimation(animation) {
                            selection = option
                            onChange()
                        }
                    } label: {
                        Text(option.capitalized)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(selection == option ? Color.oxyBg : Color.oxySub)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(selection == option ? Color.oxyStone : Color.oxySurface3)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(selection == option ? Color.clear : Color.oxyLine2, lineWidth: 1)
                            )
                    }
                }
            }
        }
    }

    private var animation: Animation? {
        selection == "none" ? nil : .easeInOut(duration: 0.18)
    }
}

private struct DesignPreview: View {
    let template: String
    let palette: String
    let motion: String

    private var accent: Color {
        switch palette {
        case "mint": return Color.oxyGreen
        case "ember": return Color.oxyRed
        case "mono": return Color.oxyText
        default: return Color.oxyStone
        }
    }

    private var cornerRadius: CGFloat {
        switch template {
        case "dense": return 8
        case "glass": return 18
        default: return 12
        }
    }

    private var rowSpacing: CGFloat {
        template == "dense" ? 8 : 12
    }

    var body: some View {
        VStack(alignment: .leading, spacing: rowSpacing) {
            HStack {
                Circle()
                    .fill(accent.opacity(0.18))
                    .frame(width: 34, height: 34)
                    .overlay(
                        Image(systemName: "waveform")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(accent)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Oxy")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.oxyText)
                    Text("Online")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.oxySub)
                }

                Spacer()

                Text(motion.capitalized)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(accent)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(accent.opacity(0.12))
                    .clipShape(Capsule())
            }

            Text("I found the nearest McDonald's and opened Uber. Confirm in Uber.")
                .font(.system(size: template == "dense" ? 13 : 14, weight: .medium))
                .foregroundStyle(Color.oxyText)
                .padding(template == "dense" ? 10 : 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(template == "glass" ? Color.oxySurface3.opacity(0.72) : Color.oxySurface3)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius))

            HStack(spacing: 8) {
                previewChip("Connectors", selected: true)
                previewChip("Memory", selected: false)
                previewChip("Settings", selected: false)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: cornerRadius + 4)
                .fill(template == "glass" ? Color.oxySurface2.opacity(0.72) : Color.oxySurface2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius + 4)
                .stroke(accent.opacity(template == "mono" ? 0.18 : 0.32), lineWidth: 1)
        )
        .animation(motion == "none" ? nil : .easeInOut(duration: motion == "snappy" ? 0.12 : 0.28), value: template)
        .animation(motion == "none" ? nil : .easeInOut(duration: motion == "snappy" ? 0.12 : 0.28), value: palette)
    }

    private func previewChip(_ label: String, selected: Bool) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(selected ? Color.oxyBg : Color.oxySub)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(selected ? accent : Color.oxySurface3)
            .clipShape(Capsule())
    }
}

#Preview {
    SettingsView()
        .environment(AppState())
}
