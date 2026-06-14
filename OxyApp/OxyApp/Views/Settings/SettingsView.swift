import AVFoundation
import SwiftUI
import UIKit

/// Cross-cutting app preferences only. Identity and account actions live in
/// Profile, memory in the Memory screen, and pendant pairing on the Pendant
/// screen — Settings used to duplicate all three.
struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @AppStorage("oxy_appTheme") private var appTheme = "soft"
    @State private var settings = OxySettings()
    @State private var showBackendURLEditor = false
    @State private var versionTapCount = 0
    @State private var voicePreview = VoicePreviewPlayer()
    @State private var backendVersionText = "Checking backend..."
    @AppStorage("oxy_custom_backend_url") private var customBackendURL = ""
    @AppStorage("oxy_theme_profile") private var themeProfile = "titanium"

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Settings", onBack: { dismiss() })
                    ScrollView {
                    VStack(spacing: 36) {
                        settingsSection(title: "Appearance") {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("Finish")
                                    .font(.system(size: 16, weight: .regular))
                                    .foregroundStyle(Color.nmlInk)
                                Text("Choose the metal. The whole app takes on its shine.")
                                    .font(.system(size: 13, weight: .regular))
                                    .foregroundStyle(Color.nmlMuted)
                                HStack(spacing: 14) {
                                    ForEach(OxyTheme.profiles) { profile in
                                        finishSwatch(profile)
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                            .padding(.vertical, 6)

                            NamelessDivider()

                            settingRow(label: "Daylight", description: "Soft, light canvas for daytime wear") {
                                NamelessToggle(isOn: Binding(
                                    get: { appTheme != "dark" },
                                    set: { appTheme = $0 ? "soft" : "dark"; HapticManager.shared.impact(.light) }
                                ))
                            }

                            NamelessDivider()

                            settingRow(label: "Bubbles", description: nil) {
                                Picker("Bubbles", selection: $settings.bubbleStyle) {
                                    Text("Comfort").tag("comfort")
                                    Text("Compact").tag("compact")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.nmlTitanium)
                                .onChange(of: settings.bubbleStyle) { _, _ in saveSettings() }
                            }
                        }

                        // Voice
                        settingsSection(title: "Voice") {
                            settingRow(label: "Voice Replies", description: nil) {
                                NamelessToggle(isOn: $settings.voiceOn)
                                    .onChange(of: settings.voiceOn) { _, _ in saveSettings() }
                            }

                            NamelessDivider()

                            voicePickerRow
                        }

                        // Autonomy
                        settingsSection(title: "Assistant") {
                            InitiativeScroller(selection: $settings.autonomy, onChange: saveSettings)

                            NamelessDivider()

                            settingRow(label: "Briefings", description: nil) {
                                NamelessToggle(isOn: $settings.proactiveBriefings)
                                    .onChange(of: settings.proactiveBriefings) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Action Defaults") {
                            settingRow(label: "Preferred Maps", description: nil) {
                                Picker("Preferred Maps", selection: $settings.preferredMapsApp) {
                                    Text("Apple Maps").tag("apple")
                                    Text("Google Maps").tag("google")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.nmlTitanium)
                                .onChange(of: settings.preferredMapsApp) { _, _ in saveSettings() }
                            }

                            NamelessDivider()

                            settingRow(label: "Transport", description: nil) {
                                Picker("Transport", selection: $settings.preferredTransportMode) {
                                    Text("Driving").tag("driving")
                                    Text("Transit").tag("transit")
                                    Text("Walking").tag("walking")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.nmlTitanium)
                                .onChange(of: settings.preferredTransportMode) { _, _ in saveSettings() }
                            }

                            NamelessDivider()

                            settingRow(label: "Confirm Sensitive Apps", description: nil) {
                                NamelessToggle(isOn: $settings.confirmSensitiveAppOpens)
                                    .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "About") {
                            legalLink(label: "Support", path: "/support")
                            NamelessDivider()
                            legalLink(label: "Privacy Policy", path: "/privacy")
                            NamelessDivider()
                            legalLink(label: "Terms of Use", path: "/terms")
                            NamelessDivider()
                            Button(action: handleVersionTap) {
                                HStack {
                                    Text("Version")
                                        .font(.system(size: 15, weight: .regular))
                                        .foregroundStyle(Color.nmlInk)
                                    Spacer()
                                    Text(backendVersionText)
                                        .font(.nmlMono(11))
                                        .foregroundStyle(Color.nmlMuted)
                                        .lineLimit(1)
                                }
                                .padding(.vertical, 16)
                            }
                            .buttonStyle(.plain)
                        }

                        Spacer().frame(height: 32)
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showBackendURLEditor) {
                BackendURLEditorSheet(currentURL: $customBackendURL) {
                    showBackendURLEditor = false
                    loadBackendVersion()
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .onAppear {
                loadSettings()
                loadBackendVersion()
            }
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.startLocation.x < 60, value.translation.width > 80 {
                            dismiss()
                        }
                    }
            )
        }
    }

    // MARK: - Helpers

    private var selectedVoiceLabel: String {
        OxySettings.voiceOptions.first(where: { $0.value == settings.voice })?.label ?? settings.voice
    }

    private var currentFinishName: String {
        OxyTheme.profiles.first(where: { $0.id == themeProfile })?.name ?? "Sterling Silver"
    }

    /// A live jewelry swatch: the finish's own metal gradient, with its name and a
    /// ring when selected. Tapping it re-skins the whole app.
    private func finishSwatch(_ profile: OxyThemeProfile) -> some View {
        let selected = themeProfile == profile.id
        return Button {
            themeProfile = profile.id
            HapticManager.shared.impact(.light)
        } label: {
            VStack(spacing: 8) {
                Circle()
                    .fill(profile.metal)
                    .frame(width: 52, height: 52)
                    .overlay(
                        Circle().strokeBorder(Color.nmlInk, lineWidth: selected ? 2 : 0)
                            .padding(-4)
                    )
                    .shadow(color: profile.glow.opacity(selected ? 0.5 : 0.25), radius: selected ? 10 : 5, y: 3)
                Text(profile.name)
                    .font(.system(size: 11, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.nmlInk : Color.nmlMuted)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(profile.name)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private func previewVoice(_ voice: String) {
        Task {
            await voicePreview.preview(voice: voice)
        }
    }

    private func loadBackendVersion() {
        backendVersionText = "Checking backend..."
        Task {
            do {
                let version = try await ChatService().backendVersion()
                let rawCommit = version.gitCommit.flatMap { $0.isEmpty || $0 == "unknown" ? nil : $0 }
                let commit = rawCommit ?? version.deployId.flatMap { $0.isEmpty || $0 == "unknown" ? nil : $0 } ?? "unknown"
                let branch = version.gitBranch.flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"
                let environment = version.environment.flatMap { $0.isEmpty ? nil : $0 } ?? "env unknown"
                await MainActor.run {
                    backendVersionText = "\(commit) · \(branch) · \(environment)"
                }
            } catch {
                await MainActor.run {
                    backendVersionText = "Backend version unavailable"
                }
            }
        }
    }

    private func settingsSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: title)
                .padding(.bottom, 10)
            VStack(spacing: 0) {
                content()
            }
        }
    }

    private func settingRow<Accessory: View>(
        label: String,
        description: String?,
        @ViewBuilder accessory: () -> Accessory
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                if let description {
                    Text(description)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                }
            }
            Spacer()
            accessory()
        }
        .padding(.vertical, 16)
    }

    private var voicePickerRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("Voice")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Text(voicePreview.isPlaying ? "Playing preview" : "Tap preview to hear")
                    .font(.system(size: 12, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }

            Spacer(minLength: 12)

            Button {
                previewVoice(settings.voice)
            } label: {
                Text(voicePreview.isLoading ? "…" : (voicePreview.isPlaying ? "PLAYING" : "PREVIEW"))
                    .font(.nmlMono(11, weight: .medium))
                    .tracking(1.4)
                    .foregroundStyle(Color.nmlMuted)
            }
            .buttonStyle(.plain)
            .disabled(voicePreview.isLoading)

            Menu {
                ForEach(OxySettings.voiceOptions, id: \.value) { voice in
                    Button {
                        settings.voice = voice.value
                        saveSettings()
                    } label: {
                        if settings.voice == voice.value {
                            Label(voice.label, systemImage: "checkmark")
                        } else {
                            Text(voice.label)
                        }
                    }
                }
            } label: {
                Text(selectedVoiceLabel.uppercased())
                    .font(.nmlMono(12, weight: .medium))
                    .tracking(1.2)
                    .foregroundStyle(Color.nmlTitanium)
            }
            .buttonStyle(.plain)
            .padding(.leading, 18)
        }
        .padding(.vertical, 16)
    }

    private func legalLink(label: String, path: String) -> some View {
        Button {
            guard let url = URL(string: "\(APIClient.shared.baseURL)\(path)") else { return }
            UIApplication.shared.open(url)
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: .regular))
                Spacer()
                Text("↗")
                    .font(.system(size: 14, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .foregroundStyle(Color.nmlInk)
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
    }

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        normalizeSettings()
        appTheme = settings.appTheme
        UserDefaults.standard.set(settings.accentColor, forKey: "oxy_accentColor")
    }

    private func saveSettings() {
        normalizeSettings()
        appTheme = settings.appTheme
        UserDefaults.standard.set(settings.accentColor, forKey: "oxy_accentColor")
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
        Task {
            await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        }
    }

    private func handleVersionTap() {
        versionTapCount += 1
        if versionTapCount >= 5 {
            versionTapCount = 0
            showBackendURLEditor = true
        }
    }

    private func normalizeSettings() {
        settings.appTheme = OxySettings.normalizedTheme(settings.appTheme)
        settings.autonomy = OxySettings.normalizedAutonomy(settings.autonomy)
        if !OxySettings.voiceOptions.contains(where: { $0.value == settings.voice }) {
            settings.voice = "Aoede"
        }
        if !OxySettings.accentOptions.contains(where: { $0.value == settings.accentColor }) {
            settings.accentColor = "stone"
        }
        settings.designPalette = settings.accentColor
    }
}

