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
                VStack(alignment: .leading, spacing: 30) {
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
        VStack(alignment: .leading, spacing: 28) {
            AppIcon("wheel-home", size: 32)
                .foregroundStyle(Color.appMuted)
                .frame(width: 76, height: 76)
                .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 22))
            VStack(alignment: .leading, spacing: 8) {
                Text("Your home isn't connected yet")
                    .font(.sectionTitle)
                    .foregroundStyle(Color.appInk)
                Text("Add a device to see its status here.")
                    .font(.appBody(15))
                    .foregroundStyle(Color.appMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                HapticManager.shared.impact(.medium)
                showsDeviceSetup = true
            } label: {
                Text("Set up Adam")
                    .font(.appBody(16, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 48)
                    .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.97))


        }
    }

    // MARK: Connected

    private var stateHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(failed ? "Status unavailable" : subline)
                .font(.title2.weight(.bold)).foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
            Text(failed ? "Last loaded: \(subline)" : headline)
                .font(.appBody(15)).foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var headline: String {
        switch home.presence.state {
        case "home" where home.presence.homeConfigured: return "You're home"
        case "away" where home.presence.homeConfigured: return "You're out"
        default: return "Location unknown"
        }
    }

    private var subline: String {
        let noun = home.devices.count == 1 ? "device" : "devices"
        return "\(onlineCount) of \(home.devices.count) \(noun) online"
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
            layout {
                Text("Devices").font(.sectionTitle).foregroundStyle(Color.appInk)
                    .accessibilityAddTraits(.isHeader)
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                Button { showsDisplaySetup = true } label: {
                    HStack(spacing: 6) {
                        AppIcon("plus", size: 14).accessibilityHidden(true)
                        Text("Add display").font(.appBody(14, weight: .medium))
                    }
                    .foregroundStyle(Color.appAccent).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
            if typeSize.isAccessibilitySize {
                VStack(spacing: 14) { ForEach(home.devices) { deviceTile($0).id("home-device-\($0.id)") } }
            } else {
                LazyVGrid(columns: home.devices.count == 1
                          ? [GridItem(.flexible(), alignment: .top)]
                          : [GridItem(.adaptive(minimum: 150), spacing: 12, alignment: .top)], spacing: 12) {
                    ForEach(home.devices) { deviceTile($0).id("home-device-\($0.id)") }
                }
            }
        }
    }

    private func deviceTile(_ device: HomeModel.Device) -> some View {
        Button { selectedDevice = device } label: {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    AppIcon(device.kind == "browser" ? "display" : "cube", size: 32)
                        .foregroundStyle(Color.appInk).accessibilityHidden(true)
                    Spacer(minLength: 0)
                    AppIcon("arrow-up-right", size: 15).foregroundStyle(Color.appInk).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(device.room ?? "Not assigned to a room")
                        .font(.appBody(13)).foregroundStyle(Color.appInk)
                    Text(device.name).font(.appBody(17, weight: .semibold)).foregroundStyle(Color.appInk)
                    Text(failed ? (device.online ? "Last reported online" : "Last reported offline") : (device.online ? "Online" : "Offline"))
                        .font(.appBody(14, weight: .medium)).foregroundStyle(Color.appInk)
                    if !device.online {
                        Text(lastSeen(device)).font(.appBody(13)).foregroundStyle(Color.appInk)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            .background(device.online && !failed ? Color.appHomeSurface : Color.appSurface2,
                        in: RoundedRectangle(cornerRadius: 16))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.appScale)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var watchingSection: some View {
        if !home.watches.isEmpty {
            section("Watching") {
                ForEach(Array(home.watches.enumerated()), id: \.element.id) { index, watch in
                    if index > 0 { divider }
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
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Noticed recently")
            if home.observations.isEmpty {
                Text("No recent device reports")
                    .font(.appBody(15)).foregroundStyle(Color.appMuted)
                    .padding(.horizontal, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(home.observations.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { divider }
                        row(title: item.summary, detail: observationDetail(item), dot: nil) {
                            AskAdam.draft("Tell me more about: \(item.summary)")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .settingsSurface()
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
            .font(.sectionLabel)
            .foregroundStyle(Color.appMuted)
            .padding(.horizontal, 4)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle(title)
            VStack(spacing: 0) { content() }
                .padding(.horizontal, 16)
                .settingsSurface()
        }
    }

    private var divider: some View {
        SettingsRule()
    }

    private func row(title: String, detail: String?, dot: Color?, chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                AppIcon(chevron ? "chevron-right" : "arrow-up-right", size: 12)
                    .foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 14)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    // MARK: Formatting

    private func lastSeen(_ device: HomeModel.Device) -> String {
        guard let raw = device.lastSeenAt, let date = Date.oxyParse(raw) else { return "Last seen unknown" }
        return "Last heard from \(date.formatted(.relative(presentation: .named)))"
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
        if PreviewData.isIsolated, ["connected", "offline", "unknown-seen", "cached-failure", "urgent-failure"].contains(env["OXY_DEBUG_HOME"] ?? "") {
            home = env["OXY_DEBUG_HOME"] == "offline" ? Self.sampleOffline : Self.sampleConnected
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
    private static let sampleConnected: HomeModel = {
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
    private static var sampleOffline: HomeModel {
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
