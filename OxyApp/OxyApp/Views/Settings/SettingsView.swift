import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var settings = OxySettings()
    @State private var showSignOutConfirm = false
    @State private var showSignOutAllConfirm = false
    @State private var showDeleteAccountConfirm = false
    @State private var showAccentPicker = false
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

                        settingsSection(title: "Personalisation") {
                            NavigationLink {
                                MemoryView(embedded: true)
                            } label: {
                                settingsNavigationRow(
                                    label: "Memory",
                                    description: "Saved facts and preferences",
                                    icon: "brain.head.profile"
                                )
                            }
                            .buttonStyle(.plain)
                        }

                        settingsSection(title: "Appearance") {
                            settingRow(label: "Accent", description: selectedAccentLabel) {
                                Button {
                                    showAccentPicker = true
                                } label: {
                                    HStack(spacing: 8) {
                                        Circle()
                                            .fill(selectedAccentColor)
                                            .frame(width: 14, height: 14)
                                        Text(selectedAccentLabel)
                                            .font(.system(size: 13, weight: .semibold))
                                        Image(systemName: "chevron.down")
                                            .font(.system(size: 10, weight: .bold))
                                    }
                                    .foregroundStyle(Color.oxyText)
                                    .padding(.horizontal, 11)
                                    .padding(.vertical, 7)
                                    .background(Color.oxySurface1)
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Theme", description: nil) {
                                Picker("Theme", selection: $settings.appTheme) {
                                    Text("Light").tag("light")
                                    Text("Dark").tag("dark")
                                    Text("System").tag("system")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.oxyStone)
                                .onChange(of: settings.appTheme) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Bubbles", description: nil) {
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
                            settingRow(label: "Voice Replies", description: nil) {
                                Toggle("", isOn: $settings.voiceOn)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.voiceOn) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            voicePickerRow
                        }

                        // Autonomy
                        settingsSection(title: "Assistant") {
                            InitiativeScroller(selection: $settings.autonomy, onChange: saveSettings)

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Briefings", description: nil) {
                                Toggle("", isOn: $settings.proactiveBriefings)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
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
                                .tint(Color.oxyStone)
                                .onChange(of: settings.preferredMapsApp) { _, _ in saveSettings() }
                            }

                            Divider().overlay(Color.oxyLine)

                            settingRow(label: "Transport", description: nil) {
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

                            settingRow(label: "Confirm Sensitive Apps", description: nil) {
                                Toggle("", isOn: $settings.confirmSensitiveAppOpens)
                                    .labelsHidden()
                                    .tint(Color.oxyGreen)
                                    .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Account") {
                            Button(action: exportMyData) {
                                HStack {
                                    Image(systemName: isExportingData ? "hourglass" : "square.and.arrow.up")
                                        .font(.system(size: 14))
                                    Text(isExportingData ? "Preparing Export" : "Export My Data")
                                        .font(.system(size: 15, weight: .medium))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.oxyDim)
                                }
                                .foregroundStyle(Color.oxyText)
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                            .disabled(isExportingData || isDeletingAccount)
                            .accessibilityLabel("Export my data")

                            Divider().overlay(Color.oxyLine)

                            Button(action: { showDeleteAccountConfirm = true }) {
                                HStack {
                                    Image(systemName: isDeletingAccount ? "hourglass" : "trash.fill")
                                        .font(.system(size: 14))
                                    Text(isDeletingAccount ? "Deleting Account" : "Delete Account")
                                        .font(.system(size: 15, weight: .medium))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.oxyDim)
                                }
                                .foregroundStyle(Color.oxyRed)
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                            .disabled(isExportingData || isDeletingAccount)
                            .accessibilityLabel("Delete account")

                            Divider().overlay(Color.oxyLine)

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
                            .buttonStyle(.plain)
                            .accessibilityLabel("Sign out")

                            Divider().overlay(Color.oxyLine)

                            Button(action: { showSignOutAllConfirm = true }) {
                                HStack {
                                    Image(systemName: isSigningOutAll ? "hourglass" : "rectangle.portrait.and.arrow.right.fill")
                                        .font(.system(size: 14))
                                    Text(isSigningOutAll ? "Signing Out…" : "Sign Out All Devices")
                                        .font(.system(size: 15, weight: .medium))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Color.oxyDim)
                                }
                                .foregroundStyle(Color.oxyRed)
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                            .disabled(isSigningOutAll)
                            .accessibilityLabel("Sign out all devices")

                            if let accountStatusText {
                                Divider().overlay(Color.oxyLine)
                                Text(accountStatusText)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.oxySub)
                                    .lineSpacing(3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.top, 4)
                            }
                        }

                        settingsSection(title: "Support & Legal") {
                            legalLink(label: "Support", path: "/support", icon: "questionmark.circle.fill")
                            Divider().overlay(Color.oxyLine)
                            legalLink(label: "Privacy Policy", path: "/privacy", icon: "hand.raised.fill")
                            Divider().overlay(Color.oxyLine)
                            legalLink(label: "Terms of Use", path: "/terms", icon: "doc.text.fill")
                            Divider().overlay(Color.oxyLine)
                            Button(action: handleVersionTap) {
                                HStack {
                                    Text("Version")
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(Color.oxyText)
                                    Spacer()
                                    Text(backendVersionText)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Color.oxyDim)
                                        .lineLimit(1)
                                }
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                        }

                        Spacer().frame(height: 32)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
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
                Text("This permanently deletes your Oxy account data, including conversations, memories, connectors, preferences, and action history.")
            }
            .sheet(isPresented: $showAccentPicker) {
                AccentPickerSheet(selection: $settings.accentColor) {
                    saveSettings()
                    showAccentPicker = false
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
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
                let commit = version.gitCommit?.isEmpty == false && version.gitCommit != "unknown"
                    ? version.gitCommit!
                    : (version.deployId?.isEmpty == false ? version.deployId! : "unknown")
                let branch = version.gitBranch?.isEmpty == false ? version.gitBranch! : "unknown"
                let environment = version.environment?.isEmpty == false ? version.environment! : "env unknown"
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
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)
                .scrollTransition(axis: .vertical) { content, phase in
                    content
                        .opacity(phase.isIdentity ? 1 : 0)
                        .offset(y: phase.isIdentity ? 0 : 12)
                }

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
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: title)
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

    private func settingsNavigationRow(label: String, description: String?, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.oxyStone)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                if let description {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.oxyDim)
        }
        .padding(.vertical, 4)
    }

    private var voicePickerRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Voice")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.oxyText)
                    Text(selectedVoiceLabel)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)
                }
                Spacer()
                Button {
                    previewVoice(settings.voice)
                } label: {
                    Image(systemName: voicePreview.isLoading ? "hourglass" : (voicePreview.isPlaying ? "speaker.wave.2.fill" : "play.fill"))
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.oxyOnAccent)
                        .frame(width: 32, height: 32)
                        .background(Color.oxyStone)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(voicePreview.isLoading)
            }

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
                HStack {
                    Text(selectedVoiceLabel)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.oxyText)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.oxySub)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 13)
                .padding(.vertical, 11)
                .background(Color.oxySurface1)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.oxyLine2, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }

    private func legalLink(label: String, path: String, icon: String) -> some View {
        Button {
            guard let url = URL(string: "\(APIClient.shared.baseURL)\(path)") else { return }
            UIApplication.shared.open(url)
        } label: {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                Text(label)
                    .font(.system(size: 15, weight: .medium))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.oxyDim)
            }
            .foregroundStyle(Color.oxyText)
            .padding(.vertical, 4)
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
                Color.oxyBg.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    Text("Custom backend URL")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.oxySub)
                        .textCase(.uppercase)
                        .tracking(0.4)

                    TextField("https://your-backend.run.app", text: $draft)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.oxyText)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .padding(14)
                        .background(Color.oxySurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.oxyLine2, lineWidth: 1)
                        )

                    Text("Leave blank to use the default Cloud Run backend.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)

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
                        .foregroundStyle(Color.oxyStone)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        currentURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        onDone()
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.oxyStone)
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

