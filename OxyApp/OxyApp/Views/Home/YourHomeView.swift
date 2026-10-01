import SwiftUI

// MARK: - Household model

/// What Adam can truthfully say about the household (GET /agent/household). Unknown stays unknown.
struct Household: Codable, Equatable {
    struct Presence: Codable, Equatable {
        let state: String
        let observedAt: String?
        let homeConfigured: Bool
    }
    struct Person: Codable, Equatable, Hashable {
        let name: String
        let relationship: String?
    }
    struct Commitment: Codable, Equatable, Hashable {
        let what: String
        let personName: String?
        let dueAt: String?
    }
    struct Plan: Codable, Equatable, Hashable {
        let title: String
        let recurrence: String?
        let nextRunAt: String?
        let contextEvent: String?
    }

    let presence: Presence
    let people: [Person]
    let openCommitments: [Commitment]
    let activePlans: [Plan]

    static let empty = Household(
        presence: Presence(state: "unknown", observedAt: nil, homeConfigured: false),
        people: [], openCommitments: [], activePlans: []
    )
}

enum HouseholdService {
    static func fetch() async throws -> Household {
        let data = try await APIClient.shared.request(path: "/agent/household")
        return try JSONDecoder().decode(Household.self, from: data)
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

/// A window into the household as Adam understands it: speakers, presence, what it's watching,
/// what's in motion, promises to people, and what changed. Sections appear only when they're true.
struct YourHomeView: View {
    @State private var household: Household = .empty
    @State private var board: HomeBoard = .empty
    @State private var displays: [PairedDisplay] = []
    @State private var settings = OxySettings()
    @State private var loaded = false
    @State private var failed = false
    @State private var showsSpeakerSetup = false
    @State private var showsSettings = false

    private var pendantConnected: Bool { NativeIntegrationManager.shared.pendant.isConnected }

    private var onlineSpeakers: Int {
        displays.filter { isOnline($0) }.count + (pendantConnected ? 1 : 0)
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 30) {
                    Text("Your home")
                        .font(.title.weight(.semibold))
                        .foregroundStyle(Color.appInk)

                    stateHeader

                    if failed {
                        ErrorBanner(message: "Couldn't load your home.", onRetry: { Task { await load() } })
                    }

                    speakersSection
                    plansSection
                    workingSection
                    promisesSection
                    peopleSection
                    noticedSection
                    setupSection
                }
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 18)
                .padding(.bottom, 40)
                .animation(.appStandard, value: loaded)
            }
            .background(Color.appBackground.ignoresSafeArea())
            .refreshable { await load() }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .sheet(isPresented: $showsSpeakerSetup) {
            PendantStatusView().presentationDetents([.large])
        }
        .fullScreenCover(isPresented: $showsSettings) {
            SettingsView().swipeToDismiss()
        }
    }

    // MARK: State

    private var stateHeader: some View {
        HStack(alignment: .center, spacing: 18) {
            AdamPresence(state: onlineSpeakers > 0 ? .idle : .complete, size: 64)
            VStack(alignment: .leading, spacing: 4) {
                if let presence = presenceLine {
                    Text(presence)
                        .font(.appBody(18, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                }
                Text(speakerLine)
                    .font(.appBody(14))
                    .foregroundStyle(Color.appMuted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private var presenceLine: String? {
        switch household.presence.state {
        case "home": return "You're home"
        case "away": return "You're out"
        default: return nil
        }
    }

    private var speakerLine: String {
        let total = displays.count + (pendantConnected ? 1 : 0)
        if total == 0 { return "No speaker set up yet" }
        if onlineSpeakers == 0 { return total == 1 ? "Speaker offline" : "Speakers offline" }
        return onlineSpeakers == 1 ? "Speaker listening" : "\(onlineSpeakers) speakers listening"
    }

    // MARK: Sections

    @ViewBuilder
    private var speakersSection: some View {
        if !displays.isEmpty || pendantConnected {
            section("Speakers") {
                if pendantConnected {
                    row(title: NativeIntegrationManager.shared.pendant.peripheralName ?? "Adam speaker",
                        detail: "Connected", dot: .appDone) { showsSpeakerSetup = true }
                }
                ForEach(Array(displays.enumerated()), id: \.element.id) { index, display in
                    if pendantConnected || index > 0 { divider }
                    row(title: display.name,
                        detail: isOnline(display) ? "Listening" : lastSeen(display),
                        dot: isOnline(display) ? .appDone : nil) {
                        AskAdam.draft("How is the \(display.name) speaker doing?")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var plansSection: some View {
        if !household.activePlans.isEmpty {
            section("Keeping an eye on") {
                ForEach(Array(household.activePlans.enumerated()), id: \.offset) { index, plan in
                    if index > 0 { divider }
                    row(title: plan.title, detail: planDetail(plan), dot: .appWorking) {
                        AskAdam.draft("What's happening with: \(plan.title)?")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var workingSection: some View {
        if !board.handling.isEmpty {
            section("Happening now") {
                ForEach(Array(board.handling.prefix(5).enumerated()), id: \.element.id) { index, item in
                    if index > 0 { divider }
                    row(title: item.title, detail: item.detail, dot: .appWorking) {
                        AskAdam.draft("How's it going with: \(item.title)?")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var promisesSection: some View {
        if !household.openCommitments.isEmpty {
            section("Things you said you'd do") {
                ForEach(Array(household.openCommitments.enumerated()), id: \.offset) { index, item in
                    if index > 0 { divider }
                    row(title: item.what, detail: commitmentDetail(item), dot: .appNeedsYou) {
                        AskAdam.draft("Help me with: \(item.what)")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var peopleSection: some View {
        if !household.people.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle("People")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(household.people, id: \.self) { person in
                            Button { AskAdam.draft("What's coming up with \(person.name)?") } label: {
                                VStack(spacing: 6) {
                                    Text(initials(person.name))
                                        .font(.appBody(17, weight: .semibold))
                                        .foregroundStyle(Color.appInk)
                                        .frame(width: 52, height: 52)
                                        .background(Circle().fill(Color.appReceivedBubble))
                                    Text(person.name)
                                        .font(.appBody(12, weight: .medium))
                                        .foregroundStyle(Color.appInk)
                                        .lineLimit(1)
                                    Text(person.relationship ?? " ")
                                        .font(.appBody(11))
                                        .foregroundStyle(Color.appMuted)
                                        .lineLimit(1)
                                }
                                .frame(width: 72)
                            }
                            .buttonStyle(.appScale(0.95))
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var noticedSection: some View {
        if !board.changed.isEmpty {
            section("Noticed recently") {
                ForEach(Array(board.changed.prefix(5).enumerated()), id: \.element.id) { index, item in
                    if index > 0 { divider }
                    row(title: item.title, detail: relativeTime(item.date), dot: nil) {
                        AskAdam.draft("Tell me more about: \(item.title)")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var setupSection: some View {
        let needsSpeaker = displays.isEmpty && !pendantConnected
        let needsAddress = settings.homeLatitude == nil && settings.homeAddress.isEmpty
        if loaded && (needsSpeaker || needsAddress) {
            section("Set up") {
                if needsSpeaker {
                    row(title: "Set up your speaker", detail: "So Adam can hear and answer at home", dot: nil, chevron: true) {
                        showsSpeakerSetup = true
                    }
                }
                if needsSpeaker && needsAddress { divider }
                if needsAddress {
                    row(title: "Add your home address", detail: "For reminders when you arrive", dot: nil, chevron: true) {
                        showsSettings = true
                    }
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
        .transition(.opacity)
    }

    private var divider: some View {
        Rectangle().fill(Color.appCardOutline).frame(height: 1)
    }

    private func row(title: String, detail: String?, dot: Color?, chevron: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let dot {
                    Circle().fill(dot).frame(width: 8, height: 8)
                }
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

    private func isOnline(_ display: PairedDisplay) -> Bool {
        guard let raw = display.lastSeenAt, let date = DisplayTimestampParser.date(from: raw) else { return false }
        return Date().timeIntervalSince(date) < 180
    }

    private func lastSeen(_ display: PairedDisplay) -> String {
        guard let raw = display.lastSeenAt, let date = DisplayTimestampParser.date(from: raw) else { return "Not connected yet" }
        return "Last heard from \(date.formatted(.relative(presentation: .named)))"
    }

    private func planDetail(_ plan: Household.Plan) -> String? {
        if let next = plan.nextRunAt.flatMap(Date.oxyParse), next > Date() {
            return "Next check \(next.formatted(.relative(presentation: .named)))"
        }
        return plan.recurrence.map { $0.capitalized }
    }

    private func commitmentDetail(_ item: Household.Commitment) -> String? {
        let who = item.personName.map { "For \($0)" }
        let when = item.dueAt.flatMap(Date.oxyParse).map { "due \($0.formatted(.relative(presentation: .named)))" }
        let parts = [who, when].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func relativeTime(_ date: Date?) -> String? {
        date.map { $0.formatted(.relative(presentation: .named)) }
    }

    private func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return String(letters).uppercased()
    }

    // MARK: Loading

    private func load() async {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            board = ThreadBoardModel.sampleBoard
            household = Self.sampleHousehold
            loaded = true
            return
        }
        #endif
        async let householdTask = try? HouseholdService.fetch()
        async let boardTask = try? HomeBoardService.fetchBoard()
        async let displaysTask = try? PairedDisplaysService.fetchDisplays()
        let (fetchedHousehold, fetchedBoard, fetchedDisplays) = await (householdTask, boardTask, displaysTask)
        failed = fetchedHousehold == nil && fetchedBoard == nil
        if let fetchedHousehold { household = fetchedHousehold }
        if let fetchedBoard { board = fetchedBoard }
        if let fetchedDisplays { displays = fetchedDisplays }
        loaded = true
    }

    #if DEBUG
    private static let sampleHousehold = Household(
        presence: .init(state: "home", observedAt: nil, homeConfigured: true),
        people: [.init(name: "Arina", relationship: "flatmate"), .init(name: "Mum", relationship: nil)],
        openCommitments: [.init(what: "Send Arina the flat photos", personName: "Arina", dueAt: nil)],
        activePlans: [.init(title: "Bin day reminder", recurrence: "weekly", nextRunAt: nil, contextEvent: nil)]
    )
    #endif
}
