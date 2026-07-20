import SwiftUI
import UIKit

/// Cross-cutting app preferences only. Identity and account actions live in
/// Profile, memory in the Memory screen, and pendant pairing on the Pendant
/// screen — Settings used to duplicate all three.
struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var settings = OxySettings()
    @State private var showBackendURLEditor = false
    @State private var versionTapCount = 0
    @AppStorage("oxy_custom_backend_url") private var customBackendURL = ""
    // Light/dark/system — the single source of truth read by the app root's
    // preferredColorScheme. Writing it re-themes the whole app live.

    // The Gleb pastel wash sits behind the glass section plates below so they
    // refract the living mesh instead of reading as flat cards on a flat canvas.
    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }

    var body: some View {
        NavigationStack {
            ZStack {
                GlebChrome.pastelBlob.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Settings", onBack: { dismiss() })
                    ScrollView {
                    appGlassContainer(spacing: 24) {
                    VStack(spacing: 28) {
                        settingsSection(title: "Assistant") {
                            FreedomSlider(selection: $settings.autonomy, onChange: saveSettings)

                            MilgrainDivider()

                            settingRow(label: "Briefings", description: "Check-ins through the day.") {
                                MilgrainToggle(isOn: $settings.proactiveBriefings)
                                    .onChange(of: settings.proactiveBriefings) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Action Defaults") {
                            dropdownRow(
                                label: "Maps",
                                options: [
                                    ("apple", "Apple Maps"),
                                    ("google", "Google Maps")
                                ],
                                selection: $settings.preferredMapsApp
                            )

                            MilgrainDivider()

                            dropdownRow(
                                label: "Getting around",
                                options: [
                                    ("driving", "Driving"),
                                    ("transit", "Transit"),
                                    ("walking", "Walking")
                                ],
                                selection: $settings.preferredTransportMode
                            )

                            MilgrainDivider()

                            settingRow(label: "Ask before private apps", description: "Banking, health, and similar.") {
                                MilgrainToggle(isOn: $settings.confirmSensitiveAppOpens)
                                    .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "Chat") {
                            dropdownRow(
                                label: "Effort",
                                options: [
                                    ("low", "Low"),
                                    ("medium", "Medium"),
                                    ("high", "High")
                                ],
                                selection: $settings.chatEffort
                            )

                            MilgrainDivider()

                            settingRow(label: "Guard mode", description: "Confirm every action before it runs.") {
                                MilgrainToggle(isOn: $settings.guardMode)
                                    .onChange(of: settings.guardMode) { _, _ in saveSettings() }
                            }
                        }

                        settingsSection(title: "About") {
                            legalLink(label: "Support", path: "/support")
                            MilgrainDivider()
                            legalLink(label: "Privacy Policy", path: "/privacy")
                            MilgrainDivider()
                            legalLink(label: "Terms of Use", path: "/terms")
                            MilgrainDivider()
                            Button(action: handleVersionTap) {
                                HStack {
                                    Text("Version")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Color.mgHeading)
                                    Spacer()
                                    Text("milgrain-0001-alpha")
                                        .font(.system(size: 14, weight: .regular))
                                        .foregroundStyle(Color.mgCaption)
                                        .lineLimit(1)
                                }
                                .padding(.vertical, 16)
                            }
                            .buttonStyle(.appScale(0.98))
                        }

                        Spacer().frame(height: 32)
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 12)
                    }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showBackendURLEditor) {
                BackendURLEditorSheet(currentURL: $customBackendURL) {
                    showBackendURLEditor = false
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .onAppear {
                loadSettings()
            }
            // Edge-swipe-to-dismiss is provided once by `.swipeToDismiss()` on the
            // presenting fullScreenCover (MoreView) — no per-screen copy needed.
        }
    }

    // MARK: - Helpers

    private func settingsSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        // Section title on the wash, rows on a glass plate that refracts it — the
        // same floating-glass language as Home's mission plates and More's menu.
        VStack(alignment: .leading, spacing: 10) {
            AppSectionTitle(title, size: 20)
            VStack(spacing: 0) { content() }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
        }
    }

    /// Row with a liquid-glass menu dropdown for a small fixed set of choices.
    private func dropdownRow(
        label: String,
        options: [(value: String, title: String)],
        selection: Binding<String>
    ) -> some View {
        let selectedTitle = options.first(where: { $0.value == selection.wrappedValue })?.title
            ?? options.first?.title
            ?? selection.wrappedValue

        return HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.mgHeading)
            Spacer(minLength: 8)
            Menu {
                ForEach(options, id: \.value) { option in
                    Button {
                        selection.wrappedValue = option.value
                        saveSettings()
                        HapticManager.shared.impact(.light)
                    } label: {
                        if option.value == selection.wrappedValue {
                            Label { Text(option.title) } icon: { AppIcon("check", size: 15) }
                        } else {
                            Text(option.title)
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(selectedTitle)
                        .font(.appBody(14, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(1)
                    AppIcon("chevron-updown", size: 13)
                        .foregroundStyle(Color.appMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background {
                    Capsule()
                        .fill(.clear)
                        .glassDropdownChrome()
                }
            }
            .accessibilityLabel(label)
            .accessibilityValue(selectedTitle)
        }
        .padding(.vertical, 16)
        .onChange(of: selection.wrappedValue) { _, _ in saveSettings() }
    }

    private func settingRow<Accessory: View>(
        label: String,
        description: String?,
        @ViewBuilder accessory: () -> Accessory
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
                if let description {
                    Text(description)
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(Color.mgSecondary)
                }
            }
            Spacer()
            accessory()
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
                AppIcon("arrow-up-right", size: 12)
                    .foregroundStyle(Color.mgSecondary)
            }
            .foregroundStyle(Color.mgHeading)
            .padding(.vertical, 16)
        }
        .buttonStyle(.appScale(0.98))
    }

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        normalizeSettings()
        UserDefaults.standard.set(settings.accentColor, forKey: "oxy_accentColor")
        // Chat effort/guard mode are also persisted server-side (chat_settings table) so
        // they survive a reinstall/new device, not just a relaunch — UserDefaults above
        // already covers relaunch. Refresh from the server on appear; local stays
        // authoritative until this resolves.
        Task { await refreshChatSettingsFromServer() }
    }

    private func refreshChatSettingsFromServer() async {
        do {
            let data = try await APIClient.shared.request(path: "/chat-settings")
            let remote = try JSONDecoder().decode(ChatSettingsResponse.self, from: data)
            settings.chatEffort = remote.effort
            settings.guardMode = remote.guardMode
            if let encoded = try? JSONEncoder().encode(settings) {
                UserDefaults.standard.set(encoded, forKey: "oxy_settings")
            }
        } catch {
            // Ambient sync — local UserDefaults values already loaded above stay in effect.
        }
    }

    private func saveSettings() {
        normalizeSettings()
        UserDefaults.standard.set(settings.accentColor, forKey: "oxy_accentColor")
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
        Task {
            await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        }
        Task {
            _ = try? await APIClient.shared.request(
                path: "/chat-settings",
                method: "PUT",
                body: ["effort": settings.chatEffort, "guardMode": settings.guardMode]
            )
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
        settings.autonomy = OxySettings.normalizedAutonomy(settings.autonomy)
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
                GlebChrome.pastelBlob.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    MilgrainSectionHeader(title: "Custom Backend URL")

                    AppLineField(
                        placeholder: "https://your-backend.run.app",
                        text: $draft
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)

                    Text("Leave blank to use the default Cloud Run backend.")
                        .font(.appBody(12))
                        .foregroundStyle(Color.mgSecondary)

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
                        .foregroundStyle(Color.mgHeading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        currentURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        onDone()
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
                }
            }
        }
        .onAppear { draft = currentURL }
    }
}

// MARK: - Glass chrome helpers

private extension View {
    /// Liquid glass capsule when available; material fallback so older OS still looks intentional.
    @ViewBuilder
    func glassDropdownChrome() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            self
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.5))
        }
    }

}

