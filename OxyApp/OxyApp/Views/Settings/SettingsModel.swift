import SwiftUI
import UIKit

struct BackendURLEditorSheet: View {
    @Binding var currentURL: String
    let onDone: () -> Void
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            ZStack {
                GlebChrome.pastelBlob.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    SettingsSectionHeader(title: "Custom Backend URL")

                    AppLineField(
                        placeholder: "https://your-backend.run.app",
                        text: $draft
                    )
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)

                    Text("Leave blank for the default backend.")
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)

                    if !currentURL.isEmpty {
                        Button(role: .destructive) {
                            draft = ""
                            currentURL = ""
                            onDone()
                        } label: {
                            Text("Reset to default")
                                .font(.appBody(14, weight: .medium))
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
                        .foregroundStyle(Color.appInk)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        currentURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        onDone()
                    }
                    .font(.appBody(15, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                }
            }
        }
        .onAppear { draft = currentURL }
    }
}

struct PairedDisplaysView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var displays: [PairedDisplay] = []
    @State private var pairingName = ""
    @State private var challenge: DisplayPairingChallenge?
    @State private var pendingRevoke: PairedDisplay?
    @State private var showRevokeConfirmation = false
    @State private var isLoading = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var copied = false

    var body: some View {
        SettingsPage(title: "Displays") {
            if let errorMessage {
                ErrorBanner(message: errorMessage, onRetry: { Task { await loadDisplays() } })
            }

            SettingsGroup(title: "Pair a display") {
                VStack(alignment: .leading, spacing: 14) {
                    AppLineField(placeholder: "Name (optional)", text: $pairingName)
                    Button {
                        HapticManager.shared.impact(.light)
                        Task { await createPairing() }
                    } label: {
                        Text(isWorking ? "Creating code…" : "Create pairing code")
                            .font(.appBody(15, weight: .medium))
                            .foregroundStyle(Color.appOnAction)
                            .padding(.horizontal, 20)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(Color.appAction))
                    }
                    .buttonStyle(.appScale(0.97))
                    .disabled(isWorking)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .settingsSurface()
            }

            if let challenge {
                SettingsGroup(title: "On the display") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Open this link, then enter the code")
                            .font(.appBody(14))
                            .foregroundStyle(Color.appMuted)
                        Text(challenge.displayUrl)
                            .font(.appMono(12))
                            .foregroundStyle(Color.appInk)
                            .textSelection(.enabled)
                        HStack(alignment: .firstTextBaseline) {
                            Text(challenge.code)
                                .font(.appMono(32, weight: .semibold))
                                .foregroundStyle(Color.appInk)
                                .textSelection(.enabled)
                            Spacer()
                            Button {
                                UIPasteboard.general.string = challenge.code
                                HapticManager.shared.success()
                                copied = true
                            } label: {
                                Text(copied ? "Copied" : "Copy code")
                                    .font(.appBody(14, weight: .medium))
                                    .foregroundStyle(Color.appAccent)
                                    .frame(minHeight: 44)
                            }
                            .buttonStyle(.plain)
                        }
                        Text("Works once. Expires in 10 minutes.")
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .settingsSurface()
                }
            }

            SettingsGroup(title: "Paired") {
                if isLoading {
                    OxySkeletonCard(height: 60, cornerRadius: 16)
                } else if displays.isEmpty {
                    SettingsStatement(text: "No displays paired", solid: false)
                        .padding(.horizontal, 4)
                } else {
                    SettingsList {
                        ForEach(Array(displays.enumerated()), id: \.element.id) { index, display in
                            if index > 0 { SettingsRule() }
                            SettingsRow(title: display.name, subtitle: displayPresenceLabel(display)) {
                                Button {
                                    pendingRevoke = display
                                    showRevokeConfirmation = true
                                } label: {
                                    Text("Forget")
                                        .font(.appBody(14, weight: .medium))
                                        .foregroundStyle(Color.appDestructive)
                                        .frame(minWidth: 44, minHeight: 44)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .task { await loadDisplays() }
        .refreshable { await loadDisplays() }
        .confirmationDialog(
            "Forget this display?",
            isPresented: $showRevokeConfirmation,
            titleVisibility: .visible
        ) {
            if let display = pendingRevoke {
                Button("Forget \(display.name)", role: .destructive) {
                    Task { await revoke(display) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func loadDisplays() async {
        isLoading = true
        errorMessage = nil
        do {
            displays = try await PairedDisplaysService.fetchDisplays()
        } catch {
            errorMessage = "Couldn’t load paired displays."
        }
        isLoading = false
    }

    private func createPairing() async {
        isWorking = true
        errorMessage = nil
        copied = false
        do {
            challenge = try await PairedDisplaysService.createPairing(displayName: pairingName)
        } catch {
            errorMessage = "Couldn’t start pairing."
        }
        isWorking = false
    }

    private func revoke(_ display: PairedDisplay) async {
        isWorking = true
        errorMessage = nil
        do {
            try await PairedDisplaysService.revokeDisplay(id: display.id)
            displays.removeAll { $0.id == display.id }
        } catch {
            errorMessage = "Couldn’t forget that display."
        }
        isWorking = false
    }

    private func displayPresenceLabel(_ display: PairedDisplay) -> String {
        guard let raw = display.lastSeenAt,
              let seenAt = DisplayTimestampParser.date(from: raw) else {
            return "Not seen yet"
        }
        let age = max(0, Date().timeIntervalSince(seenAt))
        if age < 120 { return "Seen just now" }
        if age < 3_600 { return "Seen \(Int(age / 60)) min ago" }
        if age < 86_400 { return "Seen \(Int(age / 3_600)) hr ago" }
        return "Last seen \(Int(age / 86_400)) d ago"
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
    /// Human-readable label for the saved home address (display only — homeLatitude/
    /// homeLongitude are what the server actually uses for ride destinations).
    var homeAddress: String = ""
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
        case homeLatitude, homeLongitude, homeAddress, designTemplate, designPalette, designMotion
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
        homeAddress = try container.decodeIfPresent(String.self, forKey: .homeAddress) ?? ""
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