private struct BackendURLEditorSheet: View {
    @Binding var currentURL: String
    let onDone: () -> Void
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlBackground.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    NamelessSectionHeader(title: "Custom Backend URL")

                    NamelessLineField(
                        placeholder: "https://your-backend.run.app",
                        text: $draft
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)

                    Text("Leave blank to use the default Cloud Run backend.")
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)

                    if !currentURL.isEmpty {
                        Button(role: .destructive) {
                            draft = ""
                            currentURL = ""
                            onDone()
                        } label: {
                            Text("Reset to default")
                                .font(.system(size: 14, weight: .medium))
                        }
                    }

                    Spacer()
                }
                .padding(20)
            }
            .navigationTitle("Backend URL")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDone() }
                        .foregroundStyle(Color.nmlTitanium)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        currentURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        onDone()
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.nmlTitanium)
                }
            }
        }
        .onAppear { draft = currentURL }
    }
}

// MARK: - Voice Preview

@Observable
@MainActor
private final class VoicePreviewPlayer: NSObject, AVAudioPlayerDelegate {
    var isLoading = false
    var isPlaying = false
    private var player: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?

    func preview(voice: String) async {
        previewTask?.cancel()
        player?.stop()
        isLoading = true
        isPlaying = false

        let task = Task {
            do {
                let data = try await APIClient.shared.request(
                    path: "/tts-preview",
                    method: "POST",
                    body: [
                        "voice": voice,
                        "text": "This is a preview of how this voice sounds."
                    ]
                )
                guard !Task.isCancelled else { return }
                let response = try JSONDecoder().decode(TTSPreviewResponse.self, from: data)
                guard let audioData = Data(base64Encoded: response.audio) else {
                    isLoading = false
                    return
                }
                let audioSession = AVAudioSession.sharedInstance()
                try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                try audioSession.setActive(true)
                let nextPlayer = try AVAudioPlayer(data: audioData)
                guard !Task.isCancelled else { return }
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

        previewTask = task
        await task.value
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

// MARK: - Initiative

private struct InitiativeScroller: View {
    @Binding var selection: String
    let onChange: () -> Void

    private var value: Binding<Double> {
        Binding(
            get: {
                Double(OxySettings.autonomyLevels.firstIndex(of: OxySettings.normalizedAutonomy(selection)) ?? 2)
            },
            set: { newValue in
                let rounded = min(max(Int(newValue.rounded()), 0), OxySettings.autonomyLevels.count - 1)
                let next = OxySettings.autonomyLevels[rounded]
                if next != selection {
                    selection = next
                    onChange()
                }
            }
        )
    }

    private var maxIndex: Int { OxySettings.autonomyLevels.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Initiative")
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Text(description)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(Color.nmlMuted)
                }
                Spacer()
                Text(selection.uppercased())
                    .font(.nmlMono(12, weight: .medium))
                    .tracking(1.2)
                    .foregroundStyle(Color.nmlTitanium)
            }

            dial

            HStack {
                Text("QUIET")
                Spacer()
                Text("STEADY")
                Spacer()
                Text("ACTIVE")
            }
            .font(.nmlMono(10, weight: .medium))
            .tracking(1.0)
            .foregroundStyle(Color.nmlMuted)
        }
        .padding(.vertical, 16)
    }

    /// A delicate dial: a hairline track, a metal-gradient fill, and a metal bead
    /// that snaps to each level with a soft haptic detent.
    private var dial: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let frac = maxIndex == 0 ? 0 : value.wrappedValue / Double(maxIndex)
            let bead: CGFloat = 28
            let x = (w - bead) * frac
            ZStack(alignment: .leading) {
                Capsule().fill(Color.nmlFill(0.12)).frame(height: 6)
                Capsule().fill(.nmlMetal).frame(width: x + bead / 2, height: 6)
                Circle()
                    .fill(.nmlMetal)
                    .frame(width: bead, height: bead)
                    .overlay(Circle().strokeBorder(Color.nmlBackground, lineWidth: 2))
                    .shadow(color: Color.nmlGlow.opacity(0.4), radius: 6, y: 2)
                    .offset(x: x)
            }
            .frame(height: bead)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let f = min(max(g.location.x / w, 0), 1)
                        let idx = (f * Double(maxIndex)).rounded()
                        if Int(idx) != Int(value.wrappedValue.rounded()) {
                            HapticManager.shared.impact(.light)
                        }
                        value.wrappedValue = idx
                    }
            )
        }
        .frame(height: 28)
    }

    private var description: String {
        switch selection {
        case "Quiet": return "Only speaks when asked."
        case "Low": return "Light nudges, mostly reactive."
        case "Active": return "Looks for useful openings."
        case "Bold": return "More opinionated and proactive."
        default: return "Helpful without being noisy."
        }
    }
}