// MARK: - Proactivity (autonomy slider)

/// Discrete 5-step slider. Stored values stay Reactive…Autonomous for the API.
private struct FreedomSlider: View {
    @Binding var selection: String
    let onChange: () -> Void

    private var levels: [String] { OxySettings.autonomyLevels }

    private var index: Binding<Double> {
        Binding(
            get: {
                let normalized = OxySettings.normalizedAutonomy(selection)
                let i = levels.firstIndex(of: normalized) ?? 2
                return Double(i)
            },
            set: { raw in
                let i = min(max(Int(raw.rounded()), 0), levels.count - 1)
                let next = levels[i]
                guard next != OxySettings.normalizedAutonomy(selection) else { return }
                selection = next
                onChange()
                HapticManager.shared.impact(.light)
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Proactivity")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.mgHeading)
                Text(simpleLabel)
                    .font(.appBody(12))
                    .foregroundStyle(Color.mgSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Plain system slider — no glass shell around the track.
            Slider(value: index, in: 0...Double(levels.count - 1), step: 1)
                .tint(Color.appAccent)
                .accessibilityLabel("Proactivity")
                .accessibilityValue(simpleLabel)
        }
        .padding(.vertical, 16)
    }

    private var simpleLabel: String {
        switch OxySettings.normalizedAutonomy(selection) {
        case "Reactive": return "Only acts when you ask."
        case "Reserved": return "Light nudges, mostly quiet."
        case "Proactive": return "Looks for useful openings."
        case "Autonomous": return "Acts for you, then tells you."
        default: return "Helpful without being noisy."
        }
    }
}

// MARK: - Settings Model

/// Decoding the `oxy_settings` blob on every SwiftUI body pass is what made the
/// chat stutter — MessageBubble read it per bubble, per streamed token. Decode
/// once and refresh only when a default actually changes.
/// ponytail: re-decodes on any UserDefaults change (fires a bit more than needed);
/// fine — it's one tiny blob. Narrow to oxy_settings only if it ever shows up in a trace.
enum OxySettingsCache {
    static private(set) var current: OxySettings = {
        NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { _ in current = load() }
        return load()
    }()

    private static func load() -> OxySettings {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings"),
              let settings = try? JSONDecoder().decode(OxySettings.self, from: data) else {
            return OxySettings()
        }
        return settings
    }
}

struct OxySettings: Codable {
    var name: String = ""
    var userName: String = ""
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
    /// Response depth preference — stored/exposed only, not wired into model selection.
    var chatEffort: String = "medium"
    /// Server-enforced (see action-runner.js's executionMode gate) — deliberately a
    /// distinct field from reviewBeforeOpeningApps/confirmSensitiveAppOpens above, which
    /// only gate local deep-link auto-open and never touch the server.
    var guardMode: Bool = false

    enum CodingKeys: String, CodingKey {
        case name, userName, autonomy, proactiveBriefings, healthAlerts, locationReminders
        case homeLatitude, homeLongitude, designTemplate, designPalette, designMotion
        case accentColor, appTheme, bubbleStyle, preferredMapsApp, preferredTransportMode, reviewBeforeOpeningApps
        case confirmSensitiveAppOpens, chatEffort, guardMode
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        userName = try container.decodeIfPresent(String.self, forKey: .userName) ?? ""
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
        chatEffort = try container.decodeIfPresent(String.self, forKey: .chatEffort) ?? "medium"
        guardMode = try container.decodeIfPresent(Bool.self, forKey: .guardMode) ?? false
    }

    struct AccentOption: Identifiable {
        let value: String
        let label: String
        let color: Color
        var id: String { value }
    }

    static let designTemplates = ["compact", "glass", "dense"]
    static let designPalettes = ["stone", "mint", "blue", "violet"]
    static let designMotions = ["calm", "snappy", "none"]
    static let autonomyLevels = ["Reactive", "Reserved", "Balanced", "Proactive", "Autonomous"]
    static let chatEffortLevels = ["low", "medium", "high"]
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
        case "Reactive", "Quiet":
            return "Reactive"
        case "Reserved", "Low":
            return "Reserved"
        case "Balanced", "Medium":
            return "Balanced"
        case "Proactive", "Active", "Medium-High", "High":
            return "Proactive"
        case "Autonomous", "Bold", "Assertive":
            return "Autonomous"
        default:
            return "Balanced"
        }
    }
    static let accentOptions = [
        AccentOption(value: "teal", label: "Teal", color: Color.appAccent),
        AccentOption(value: "mint", label: "Mint", color: Color.appSuccess),
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
