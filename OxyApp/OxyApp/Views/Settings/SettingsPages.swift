import SwiftUI

/// Who you are to Adam: a portrait first, every remembered detail one tap further.
struct YouPage: View {
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme
    @State private var settings = SettingsStore.load()
    @State private var model = SettingsContextModel()
    @State private var destination: Destination?

    private enum Destination: Identifiable {
        case saved, home
        var id: String { "\(self)" }
    }

    private struct Area: Identifiable {
        let id: String
        let title: String
        let lines: [String]
    }

    private var areas: [Area] {
        guard let context = model.context else { return [] }
        let profile = context.profile
        let activeGoals = context.goals
            .filter { ["pending", "running", "paused", "failed"].contains($0.status.lowercased()) }
            .map(\.goal)
        let likes = context.preferences.keys.sorted().map { key -> String in
            let name = key.replacingOccurrences(of: "_", with: " ")
            return "\(name.prefix(1).uppercased() + name.dropFirst()): \(context.preferences[key] ?? "")"
        } + profile.context
        return [
            Area(id: "people", title: "People", lines: profile.relationships),
            Area(id: "places", title: "Places", lines: settings.homeAddress.isEmpty ? [] : [settings.homeAddress]),
            Area(id: "work", title: "Work and study", lines: profile.work),
            Area(id: "plans", title: "Plans", lines: profile.goals + activeGoals),
            Area(id: "likes", title: "Preferences", lines: likes)
        ]
    }

    private var introLine: String {
        let identity = model.context?.profile.identity ?? []
        if !identity.isEmpty { return identity.prefix(2).joined(separator: " · ") }
        return areas.contains(where: { !$0.lines.isEmpty }) ? "What Adam has picked up so far" : "Adam learns about you as you talk"
    }