// MARK: - Settings Model

struct OxySettings: Codable {
    var name: String = "Nameless"
    var voice: String = "Aoede"
    var voiceOn: Bool = true
    var voiceEngine: String = "current"
    var autonomy: String = "Balanced"
    var proactiveBriefings: Bool = true
    var healthAlerts: Bool = true
    var locationReminders: Bool = true
    var homeLatitude: Double?
    var homeLongitude: Double?
    var designTemplate: String = "compact"
    var designPalette: String = "stone"
    var designMotion: String = "calm"
    var accentColor: String = "stone"
    var appTheme: String = "dark"
    var bubbleStyle: String = "comfort"
    var preferredMapsApp: String = "apple"
    var preferredTransportMode: String = "driving"
    var reviewBeforeOpeningApps: Bool = false
    var confirmSensitiveAppOpens: Bool = true

    enum CodingKeys: String, CodingKey {
        case name, voice, voiceOn, voiceEngine, autonomy, proactiveBriefings, healthAlerts, locationReminders
        case homeLatitude, homeLongitude, designTemplate, designPalette, designMotion
        case accentColor, appTheme, bubbleStyle, preferredMapsApp, preferredTransportMode, reviewBeforeOpeningApps
        case confirmSensitiveAppOpens
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Nameless"
        voice = try container.decodeIfPresent(String.self, forKey: .voice) ?? "Aoede"
        voiceOn = try container.decodeIfPresent(Bool.self, forKey: .voiceOn) ?? true
        voiceEngine = try container.decodeIfPresent(String.self, forKey: .voiceEngine) ?? "current"
        autonomy = Self.normalizedAutonomy(try container.decodeIfPresent(String.self, forKey: .autonomy) ?? "Balanced")
        proactiveBriefings = try container.decodeIfPresent(Bool.self, forKey: .proactiveBriefings) ?? true
        healthAlerts = try container.decodeIfPresent(Bool.self, forKey: .healthAlerts) ?? true
        locationReminders = try container.decodeIfPresent(Bool.self, forKey: .locationReminders) ?? true
        homeLatitude = try container.decodeIfPresent(Double.self, forKey: .homeLatitude)
        homeLongitude = try container.decodeIfPresent(Double.self, forKey: .homeLongitude)
        designTemplate = try container.decodeIfPresent(String.self, forKey: .designTemplate) ?? "compact"
        designPalette = try container.decodeIfPresent(String.self, forKey: .designPalette) ?? "stone"
        designMotion = try container.decodeIfPresent(String.self, forKey: .designMotion) ?? "calm"
        accentColor = try container.decodeIfPresent(String.self, forKey: .accentColor) ?? designPalette
        appTheme = Self.normalizedTheme(try container.decodeIfPresent(String.self, forKey: .appTheme) ?? "dark")
        bubbleStyle = try container.decodeIfPresent(String.self, forKey: .bubbleStyle) ?? "comfort"
        preferredMapsApp = try container.decodeIfPresent(String.self, forKey: .preferredMapsApp) ?? "apple"
        preferredTransportMode = try container.decodeIfPresent(String.self, forKey: .preferredTransportMode) ?? "driving"
        reviewBeforeOpeningApps = try container.decodeIfPresent(Bool.self, forKey: .reviewBeforeOpeningApps) ?? false
        confirmSensitiveAppOpens = try container.decodeIfPresent(Bool.self, forKey: .confirmSensitiveAppOpens) ?? true
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
        VoiceOption(value: "Algenib", label: "Gravel"),
        VoiceOption(value: "Autonoe", label: "Bright"),
        VoiceOption(value: "Fenrir", label: "Electric"),
        VoiceOption(value: "Gacrux", label: "Mature"),
        VoiceOption(value: "Iapetus", label: "Measured"),
        VoiceOption(value: "Puck", label: "Playful"),
        VoiceOption(value: "Sulafat", label: "Warm"),
        VoiceOption(value: "Vindemiatrix", label: "Gentle"),
        VoiceOption(value: "Zubenelgenubi", label: "Casual"),
    ]

