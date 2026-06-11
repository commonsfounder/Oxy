import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var settings = OxySettings()
    @State private var showSignOutConfirm = false
    @State private var showSignOutAllConfirm = false
    @State private var showDeleteAccountConfirm = false
    @State private var showBackendURLEditor = false
    @State private var versionTapCount = 0
    @State private var voicePreview = VoicePreviewPlayer()
    @State private var backendVersionText = "Checking backend..."
    @State private var accountStatusText: String?
    @State private var isExportingData = false
    @State private var isDeletingAccount = false
    @State private var isSigningOutAll = false
    @State private var sharePayload: SharePayload?
    @AppStorage("oxy_custom_backend_url") private var customBackendURL = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Settings", onBack: { dismiss() })
                    ScrollView {
                    VStack(spacing: 36) {
                        // Identity
                        settingsSection(title: "Profile") {
                            settingRow(label: "Assistant Name", description: nil) {
                                TextField("Nameless", text: $settings.name)
                                    .font(.system(size: 15, weight: .light))
                                    .foregroundStyle(Color.nmlInk)
                                    .tint(Color.nmlTitanium)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 140)
                                    .onChange(of: settings.name) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Personalisation") {
                            NavigationLink {
                                MemoryView(embedded: true)
                            } label: {
                                settingsNavigationRow(
                                    label: "Memory",
                                    description: "Saved facts and preferences"
                                )
                            }
                            .buttonStyle(.plain)
                        }

                        settingsSection(title: "Appearance") {
                            settingRow(label: "Accent", description: nil) {
                                Menu {
                                    ForEach(OxySettings.accentOptions) { option in
                                        Button {
                                            settings.accentColor = option.value
                                            saveSettings()
                                        } label: {
                                            HStack {
                                                Circle()
                                                    .fill(option.color)
                                                    .frame(width: 10, height: 10)
                                                Text(option.label)
                                                if settings.accentColor == option.value {
                                                    Spacer()
                                                    Image(systemName: "checkmark")
                                                }
                                            }
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 9) {
                                        Circle()
                                            .fill(selectedAccentColor)
                                            .frame(width: 9, height: 9)
                                        Text(selectedAccentLabel.uppercased())
                                            .font(.nmlMono(12, weight: .medium))
                                            .tracking(1.2)
                                        Text("›")
                                            .font(.system(size: 15, weight: .light))
                                    }
                                    .foregroundStyle(Color.nmlTitanium)
                                }
                                .buttonStyle(.plain)
                            }

                            NamelessDivider()

                            settingRow(label: "Theme", description: nil) {
                                Picker("Theme", selection: $settings.appTheme) {
                                    Text("Light").tag("light")
                                    Text("Dark").tag("dark")
                                    Text("System").tag("system")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.nmlTitanium)
                                .onChange(of: settings.appTheme) { _, _ in saveSettings() }
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

                        // Pendant / Hardware
                        PendantSettingsSection(pendant: NativeIntegrationManager.shared.pendant)

                        settingsSection(title: "Account") {
                            accountRow(
                                label: isExportingData ? "Preparing Export" : "Export My Data",
                                action: exportMyData
                            )
                            .disabled(isExportingData || isDeletingAccount)
                            .accessibilityLabel("Export my data")

                            NamelessDivider()

                            accountRow(
                                label: isDeletingAccount ? "Deleting Account" : "Delete Account",
                                destructive: true,
                                action: { showDeleteAccountConfirm = true }
                            )
                            .disabled(isExportingData || isDeletingAccount)
                            .accessibilityLabel("Delete account")

                            NamelessDivider()

                            accountRow(
                                label: "Sign Out",
                                destructive: true,
                                action: { showSignOutConfirm = true }
                            )
                            .accessibilityLabel("Sign out")

                            NamelessDivider()

                            accountRow(
                                label: isSigningOutAll ? "Signing Out…" : "Sign Out All Devices",
                                destructive: true,
                                action: { showSignOutAllConfirm = true }
                            )
                            .disabled(isSigningOutAll)
                            .accessibilityLabel("Sign out all devices")

                            if let accountStatusText {
                                NamelessDivider()
                                Text(accountStatusText)
                                    .font(.system(size: 12, weight: .light))
                                    .foregroundStyle(Color.nmlMuted)
                                    .lineSpacing(3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 14)
                            }
                        }

                        settingsSection(title: "Support & Legal") {
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
            .alert("Sign Out", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
            .alert("Sign Out All Devices", isPresented: $showSignOutAllConfirm) {
                Button("Sign Out All", role: .destructive) { signOutAllDevices() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will invalidate all active sessions on every device. You will be signed out here too.")
            }
            .alert("Delete Account", isPresented: $showDeleteAccountConfirm) {
                Button("Delete", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your account data, including conversations, memories, connectors, preferences, and action history.")
            }
            .sheet(isPresented: $showBackendURLEditor) {
                BackendURLEditorSheet(currentURL: $customBackendURL) {
                    showBackendURLEditor = false
                    loadBackendVersion()
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(activityItems: [payload.url])
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

    private var selectedAccentLabel: String {
        OxySettings.accentOptions.first(where: { $0.value == settings.accentColor })?.label ?? "Stone"
    }

    private var selectedAccentColor: Color {
        OxySettings.accentOptions.first(where: { $0.value == settings.accentColor })?.color ?? Color.oxyDefaultStone
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

    private func exportMyData() {
        guard !isExportingData else { return }
        accountStatusText = nil
        isExportingData = true
        Task {
            do {
                let data = try await APIClient.shared.exportUserData(userId: appState.userId)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("oxy-data-export-\(Int(Date().timeIntervalSince1970)).json")
                try data.write(to: url, options: .atomic)
                await MainActor.run {
                    isExportingData = false
                    sharePayload = SharePayload(url: url)
                    accountStatusText = "Export ready."
                }
            } catch {
                await MainActor.run {
                    isExportingData = false
                    accountStatusText = "Could not export your data: \(error.localizedDescription)"
                }
            }
        }
    }

    private func signOutAllDevices() {
        guard !isSigningOutAll else { return }
        accountStatusText = nil
        isSigningOutAll = true
        Task {
            do {
                _ = try await APIClient.shared.request(path: "/auth/logout-all", method: "POST")
                await MainActor.run {
                    isSigningOutAll = false
                    appState.logout()
                }
            } catch {
                await MainActor.run {
                    isSigningOutAll = false
                    accountStatusText = "Could not sign out all devices: \(error.localizedDescription)"
                }
            }
        }
    }

    private func deleteAccount() {
        guard !isDeletingAccount else { return }
        accountStatusText = nil
        isDeletingAccount = true
        Task {
            do {
                try await APIClient.shared.deleteAccount(userId: appState.userId)
                await MainActor.run {
                    isDeletingAccount = false
                    appState.logout()
                }
            } catch {
                await MainActor.run {
                    isDeletingAccount = false
                    accountStatusText = "Could not delete your account: \(error.localizedDescription)"
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

    private func settingsNavigationRow(label: String, description: String?) -> some View {
        HStack(spacing: 12) {
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

            Text("›")
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(Color.nmlMuted)
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

    /// A flat, icon-free account action row — raw text, optional muted-red
    /// destructive tint, and a quiet "›" affordance instead of an SF chevron.
    private func accountRow(
        label: String,
        destructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: .regular))
                Spacer()
                Text("›")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .foregroundStyle(destructive ? Color.nmlDanger : Color.nmlInk)
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
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

private struct SharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

private struct BackendURLEditorSheet: View {
    @Binding var currentURL: String
    let onDone: () -> Void
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    NamelessSectionHeader(title: "Custom backend URL")

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

private struct ShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
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

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Initiative")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Text(description)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                }
                Spacer()
                Text(selection.uppercased())
                    .font(.nmlMono(12, weight: .medium))
                    .tracking(1.2)
                    .foregroundStyle(Color.nmlTitanium)
            }

            Slider(value: value, in: 0...Double(OxySettings.autonomyLevels.count - 1), step: 1)
                .tint(Color.nmlTitanium)

            HStack {
                Text("QUIET")
                Spacer()
                Text("STEADY")
                Spacer()
                Text("ACTIVE")
            }
            .font(.nmlMono(9, weight: .medium))
            .tracking(1.0)
            .foregroundStyle(Color.nmlMuted)
        }
        .padding(.vertical, 16)
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

// MARK: - PendantSettingsSection

private struct PendantSettingsSection: View {
    var pendant: PendantBLEManager
    @State private var showUnpairConfirm = false
    @State private var scanPulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: "Pendant")
                .padding(.bottom, 10)

            VStack(spacing: 0) {
                HStack {
                    Text("Status")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Spacer()
                    HStack(spacing: 10) {
                        Text(statusDescription)
                            .font(.nmlMono(12))
                            .foregroundStyle(statusColor)
                            .contentTransition(.numericText())
                            .animation(.easeInOut(duration: 0.3), value: pendant.connectionState)
                        statusIndicator
                            .animation(.spring(response: 0.4, dampingFraction: 0.7), value: pendant.connectionState)
                    }
                }
                .padding(.vertical, 16)

                if let name = pendant.peripheralName, pendant.isConnected {
                    NamelessDivider()
                    HStack {
                        Text("Device")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(Color.nmlInk)
                        Spacer()
                        Text(name)
                            .font(.nmlMono(12))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    .padding(.vertical, 16)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if let error = pendant.lastError {
                    NamelessDivider()
                    Text(error)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 16)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                NamelessDivider()

                HStack(spacing: 12) {
                    if pendant.isConnected {
                        Button("UNPAIR") {
                            showUnpairConfirm = true
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlDanger)
                        .transition(.opacity)
                    } else if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                        Button("CANCEL") {
                            pendant.stopScan()
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlMuted)
                        .transition(.opacity)
                    } else {
                        Button("SCAN FOR PENDANT") {
                            pendant.startScan()
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlTitanium)
                        .transition(.opacity)
                    }
                    Spacer()
                }
                .padding(.vertical, 16)
                .animation(.easeInOut(duration: 0.25), value: pendant.connectionState)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: pendant.connectionState)
        .alert("Unpair Pendant", isPresented: $showUnpairConfirm) {
            Button("Unpair", role: .destructive) { pendant.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will disconnect and forget the paired pendant. You can pair again later.")
        }
    }

    private var statusDescription: String {
        switch pendant.connectionState {
        case .disconnected: return "Not connected"
        case .scanning: return "Scanning…"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .error: return "Error"
        }
    }

    private var statusColor: Color {
        switch pendant.connectionState {
        case .connected: return Color.nmlTitanium
        case .error: return Color.nmlDanger
        case .scanning, .connecting: return Color.nmlMuted
        default: return Color.nmlMuted
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch pendant.connectionState {
        case .connected:
            NamelessStatusDot(isLive: true, diameter: 6)
        case .scanning, .connecting:
            ScanPulseView()
        case .error:
            NamelessStatusDot(isLive: false, diameter: 6)
        case .disconnected:
            NamelessStatusDot(isLive: false, diameter: 6)
        }
    }
}

private struct ScanPulseView: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.nmlTitanium.opacity(pulse ? 0 : 0.4), lineWidth: 2)
                .frame(width: pulse ? 24 : 12, height: pulse ? 24 : 12)
                .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulse)

            Circle()
                .fill(Color.nmlTitanium)
                .frame(width: 8, height: 8)
        }
        .onAppear { pulse = true }
    }
}

#Preview {
    SettingsView()
        .environment(AppState())
}
