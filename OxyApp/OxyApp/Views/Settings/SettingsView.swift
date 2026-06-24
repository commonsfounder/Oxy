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

    var body: some View {
        NavigationStack {
            ZStack {
                Color.mgBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Settings", onBack: { dismiss() })
                    ScrollView {
                    VStack(spacing: 36) {
                        settingsSection(title: "Appearance") {
                            settingRow(label: "Bubbles", description: nil) {
                                Picker("Bubbles", selection: $settings.bubbleStyle) {
                                    Text("Comfort").tag("comfort")
                                    Text("Compact").tag("compact")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.mgSecondary)
                                .onChange(of: settings.bubbleStyle) { _, _ in saveSettings() }
                            }
                        }

                        // Autonomy
                        settingsSection(title: "Assistant") {
                            InitiativeScroller(selection: $settings.autonomy, onChange: saveSettings)

                            MilgrainDivider()

                            settingRow(label: "Briefings", description: nil) {
                                MilgrainToggle(isOn: $settings.proactiveBriefings)
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
                                .tint(Color.mgSecondary)
                                .onChange(of: settings.preferredMapsApp) { _, _ in saveSettings() }
                            }

                            MilgrainDivider()

                            settingRow(label: "Transport", description: nil) {
                                Picker("Transport", selection: $settings.preferredTransportMode) {
                                    Text("Driving").tag("driving")
                                    Text("Transit").tag("transit")
                                    Text("Walking").tag("walking")
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                                .tint(Color.mgSecondary)
                                .onChange(of: settings.preferredTransportMode) { _, _ in saveSettings() }
                            }

                            MilgrainDivider()

                            settingRow(label: "Confirm Sensitive Apps", description: nil) {
                                MilgrainToggle(isOn: $settings.confirmSensitiveAppOpens)
                                    .onChange(of: settings.confirmSensitiveAppOpens) { _, _ in saveSettings() }
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
                            .buttonStyle(.nmlScale(0.98))
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
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .onAppear {
                loadSettings()
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

    private func settingsSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            MilgrainSectionHeader(title: title)
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
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.mgSecondary)
            }
            .foregroundStyle(Color.mgHeading)
            .padding(.vertical, 16)
        }
        .buttonStyle(.nmlScale(0.98))
    }

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        normalizeSettings()
        UserDefaults.standard.set(settings.accentColor, forKey: "oxy_accentColor")
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
                Color.mgBg.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    MilgrainSectionHeader(title: "Custom Backend URL")

                    NamelessLineField(
                        placeholder: "https://your-backend.run.app",
                        text: $draft
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)

                    Text("Leave blank to use the default Cloud Run backend.")
                        .font(.system(size: 12, weight: .light))
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
                        .foregroundStyle(Color.mgHeading)
                    Text(description)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.mgSecondary)
                }
                Spacer()
                Text(selection)
                    .font(.nmlBody(13, weight: .medium))
                    .tracking(0.2)
                    .foregroundStyle(Color.mgHeading)
            }

            Slider(value: value, in: 0...Double(OxySettings.autonomyLevels.count - 1), step: 1)
                .tint(Color.mgSecondary)

            HStack {
                Text("Quiet")
                Spacer()
                Text("Steady")
                Spacer()
                Text("Active")
            }
            .font(.nmlBody(10, weight: .medium))
            .tracking(0.3)
            .foregroundStyle(Color.mgSecondary)
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

    enum CodingKeys: String, CodingKey {
        case name, userName, autonomy, proactiveBriefings, healthAlerts, locationReminders
        case homeLatitude, homeLongitude, designTemplate, designPalette, designMotion
        case accentColor, appTheme, bubbleStyle, preferredMapsApp, preferredTransportMode, reviewBeforeOpeningApps
        case confirmSensitiveAppOpens
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
