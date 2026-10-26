import SwiftUI

/// Personal settings and the context already saved for this account.
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

    var body: some View {
        SettingsPage(title: "You") {
            SettingsList {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Name")
                        .font(.appBody(13, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                    TextField("", text: $settings.userName,
                        prompt: Text("Add your name").foregroundStyle(Color.appMuted))
                        .font(.appBody(22, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .tint(Color.appAccent)
                        .textContentType(.givenName)
                        .submitLabel(.done)
                        .frame(minHeight: 44)
                        .accessibilityLabel("Name")
                        .onChange(of: settings.userName) { _, _ in
                            SettingsStore.save(settings, userId: appState.userId)
                        }
                }
                .padding(.vertical, 16)
                SettingsRule()
                SettingsNavRow(title: "Home address", subtitle: settings.homeAddress.isEmpty ? "Not set" : settings.homeAddress) {
                    destination = .home
                }
            }

            SettingsList {
                SettingsNavRow(title: "Memory", subtitle: "Saved notes and photo context") { destination = .saved }
            }

            if model.isLoading {
                ProgressView("Loading your details")
                    .font(.appBody(15))
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else if model.failed {
                ErrorBanner(message: "Couldn't load your details.", onRetry: { Task { await model.load(isDemo: appState.isDemoSession) } })
            } else {
                let identity = model.context?.profile.identity ?? []
                let known = areas.filter { !$0.lines.isEmpty && $0.id != "places" }
                if !identity.isEmpty || !known.isEmpty {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Saved context")
                            .font(.appRounded(22, weight: .semibold, relativeTo: .title2))
                            .foregroundStyle(Color.appInk)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(Array(identity.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.appBody(17))
                                .foregroundStyle(Color.appInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(known) { area in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(area.title)
                                    .font(.appBody(14, weight: .medium))
                                    .foregroundStyle(Color.appMuted)
                                    .accessibilityAddTraits(.isHeader)
                                ForEach(Array(area.lines.prefix(3).enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(.appBody(17))
                                        .foregroundStyle(Color.appInk)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                if area.lines.count > 3 {
                                    Button("Show \(area.lines.count - 3) more") { destination = .saved }
                                        .font(.appBody(15, weight: .medium))
                                        .foregroundStyle(Color.appAccent)
                                        .frame(minHeight: 44)
                                        .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    .padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
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
            .environment(\.revealClose, nil)
            .environment(\.colorScheme, colorScheme)
        }
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
        SettingsPage(title: "Home address") {
            VStack(alignment: .leading, spacing: 14) {
                if !settings.homeAddress.isEmpty {
                    Text(settings.homeAddress)
                        .font(.appBody(16, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                }
                AppLineField(placeholder: "Street, town or postcode", text: $draft)
                HStack(spacing: 10) {
                    Button { Task { await find() } } label: { buttonLabel("Find", busy: isFinding, filled: false) }
                        .disabled(draftIsEmpty || isFinding || isSaving)
                        .opacity(draftIsEmpty || isFinding || isSaving ? 0.45 : 1)
                    Button { Task { await save() } } label: { buttonLabel("Save", busy: isSaving, filled: true) }
                        .disabled(draftIsEmpty || isSaving || isFinding)
                        .opacity(draftIsEmpty || isSaving || isFinding ? 0.45 : 1)
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