    static let designTemplates = ["compact", "glass", "dense"]
    static let designPalettes = ["stone", "mint", "blue", "violet"]
    static let designMotions = ["calm", "snappy", "none"]
    static let autonomyLevels = ["Quiet", "Low", "Balanced", "Active", "Bold"]
    static func normalizedTheme(_ theme: String) -> String {
        switch theme {
        case "light", "system":
            return theme
        default:
            return "dark"
        }
    }
    static func normalizedAutonomy(_ autonomy: String) -> String {
        switch autonomy {
        case "Quiet", "Low":
            return autonomy
        case "Medium", "Balanced":
            return "Balanced"
        case "Medium-High", "Active", "High":
            return "Active"
        case "Assertive", "Bold":
            return "Bold"
        default:
            return "Balanced"
        }
    }
    static let accentOptions = [
        AccentOption(value: "stone", label: "Stone", color: Color.oxyDefaultStone),
        AccentOption(value: "mint", label: "Mint", color: Color.oxyGreen),
        AccentOption(value: "blue", label: "Blue", color: Color(red: 92/255, green: 154/255, blue: 245/255)),
        AccentOption(value: "cyan", label: "Cyan", color: Color(red: 48/255, green: 184/255, blue: 210/255)),
        AccentOption(value: "amber", label: "Amber", color: Color(red: 236/255, green: 168/255, blue: 65/255)),
        AccentOption(value: "coral", label: "Coral", color: Color(red: 238/255, green: 112/255, blue: 92/255)),
        AccentOption(value: "rose", label: "Rose", color: Color(red: 230/255, green: 124/255, blue: 154/255)),
        AccentOption(value: "violet", label: "Violet", color: Color(red: 162/255, green: 132/255, blue: 245/255)),
        AccentOption(value: "indigo", label: "Indigo", color: Color(red: 105/255, green: 126/255, blue: 235/255))
    ]
}

#Preview {
    SettingsView()
        .environment(AppState())
}
