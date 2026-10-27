import SwiftUI

// MARK: - Model

/// The current state of the home as Adam can know it (GET /agent/home). Devices, rooms, watches and
/// sensed events; conversation never appears here. Unknown stays unknown.
struct HomeModel: Codable, Equatable {
    struct Presence: Codable, Equatable {
        let state: String
        let homeConfigured: Bool
    }
    struct Device: Codable, Equatable, Hashable, Identifiable {
        let id: String
        let name: String
        let kind: String
        let room: String?
        let online: Bool
        let lastSeenAt: String?
        var capabilities: [String]? = nil
        var showsUrgent: Bool { capabilities?.contains("urgent") == true }
    }
    struct Room: Codable, Equatable, Hashable, Identifiable {
        let name: String
        let devices: [Device]
        let active: Bool
        var id: String { name }
    }
    struct Watch: Codable, Equatable, Hashable, Identifiable {
        let id: String
        let title: String
        let detail: String?
        let nextRunAt: String?
    }
    /// Something a device sensed or Adam inferred. Never a chat message or a reaction.
    struct Observation: Codable, Equatable, Hashable, Identifiable {
        let id: String
        let kind: String
        let room: String?
        let summary: String
        let at: String
        let source: String
    }

    let presence: Presence
    let devices: [Device]
    let rooms: [Room]
    let unassignedDevices: [Device]
    let watches: [Watch]
    let observations: [Observation]

    static let empty = HomeModel(
        presence: Presence(state: "unknown", homeConfigured: false),
        devices: [], rooms: [], unassignedDevices: [], watches: [], observations: []
    )
}

enum HomeService {
    static func fetch() async throws -> HomeModel {
        let data = try await APIClient.shared.request(path: "/agent/home")
        return try JSONDecoder().decode(HomeModel.self, from: data)
    }
}

/// Moves from something Adam knows to asking Adam about it: the thread picks this up as a draft.
@MainActor
enum AskAdam {
    static let notification = Notification.Name("AdamAskDraft")
    /// Unlike a draft, this sends the text straight away.
    static let sendNotification = Notification.Name("AdamAskSend")

    static func draft(_ text: String) {
        HapticManager.shared.impact(.light)
        NotificationCenter.default.post(name: notification, object: text)
    }
}

// MARK: - Your home