private struct AccentPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    let onSelect: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(OxySettings.accentOptions) { option in
                            Button {
                                selection = option.value
                                onSelect()
                            } label: {
                                HStack(spacing: 14) {
                                    Circle()
                                        .fill(option.color)
                                        .frame(width: 22, height: 22)
                                        .overlay(
                                            Circle()
                                                .stroke(Color.oxyLine2, lineWidth: 1)
                                        )

                                    Text(option.label)
                                        .font(.system(size: 17, weight: .semibold))
                                        .foregroundStyle(Color.oxyText)

                                    Spacer()

                                    if selection == option.value {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 15, weight: .bold))
                                            .foregroundStyle(option.color)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .background(selection == option.value ? option.color.opacity(0.12) : Color.oxySurface2)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 16)
                                        .stroke(selection == option.value ? option.color.opacity(0.45) : Color.oxyLine2, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Accent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.oxyStone)
                }
            }
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
                        "text": "Hey, I am Oxy. This is how I sound."
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
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Initiative")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Color.oxyText)
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)
                }
                Spacer()
                Text(selection)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyStone)
            }

            Slider(value: value, in: 0...Double(OxySettings.autonomyLevels.count - 1), step: 1)
                .tint(Color.oxyStone)

            HStack {
                Text("Quiet")
                Spacer()
                Text("Steady")
                Spacer()
                Text("Active")
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.oxySub)
        }
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
    var name: String = "Oxy"
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
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Oxy"
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
                            .foregroundStyle(selection == option ? Color.oxyOnAccent : Color.oxySub)
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
        case "blue": return Color(red: 92/255, green: 154/255, blue: 245/255)
        case "violet": return Color(red: 162/255, green: 132/255, blue: 245/255)
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
                        Image(systemName: "sparkles")
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
            .foregroundStyle(selected ? Color.oxyOnAccent : Color.oxySub)
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