    var body: some View {
        SettingsPage(title: "You") {
            hero

            if model.failed {
                ErrorBanner(message: "Couldn't load your details.", onRetry: { Task { await model.load(isDemo: appState.isDemoSession) } })
            }

            let known = areas.filter { !$0.lines.isEmpty && $0.id != "places" }
            if !known.isEmpty {
                SettingsList {
                    ForEach(Array(known.enumerated()), id: \.element.id) { index, area in
                        if index > 0 { SettingsRule() }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(area.title)
                                .font(.appBody(12, weight: .medium))
                                .foregroundStyle(Color.appMuted)
                            ForEach(Array(area.lines.prefix(3).enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.appBody(15))
                                    .foregroundStyle(Color.appInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if area.lines.count > 3 {
                                Button { destination = .saved } label: {
                                    Text("\(area.lines.count - 3) more")
                                        .font(.appBody(14))
                                        .foregroundStyle(Color.appAccent)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 14)
                    }
                }
            }

            SettingsGroup(title: "Places") {
                SettingsList {
                    SettingsNavRow(
                        title: "Home",
                        subtitle: settings.homeAddress.isEmpty ? "Add your address for arrival reminders" : settings.homeAddress
                    ) { destination = .home }
                }
            }

            SettingsList {
                SettingsNavRow(title: "Memory", subtitle: "See, correct or delete anything") { destination = .saved }
            }
        }
        .task { await model.load(isDemo: appState.isDemoSession) }
        .fullScreenCover(item: $destination, onDismiss: { settings = SettingsStore.load() }) { dest in
            Group {
                switch dest {
                case .saved: MemoryView()
                case .home: HomeAddressPage()
                }
            }
            .swipeToDismiss()
            .environment(\.colorScheme, colorScheme)
        }
    }

    private var hero: some View {
        VStack(spacing: 4) {
            OrbitPortrait(satellites: areas.isEmpty
                ? ["People", "Places", "Work and study", "Plans", "Preferences"].map { .init(id: $0, label: $0, count: 0) }
                : areas.map { .init(id: $0.id, label: $0.title, count: $0.lines.count) })
            HStack(spacing: 8) {
                TextField(
                    "",
                    text: $settings.userName,
                    prompt: Text("Add your name").foregroundStyle(Color.appMuted)
                )
                .font(.appBody(26, weight: .bold))
                .foregroundStyle(Color.appInk)
                .tint(Color.appAccent)
                .multilineTextAlignment(.center)
                .textContentType(.givenName)
                .submitLabel(.done)
                .onChange(of: settings.userName) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
            }
            Text(introLine)
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .settingsSurface(radius: 20)
    }
}

/// Where home is, for arrival reminders and directions.
struct HomeAddressPage: View {
    @Environment(AppState.self) private var appState
    @State private var settings = SettingsStore.load()
    @State private var draft = ""
    @State private var suggestions: [HomeAddressSuggestion] = []
    @State private var isFinding = false
    @State private var isSaving = false
    @State private var errorText: String?

    private var draftIsEmpty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        SettingsPage(title: "Home") {
            VStack(alignment: .leading, spacing: 14) {
                if !settings.homeAddress.isEmpty {
                    Text(settings.homeAddress)
                        .font(.appBody(16, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                }
                AppLineField(placeholder: "Street, town or postcode", text: $draft)
                HStack(spacing: 10) {
                    Button { Task { await find() } } label: { buttonLabel("Find", busy: isFinding, filled: false) }
                        .disabled(draftIsEmpty || isFinding)
                    Button { Task { await save() } } label: { buttonLabel("Save", busy: isSaving, filled: true) }
                        .disabled(draftIsEmpty || isSaving)
                    Spacer(minLength: 0)
                }
                .buttonStyle(.appScale(0.97))

                if let errorText {
                    Text(errorText)
                        .font(.appBody(13, weight: .medium))
                        .foregroundStyle(Color.appDestructive)
                }

                ForEach(suggestions) { suggestion in
                    Button {
                        draft = suggestion.address
                        suggestions = []
                        errorText = nil
                    } label: {
                        Text(suggestion.address)
                            .font(.appBody(15))
                            .foregroundStyle(Color.appInk)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    SettingsDivider()
                }
            }
        }
        .onAppear { draft = settings.homeAddress }
    }

    private func buttonLabel(_ title: String, busy: Bool, filled: Bool) -> some View {
        ZStack {
            if busy { ProgressView().scaleEffect(0.7) } else { Text(title).font(.appBody(14, weight: .semibold)) }
        }
        .foregroundStyle(filled ? Color.appOnAction : Color.appInk)
        .frame(minWidth: 64, minHeight: 38)
        .background(Capsule().fill(filled ? Color.appAction : Color.appAdaptive(dark: .white.opacity(0.1), light: Color.appSurface2)))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func find() async {
        let query = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        isFinding = true
        errorText = nil
        suggestions = []
        defer { isFinding = false }
        do {
            let data = try await APIClient.shared.request(path: "/home-addresses", method: "POST", body: ["query": query])
            let response = try JSONDecoder().decode(HomeAddressSearchResponse.self, from: data)
            suggestions = response.addresses
            if response.addresses.isEmpty {
                errorText = "No UK addresses found. Try a postcode or more of the address."
            }
        } catch {
            errorText = "Couldn't look that up. You can still type it in and save."
        }
    }

    private func save() async {
        let address = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return }
        isSaving = true
        errorText = nil
        do {
            let data = try await APIClient.shared.request(path: "/geocode", method: "POST", body: ["address": address])
            let result = try JSONDecoder().decode(GeocodeResponse.self, from: data)
            settings.homeLatitude = result.lat
            settings.homeLongitude = result.lng
            settings.homeAddress = result.formattedAddress
            draft = result.formattedAddress
            suggestions = []
            SettingsStore.save(settings, userId: appState.userId)
        } catch {
            errorText = "Couldn't find that address. Try being more specific."
        }
        isSaving = false
    }
}

/// What Adam is connected to, then the places to manage it.
struct ConnectionsPage: View {
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme
    @State private var model = SettingsContextModel()
    @State private var destination: Destination?

    private enum Destination: Identifiable {
        case apps, displays, payments, logins, permissions
        var id: String { "\(self)" }
    }

    private var connected: [String] { model.context?.connectedApps ?? [] }

    var body: some View {
        SettingsPage(title: "Connections") {
            VStack(alignment: .leading, spacing: 14) {
                if connected.isEmpty {
                    Text(model.isLoading ? " " : "Nothing connected yet")
                        .font(.appBody(20, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    Text("Connect mail or a calendar and Adam can start helping.")
                        .font(.appBody(14))
                        .foregroundStyle(Color.appMuted)
                } else {
                    Text("Adam can use")
                        .font(.appBody(13, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(connected, id: \.self) { name in
                            SettingsStatement(text: name)
                        }
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface(radius: 20)

            SettingsList {
                SettingsNavRow(title: "Apps", subtitle: "Mail, calendar, messages and more", lead: .icon("cube")) { destination = .apps }
                SettingsRule(inset: 34)
                SettingsNavRow(title: "Displays", subtitle: "Screens Adam can show things on", lead: .icon("photo")) { destination = .displays }
                SettingsRule(inset: 34)
                SettingsNavRow(title: "Payment methods", lead: .icon("card")) { destination = .payments }
                SettingsRule(inset: 34)
                SettingsNavRow(title: "Saved logins", lead: .icon("person-check")) { destination = .logins }
            }

            SettingsList {
                SettingsNavRow(title: "Permissions", subtitle: "What Adam does on its own", lead: .icon("shield-check")) { destination = .permissions }
            }
        }
        .task { await model.load(isDemo: appState.isDemoSession) }
        .fullScreenCover(item: $destination) { dest in
            Group {
                switch dest {
                case .apps: ConnectorsView()
                case .displays: PairedDisplaysView()
                case .payments: PaymentsView()
                case .logins: VaultView()
                case .permissions: PermissionsPage()
                }
            }
            .swipeToDismiss()
            .environment(\.colorScheme, colorScheme)
        }
    }
}

/// Look and feel, notifications and the maps app. Everything else Adam learns.
struct PreferencesPage: View {
    @Environment(AppState.self) private var appState
    @AppStorage(HouseholdSoundMonitor.preferenceKey) private var soundAwarenessEnabled = false
    @AppStorage(ThreadBackground.storageKey) private var backgroundRaw = ThreadBackground.automatic.rawValue
    @AppStorage(ThreadMenuChoice.orderKey) private var wheelOrderRaw = ""
    @State private var settings = SettingsStore.load()
    @State private var showsWheelEditor = false

    var body: some View {
        SettingsPage(title: "Preferences") {
            AutonomyDial()

            SettingsList {
                SettingsNavRow(title: "Your wheel", subtitle: "Choose what's in reach") { showsWheelEditor = true }
            }

            SettingsGroup(title: "Appearance") {
                HStack(spacing: 0) {
                    ForEach(ThreadBackground.allCases) { option in
                        Button {
                            HapticManager.shared.select()
                            backgroundRaw = option.rawValue
                        } label: {
                            VStack(spacing: 10) {
                                Circle()
                                    .fill(option.swatch)
                                    .frame(width: 54, height: 54)
                                    .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
                                    .overlay(
                                        Circle()
                                            .strokeBorder(Color.appAccent, lineWidth: backgroundRaw == option.rawValue ? 2.5 : 0)
                                            .padding(-5)
                                    )
                                Text(option.title)
                                    .font(.appBody(13, weight: backgroundRaw == option.rawValue ? .semibold : .regular))
                                    .foregroundStyle(backgroundRaw == option.rawValue ? Color.appInk : Color.appMuted)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .padding(.vertical, 16)
                        }
                        .buttonStyle(.appScale)
                        .accessibilityAddTraits(backgroundRaw == option.rawValue ? .isSelected : [])
                    }
                }
                .settingsSurface()
            }

            SettingsGroup(title: "Open directions in") {
                AppSegmented(
                    options: ["apple", "google"],
                    labels: ["Apple Maps", "Google Maps"],
                    selection: $settings.preferredMapsApp
                )
            }

            SettingsGroup(title: "Notifications") {
                SettingsList {
                    SettingsToggleRow(title: "Arriving and leaving", isOn: $settings.locationReminders)
                    SettingsRule()
                    SettingsToggleRow(title: "Daily check-in", isOn: $settings.proactiveBriefings)
                    SettingsRule()
                    SettingsToggleRow(
                        title: "Alarms and doorbells",
                        subtitle: "Listens while Adam is open. Stays on this iPhone",
                        isOn: $soundAwarenessEnabled
                    )
                }
            }
        }
        // Colours are looked up when drawn; a new id makes this page redraw in the theme just chosen.
        .id(backgroundRaw)
        .preferredColorScheme((ThreadBackground(rawValue: backgroundRaw) ?? .automatic).scheme)
        .sheet(isPresented: $showsWheelEditor) {
            WheelEditorSheet(orderRaw: $wheelOrderRaw)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .onChange(of: settings.preferredMapsApp) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
        .onChange(of: settings.locationReminders) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
        .onChange(of: settings.proactiveBriefings) { _, _ in SettingsStore.save(settings, userId: appState.userId) }
        .onChange(of: soundAwarenessEnabled) { _, enabled in
            Task { await HouseholdSoundMonitor.shared.setEnabled(enabled, userId: appState.userId) }
        }
    }
}