struct YourHomeView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.revealClose) private var revealClose
    @State private var home: HomeModel = .empty
    @State private var settings = OxySettings()
    @State private var loaded = false
    @State private var failed = false
    @State private var isRefreshing = false
    @State private var showsDeviceSetup = false
    @State private var showsDisplaySetup = false
    @State private var selectedDevice: HomeModel.Device?
    @State private var showsSettings = false
    @State private var urgentChoice: [String: Bool] = [:]
    @State private var urgentErrors: [String: String] = [:]
    @State private var urgentPending: Set<String> = []

    private var hasDevices: Bool { !home.devices.isEmpty }
    private var onlineCount: Int { home.devices.filter(\.online).count }
    private var needsAddress: Bool { settings.homeLatitude == nil && settings.homeAddress.isEmpty }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
            ScreenHeaderView(title: "Your home", onBack: revealClose == nil ? { dismiss() } : nil)
            GeometryReader { geometry in
              ScrollViewReader { proxy in
              ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: AppSpacing.xxl) {
                    if failed {
                        ErrorBanner(message: "Couldn't load your home.", onRetry: { Task { await load() } })
                            .disabled(isRefreshing)
                    }

                    if !loaded {
                        OxySkeletonCard(height: 88)
                        OxySkeletonCard(height: 144)
                    } else if hasDevices {
                        stateHeader
                        devicesSection
                    } else if loaded && !failed {
                        notConnected
                    }

                    watchingSection
                    if hasDevices { noticedSection }
                    addressSection
                }
                .frame(width: max(0, geometry.size.width - AppSpacing.margin * 2), alignment: .leading)
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 10)
                .padding(.bottom, 40)
              }
              #if DEBUG
              .task(id: home) {
                  guard PreviewData.isIsolated, let focus = ProcessInfo.processInfo.environment["OXY_DEBUG_HOME_FOCUS"] else { return }
                  try? await Task.sleep(for: .seconds(1))
                  guard !Task.isCancelled else { return }
                  let device = focus == "last-device" ? home.devices.last : home.devices.first
                  if let device { proxy.scrollTo("home-device-\(device.id)", anchor: .bottom) }
              }
              #endif
              }
            }
            }
            .background(Color.appBackground.ignoresSafeArea())
            .refreshable { await load() }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task {
            await load()
            #if DEBUG
            if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_HOME_DETAIL"] == "1" {
                try? await Task.sleep(for: .milliseconds(700))
                selectedDevice = home.devices.first
            }
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, loaded { Task { await load() } }
        }
        .sheet(item: $selectedDevice) { selected in
            if let device = home.devices.first(where: { $0.id == selected.id }) {
                deviceDetails(device)
            } else {
                SettingsPage(title: "Display") {
                    Text("This display is no longer available.")
                        .font(.appBody(16)).foregroundStyle(Color.appMuted)
                }
            }
        }
        .sheet(isPresented: $showsDeviceSetup) {
            PendantStatusView().presentationDetents([.large])
        }
        .sheet(isPresented: $showsDisplaySetup) {
            PairedDisplaysView().presentationDetents([.large])
        }
        .fullScreenCover(isPresented: $showsSettings) {
            HomeAddressPage().swipeToDismiss()
        }
    }

    // MARK: Not connected

    private var notConnected: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            Text("Nothing is paired yet.")
                .font(.role(.title)).foregroundStyle(Color.appInk)
            Text("Pair a display and its status shows here.")
                .font(.role(.body)).foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                HapticManager.shared.impact(.medium)
                showsDisplaySetup = true
            } label: {
                Text("Add a display")
                    .font(.role(.callout, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, AppSpacing.xl)
                    .frame(minHeight: 48)
                    .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.97))
        }
    }

    // MARK: Connected

    private var stateHeader: some View {
        Text(failed ? "Status unavailable. Last loaded: \(subline)." : "\(subline). \(headline).")
            .font(.role(.body)).foregroundStyle(Color.appMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var headline: String {
        switch home.presence.state {
        case "home" where home.presence.homeConfigured: return "You're home"
        case "away" where home.presence.homeConfigured: return "You're out"
        default: return "Location unknown"
        }
    }

    private var subline: String {
        let noun = home.devices.count == 1 ? "display" : "displays"
        return "\(onlineCount) of \(home.devices.count) \(noun) online"
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                Text("Devices").font(.role(.title)).foregroundStyle(Color.appInk)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Button { showsDisplaySetup = true } label: {
                    Text("Add").font(.role(.callout, weight: .semibold))
                        .foregroundStyle(Color.appAccent).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add a display")
            }
            VStack(spacing: 0) {
                ForEach(home.devices) { device in
                    deviceRow(device).id("home-device-\(device.id)")
                }
            }
        }
    }

    /// A device is an object with a name and a state: one row each, the state in words beside a dot.
    private func deviceRow(_ device: HomeModel.Device) -> some View {
        Button { selectedDevice = device } label: {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                StatusDot(color: device.online && !failed ? Color.appSuccess : Color.appMuted.opacity(0.45))
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name).font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                    Text(deviceState(device)).font(.role(.callout)).foregroundStyle(Color.appMuted)
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                AppIcon("chevron-right", size: 13).foregroundStyle(Color.appMuted).accessibilityHidden(true)
            }
            .padding(.vertical, AppSpacing.md)
            .frame(minHeight: 60)
            .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    private func deviceState(_ device: HomeModel.Device) -> String {
        let state = failed ? (device.online ? "Last reported online" : "Last reported offline")
            : (device.online ? "Online" : "Offline · \(lastSeen(device))")
        return [device.room, state].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder
    private var watchingSection: some View {
        if !home.watches.isEmpty {
            section("Watching") {
                ForEach(Array(home.watches.enumerated()), id: \.element.id) { index, watch in
                                        row(title: watch.title, detail: watch.detail ?? nextCheck(watch), dot: .appWorking) {
                        AskAdam.draft("What's happening with: \(watch.title)?")
                    }
                }
            }
        }
    }

    /// Urgent alerts are a choice made per screen: pairing a screen is not consent to put an alarm on it.
    private func deviceDetails(_ device: HomeModel.Device) -> some View {
        SettingsPage(title: device.name) {
            VStack(alignment: .leading, spacing: 18) {
                AppIcon(device.kind == "browser" ? "display" : "cube", size: 44)
                    .foregroundStyle(Color.appInk).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(failed ? "Status unavailable" : (device.online ? "Online" : "Offline"))
                        .font(.title2.weight(.bold)).foregroundStyle(Color.appInk)
                    if let date = Date.oxyParse(device.lastSeenAt) {
                        Text("Last seen \(date.formatted(.relative(presentation: .named)))")
                            .font(.appBody(15)).foregroundStyle(Color.appInk)
                    } else {
                        Text("Last seen unknown").font(.appBody(15)).foregroundStyle(Color.appInk)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(device.online && !failed ? Color.appHomeSurface : Color.appSurface2,
                        in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .combine)
            SettingsList {
                SettingsRow(title: "Room", subtitle: device.room ?? "Not assigned")
                SettingsRule()
                SettingsRow(title: "Urgent alerts", subtitle: "Show alerts on this screen") {
                    SettingsToggle(isOn: Binding(
                        get: { urgentChoice[device.id] ?? device.showsUrgent },
                        set: { setUrgent(device, $0) }
                    ))
                    .disabled(failed || urgentPending.contains(device.id))
                    .accessibilityLabel("Urgent alerts on \(device.name)")
                }
                if urgentPending.contains(device.id) {
                    Text("Saving…").font(.appBody(14)).foregroundStyle(Color.appMuted)
                        .padding(.bottom, 12)
                }
                if let error = urgentErrors[device.id] {
                    Text(error).font(.appBody(14)).foregroundStyle(Color.appDestructive)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 12)
                }
            }
            Button {
                selectedDevice = nil
                AskAdam.draft("How is the \(device.name) doing?")
            } label: {
                Text("Ask about this display")
                    .font(.appBody(16, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 48)
                    .background(Color.appAction, in: Capsule())
            }
            .buttonStyle(.appScale)
            .accessibilityHint("Opens a draft in the conversation")
        }
        .refreshable { await load() }
    }

    private func setUrgent(_ device: HomeModel.Device, _ enabled: Bool) {
        guard !failed, !urgentPending.contains(device.id) else { return }
        let before = urgentChoice[device.id] ?? device.showsUrgent
        urgentChoice[device.id] = enabled
        urgentErrors[device.id] = nil
        urgentPending.insert(device.id)
        HapticManager.shared.impact(.light)
        Task {
            defer { urgentPending.remove(device.id) }
            do {
                let data = try await APIClient.shared.request(path: "/agent/displays/\(device.id)/urgent", method: "PUT", body: ["enabled": enabled])
                let result = try JSONDecoder().decode(UrgentPreferenceResponse.self, from: data)
                if result.id != device.id || result.urgent != enabled {
                    urgentChoice[device.id] = before
                    urgentErrors[device.id] = "Couldn't confirm alerts for \(device.name)."
                }
            } catch {
                urgentChoice[device.id] = before
                urgentErrors[device.id] = "Couldn't change alerts for \(device.name)."
            }
        }
    }

    private struct UrgentPreferenceResponse: Decodable {
        let id: String
        let urgent: Bool
    }

    /// Only what a device sensed or Adam inferred. Empty until hardware reports something.
    @ViewBuilder
    private var noticedSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            sectionTitle("Noticed")
            if home.observations.isEmpty {
                Text("Nothing reported by your devices yet.")
                    .font(.role(.body)).foregroundStyle(Color.appMuted)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(home.observations.enumerated()), id: \.element.id) { index, item in
                                                row(title: item.summary, detail: observationDetail(item), dot: nil) {
                            AskAdam.draft("Tell me more about: \(item.summary)")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var addressSection: some View {
        if loaded && needsAddress {
            section("Set up") {
                row(title: "Set your home location", detail: "For arrival and leaving reminders", dot: nil, chevron: true) {
                    showsSettings = true
                }
            }
        }
    }

    // MARK: Building blocks

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.role(.title))
            .foregroundStyle(Color.appInk)
            .accessibilityAddTraits(.isHeader)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            sectionTitle(title)
            VStack(spacing: 0) { content() }
        }
    }

    private var divider: some View {
        SettingsRule()
    }

    private func row(title: String, detail: String?, dot: Color?, chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                if let dot { StatusDot(color: dot, hollow: true) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.role(.body, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.role(.callout))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                AppIcon(chevron ? "chevron-right" : "arrow-up-right", size: 12)
                    .foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, AppSpacing.md)
            .frame(minHeight: 52)
            .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    // MARK: Formatting

    private func lastSeen(_ device: HomeModel.Device) -> String {
        guard let raw = device.lastSeenAt, let date = Date.oxyParse(raw) else { return "Last seen unknown" }
        return "last seen \(date.formatted(.relative(presentation: .named)))"
    }

    private func nextCheck(_ watch: HomeModel.Watch) -> String? {
        guard let raw = watch.nextRunAt, let date = Date.oxyParse(raw), date > Date() else { return nil }
        return "Next check \(date.formatted(.relative(presentation: .named)))"
    }

    private func observationDetail(_ item: HomeModel.Observation) -> String {
        let when = Date.oxyParse(item.at).map { $0.formatted(.relative(presentation: .named)) } ?? ""
        let how: String
        switch item.source {
        case "sensor": how = "Sensed"
        case "inferred": how = "Inferred"
        default: how = "Reported"
        }
        return [item.room, how, when].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Loading

    private func load() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if PreviewData.isIsolated, ["connected", "online", "offline", "unknown-seen", "cached-failure", "urgent-failure"].contains(env["OXY_DEBUG_HOME"] ?? "") {
            home = env["OXY_DEBUG_HOME"] == "offline" ? Self.sampleOffline : (env["OXY_DEBUG_HOME"] == "online" ? Self.sampleOnline : Self.sampleConnected)
            if env["OXY_DEBUG_HOME"] == "unknown-seen" {
                let device = HomeModel.Device(id: "unknown-seen", name: "Unassigned display", kind: "browser", room: nil, online: false, lastSeenAt: nil)
                home = HomeModel(presence: .init(state: "unknown", homeConfigured: false), devices: [device], rooms: [], unassignedDevices: [device], watches: [], observations: [])
            }
            loaded = true
            failed = env["OXY_DEBUG_HOME"] == "cached-failure"
            if env["OXY_DEBUG_HOME"] == "urgent-failure", let device = home.devices.first {
                setUrgent(device, true)
            }
            return
        }
        if PreviewData.isIsolated, env["OXY_DEBUG_HOME"] == "empty" {
            home = .empty
            loaded = true
            return
        }
        #endif
        do {
            home = try await HomeService.fetch()
            failed = false
        } catch {
            failed = true
        }
        loaded = true
    }

    #if DEBUG
    static let sampleConnected: HomeModel = {
        let seen = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30))
        let living = HomeModel.Device(id: "d1", name: "Living room display", kind: "browser", room: "Living room", online: true, lastSeenAt: seen)
        let kitchen = HomeModel.Device(id: "d2", name: "Kitchen display", kind: "browser", room: "Kitchen", online: false,
                                       lastSeenAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)))
        return HomeModel(
            presence: .init(state: "unknown", homeConfigured: false),
            devices: [living, kitchen],
            rooms: [.init(name: "Living room", devices: [living], active: true), .init(name: "Kitchen", devices: [kitchen], active: false)],
            unassignedDevices: [],
            watches: [.init(id: "w1", title: "Flight price check", detail: "Tell me when the price drops", nextRunAt: nil)],
            observations: []
        )
    }()
    static var sampleOnline: HomeModel {
        let seen = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30))
        let devices = sampleConnected.devices.map { device in
            HomeModel.Device(id: device.id, name: device.name, kind: device.kind, room: device.room,
                online: true, lastSeenAt: seen, capabilities: device.capabilities)
        }
        return HomeModel(presence: .init(state: "unknown", homeConfigured: false), devices: devices,
            rooms: sampleConnected.rooms.map { room in .init(name: room.name, devices: devices.filter { $0.room == room.name }, active: true) },
            unassignedDevices: [], watches: sampleConnected.watches, observations: [])
    }
    static var sampleOffline: HomeModel {
        let seen = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600))
        let devices = sampleConnected.devices.map { device in
            HomeModel.Device(id: device.id, name: device.name, kind: device.kind, room: device.room,
                online: false, lastSeenAt: seen, capabilities: device.capabilities)
        }
        return HomeModel(presence: .init(state: "unknown", homeConfigured: false), devices: devices,
            rooms: sampleConnected.rooms.map { room in .init(name: room.name, devices: devices.filter { $0.room == room.name }, active: false) },
            unassignedDevices: [], watches: sampleConnected.watches, observations: [])
    }
    #endif
}
