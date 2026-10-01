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

    static func draft(_ text: String) {
        HapticManager.shared.impact(.light)
        NotificationCenter.default.post(name: notification, object: text)
    }
}

// MARK: - Your home

struct YourHomeView: View {
    @State private var home: HomeModel = .empty
    @State private var settings = OxySettings()
    @State private var loaded = false
    @State private var failed = false
    @State private var showsDeviceSetup = false
    @State private var showsSettings = false

    private var hasDevices: Bool { !home.devices.isEmpty }
    private var onlineCount: Int { home.devices.filter(\.online).count }
    private var needsAddress: Bool { settings.homeLatitude == nil && settings.homeAddress.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 30) {
                    Text("Your home")
                        .font(.title.weight(.semibold))
                        .foregroundStyle(Color.appInk)

                    if failed {
                        ErrorBanner(message: "Couldn't load your home.", onRetry: { Task { await load() } })
                    }

                    if hasDevices {
                        stateHeader
                        roomsSection
                        unassignedSection
                    } else if loaded && !failed {
                        notConnected
                    }

                    watchingSection
                    if hasDevices { noticedSection }
                    addressSection
                }
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 18)
                .padding(.bottom, 40)
            }
            .background(Color.appBackground.ignoresSafeArea())
            .refreshable { await load() }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .sheet(isPresented: $showsDeviceSetup) {
            PendantStatusView().presentationDetents([.large])
        }
        .fullScreenCover(isPresented: $showsSettings) {
            SettingsView().swipeToDismiss()
        }
    }

    // MARK: Not connected

    private var notConnected: some View {
        VStack(alignment: .leading, spacing: 22) {
            AdamPresence(state: .complete, size: 72)
            VStack(alignment: .leading, spacing: 8) {
                Text("Your home isn't connected yet")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.appInk)
                Text("Connect Adam to give it awareness of what's happening around your home.")
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

            VStack(alignment: .leading, spacing: 0) {
                previewRow("Answers out loud, in the room")
                Rectangle().fill(Color.appCardOutline).frame(height: 1)
                previewRow("Notices what changes around the house")
                Rectangle().fill(Color.appCardOutline).frame(height: 1)
                previewRow("Keeps watching for what you ask it to")
            }
            .padding(.horizontal, 16)
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.appCardOutline, lineWidth: 1))
        }
    }

    private func previewRow(_ text: String) -> some View {
        Text(text)
            .font(.appBody(14))
            .foregroundStyle(Color.appMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 14)
    }

    // MARK: Connected

    private var stateHeader: some View {
        HStack(alignment: .center, spacing: 18) {
            AdamPresence(state: onlineCount > 0 ? .idle : .complete, size: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Text(subline)
                    .font(.appBody(14))
                    .foregroundStyle(Color.appMuted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private var headline: String {
        switch home.presence.state {
        case "home": return "You're home"
        case "away": return "You're out"
        default: return onlineCount > 0 ? "Listening" : "Offline"
        }
    }

    private var subline: String {
        if onlineCount == 0 { return home.devices.count == 1 ? "Adam is offline" : "Your Adam devices are offline" }
        return onlineCount == 1 ? "Adam is listening" : "\(onlineCount) Adam devices listening"
    }

    @ViewBuilder
    private var roomsSection: some View {
        ForEach(home.rooms) { room in
            section(room.name) {
                ForEach(Array(room.devices.enumerated()), id: \.element.id) { index, device in
                    if index > 0 { divider }
                    deviceRow(device)
                }
            }
        }
    }

    @ViewBuilder
    private var unassignedSection: some View {
        if !home.unassignedDevices.isEmpty {
            section(home.rooms.isEmpty ? "Adam" : "Not in a room yet") {
                ForEach(Array(home.unassignedDevices.enumerated()), id: \.element.id) { index, device in
                    if index > 0 { divider }
                    deviceRow(device)
                }
            }
        }
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

    /// Only what a device sensed or Adam inferred. Empty until hardware reports something.
    @ViewBuilder
    private var noticedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Noticed recently")
            if home.observations.isEmpty {
                Text("Nothing noticed yet.")
                    .font(.appBody(14))
                    .foregroundStyle(Color.appMuted)
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
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.appReceivedBubble))
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
            .font(.appBody(13, weight: .semibold))
            .foregroundStyle(Color.appMuted)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle(title)
            VStack(spacing: 0) { content() }
                .padding(.horizontal, 16)
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.appReceivedBubble))
        }
    }

    private var divider: some View {
        Rectangle().fill(Color.appCardOutline).frame(height: 1)
    }

    private func deviceRow(_ device: HomeModel.Device) -> some View {
        row(title: device.name, detail: device.online ? "Listening" : lastSeen(device),
            dot: device.online ? .appDone : Color.appMuted.opacity(0.4)) {
            AskAdam.draft("How is the \(device.name) doing?")
        }
    }

    private func row(title: String, detail: String?, dot: Color?, chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(2)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                            .lineLimit(2)
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
        guard let raw = device.lastSeenAt, let date = Date.oxyParse(raw) else { return "Not connected yet" }
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
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if env["OXY_DEBUG_HOME"] == "connected" {
            home = Self.sampleConnected
            loaded = true
            return
        }
        if env["OXY_DEBUG_HOME"] == "empty" {
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
        let living = HomeModel.Device(id: "d1", name: "Living room Adam", kind: "device", room: "Living room", online: true, lastSeenAt: seen)
        let kitchen = HomeModel.Device(id: "d2", name: "Kitchen Adam", kind: "device", room: "Kitchen", online: false,
                                       lastSeenAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)))
        return HomeModel(
            presence: .init(state: "home", homeConfigured: true),
            devices: [living, kitchen],
            rooms: [.init(name: "Living room", devices: [living], active: true), .init(name: "Kitchen", devices: [kitchen], active: false)],
            unassignedDevices: [],
            watches: [.init(id: "w1", title: "Front door", detail: "Tell me if it opens after 22:00", nextRunAt: nil)],
            observations: []
        )
    }()
    #endif
}
