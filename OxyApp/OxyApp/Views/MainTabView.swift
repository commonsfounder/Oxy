import SwiftUI
import UIKit

struct MainTabView: View {
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage(ThreadBackground.storageKey) private var backgroundRaw = ThreadBackground.automatic.rawValue
    @State private var opened: ThreadMenuChoice?

    private var background: ThreadBackground { ThreadBackground(rawValue: backgroundRaw) ?? .automatic }

    var body: some View {
        ChatView(onMenuChoice: { opened = $0 })
            .tint(Color.appAccent)
            .preferredColorScheme(background.scheme)
            .id(accentColor + backgroundRaw)
            .sheet(item: $opened) { choice in
                Group {
                    switch choice {
                    case .activity: AdamActivityView()
                    case .home: YourHomeView()
                    default: AdamYouView()
                    }
                }
                .presentationDragIndicator(.visible)
            }
            .onReceive(NotificationCenter.default.publisher(for: AskAdam.notification)) { _ in
                opened = nil
            }
            .onAppear {
                HapticManager.shared.prepare()
                #if DEBUG
                if let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_OPEN"],
                   let choice = ThreadMenuChoice(rawValue: raw) { opened = choice }
                #endif
            }
    }
}

struct AdamPresence: View {
    enum PresenceState {
        case idle, listening, thinking, speaking, complete
    }

    var state: PresenceState = .idle
    var size: CGFloat = 96

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.State private var breathing = false
    @SwiftUI.State private var rotating = false

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.appSurface)
                .shadow(color: Color.appAccent.opacity(0.12), radius: 22)

            Circle()
                .strokeBorder(Color.appHairline, lineWidth: 1)
                .padding(size * 0.08)

            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.appAccent.opacity(0.42), Color.appAccent.opacity(0.08), .clear],
                        center: state == .listening ? .topLeading : .center,
                        startRadius: 2,
                        endRadius: size * 0.44
                    )
                )
                .padding(size * 0.13)
                .rotationEffect(.degrees(rotating ? 360 : 0))

            AdamMark()
                .frame(width: size * 0.35, height: size * 0.25)
        }
        .frame(width: size, height: size)
        .scaleEffect(reduceMotion ? 1 : (breathing ? activeScale : 1))
        .animation(
            reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: state == .idle ? 2.6 : 0.8).repeatForever(autoreverses: true),
            value: breathing
        )
        .animation(
            reduceMotion ? .easeInOut(duration: 0.2) : .linear(duration: 6).repeatForever(autoreverses: false),
            value: rotating
        )
        .onAppear {
            breathing = true
            rotating = state == .thinking || state == .speaking
        }
        .onChange(of: state) { _, newState in
            rotating = newState == .thinking || newState == .speaking
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var activeScale: CGFloat {
        switch state {
        case .idle: return 1.018
        case .listening: return 1.05
        case .thinking, .speaking: return 1.025
        case .complete: return 0.98
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .idle: return "Adam is ready"
        case .listening: return "Adam is listening"
        case .thinking: return "Adam is thinking"
        case .speaking: return "Adam is speaking"
        case .complete: return "Adam finished"
        }
    }
}

private struct PhysicalHomeView: View {
    @State private var settings = OxySettings()
    @State private var displays: [PairedDisplay] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showsSettings = false
    @State private var showsDevice = false

    private var deviceConnected: Bool {
        NativeIntegrationManager.shared.pendant.isConnected
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 32) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Your home")
                                .font(.title.weight(.semibold))
                                .appHeroTracking(28)
                                .foregroundStyle(Color.appInk)
                            if let homeSummary {
                                Text(homeSummary)
                                    .font(.body)
                                    .foregroundStyle(Color.appMuted)
                            }
                        }

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                        }

                        if hasHomeContext {
                            homeCard
                            devicesSection
                        } else if !isLoading {
                            emptyHome
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 18)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .fullScreenCover(isPresented: $showsSettings) {
            SettingsView()
                .swipeToDismiss()
                .onDisappear { loadSettings() }
        }
        .sheet(isPresented: $showsDevice) {
            PendantStatusView()
                .presentationDetents([.large])
                .presentationCornerRadius(28)
        }
    }

    private var hasHomeContext: Bool {
        settings.homeLatitude != nil || settings.homeLongitude != nil || !settings.homeAddress.isEmpty || deviceConnected || !displays.isEmpty
    }

    /// Nothing to say until there is something true to say.
    private var homeSummary: String? {
        guard hasHomeContext else { return nil }
        let deviceCount = displays.count + (deviceConnected ? 1 : 0)
        switch deviceCount {
        case 0: return nil
        case 1: return "1 speaker connected"
        default: return "\(deviceCount) speakers connected"
        }
    }

    private var homeCard: some View {
        Button {
            HapticManager.shared.impact(.light)
            showsSettings = true
        } label: {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    AppIcon("tab-home", size: 23)
                        .foregroundStyle(Color.appInk)
                    Spacer()
                    Text(settings.homeLatitude == nil ? "Setup incomplete" : "Home")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.appMuted)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("Home")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color.appInk)
                    Text(homeDetail)
                        .font(.subheadline)
                        .foregroundStyle(Color.appMuted)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, minHeight: 148, alignment: .leading)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.appScale(0.985))
        .accessibilityHint("Opens home settings")
    }

    private var homeDetail: String {
        if settings.homeLatitude != nil { return "Address saved · arrival reminders \(settings.locationReminders ? "on" : "off")" }
        if !settings.homeAddress.isEmpty { return "Address saved · needs confirming" }
        return "Add your address for arrival reminders"
    }

    @ViewBuilder
    private var devicesSection: some View {
        let total = displays.count + (deviceConnected ? 1 : 0)
        if total > 0 {
            VStack(alignment: .leading, spacing: 12) {
                Text("Speaker")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.appInk)

                VStack(spacing: 0) {
                    if deviceConnected {
                        homeDeviceRow(title: NativeIntegrationManager.shared.pendant.peripheralName ?? "Adam device", status: "Connected") {
                            showsDevice = true
                        }
                    }
                    ForEach(Array(displays.enumerated()), id: \.element.id) { index, display in
                        if deviceConnected || index > 0 { AppDivider(inset: 52) }
                        homeDeviceRow(title: display.name, status: displayStatus(display)) {}
                    }
                }
                .padding(.horizontal, 16)
                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
        }
    }

    private func homeDeviceRow(title: String, status: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                AdamMark(active: status == "Connected")
                    .frame(width: 32, height: 24)
                    .frame(width: 38, height: 38)
                    .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.appInk)
                    Text(status).font(.footnote).foregroundStyle(Color.appMuted)
                }
                Spacer()
                if status == "Connected" { AppStatusDot(kind: .live, diameter: 6) }
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    private var emptyHome: some View {
        VStack(alignment: .leading, spacing: 28) {
            AdamPresence(size: 78)
            VStack(spacing: 0) {
                setupRow(title: "Set up your speaker", detail: "Connect it to Adam") { showsDevice = true }
                AppDivider(inset: 0)
                setupRow(title: "Add your home address", detail: "For reminders when you arrive") { showsSettings = true }
            }
            .padding(.horizontal, 16)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.appReceivedBubble))
        }
        .padding(.top, 12)
    }

    private func setupRow(title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.appInk)
                    Text(detail).font(.footnote).foregroundStyle(Color.appMuted)
                }
                Spacer()
                AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 16)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    private func displayStatus(_ display: PairedDisplay) -> String {
        guard let raw = display.lastSeenAt, let date = DisplayTimestampParser.date(from: raw) else { return "Paired" }
        return Date().timeIntervalSince(date) < 120 ? "Connected" : "Last seen \(date.formatted(.relative(presentation: .named)))"
    }

    private func loadSettings() {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings"),
              let saved = try? JSONDecoder().decode(OxySettings.self, from: data) else { return }
        settings = saved
    }

    private func load() async {
        loadSettings()
        isLoading = true
        defer { isLoading = false }
        do {
            displays = try await PairedDisplaysService.fetchDisplays()
            errorMessage = nil
        } catch {
            displays = []
            errorMessage = nil
        }
    }
}

private struct AdamActivityView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private enum Filter: String, CaseIterable, Identifiable { case all = "All", done = "Done", watching = "Coming up"; var id: String { rawValue } }

    @State private var filter: Filter = .all
    @State private var board: HomeBoard = .empty
    @State private var watches: [AgentWatch] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var expandedID: String?
    @State private var openWorkflowID: String?
    @State private var showsWork = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 28) {
                        activityHeader

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                        } else if visibleItems.isEmpty && visibleWatches.isEmpty && !isLoading {
                            activityEmpty
                        } else {
                            if !visibleWatches.isEmpty { watchingSection }
                            if !visibleItems.isEmpty { timelineSection }
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 18)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .fullScreenCover(isPresented: $showsWork) { AgentWorkView().swipeToDismiss() }
        .fullScreenCover(item: Binding(
            get: { openWorkflowID.map(ActivityWorkflow.init) },
            set: { openWorkflowID = $0?.id }
        )) { workflow in
            WorkflowTimelineView(workflowId: workflow.id, onChanged: { Task { await load() } })
                .swipeToDismiss()
        }
    }

    private var filterBar: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(spacing: 6))
        return layout {
            ForEach(Filter.allCases) { item in
                Button {
                    guard filter != item else { return }
                    HapticManager.shared.select()
                    withAnimation(.appStandard) { filter = item }
                } label: {
                    Text(item.rawValue)
                        .font(.footnote.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(filter == item ? Color.appInk : Color.appMuted)
                        .padding(.horizontal, 15)
                        .frame(minHeight: 44)
                        .background(filter == item ? Color.appSurface : Color.clear, in: Capsule())
                }
                .buttonStyle(.appScale)
                .accessibilityAddTraits(filter == item ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: dynamicTypeSize.isAccessibilitySize ? 24 : 28))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var activityHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Activity")
                .font(.title.weight(.semibold))
                .appHeroTracking(28)
                .foregroundStyle(Color.appInk)
            filterBar
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Filter")
    }

    private var visibleItems: [BoardItem] {
        guard filter != .watching else { return [] }
        let items = filter == .all ? board.handling + board.completed + board.changed : board.completed + board.changed
        var seen = Set<String>()
        return items.filter { seen.insert($0.title.lowercased()).inserted }
    }

    private var visibleWatches: [AgentWatch] { filter == .done ? [] : watches }

    private var watchingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Coming up")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.appInk)
            VStack(spacing: 0) {
                ForEach(Array(visibleWatches.enumerated()), id: \.element.id) { index, watch in
                    Button { showsWork = true } label: {
                        HStack(spacing: 13) {
                            AppStatusDot(kind: .live, diameter: 6).frame(width: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(watch.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.appInk)
                                Text(watch.nextCheckLabel ?? watch.cadenceLabel).font(.footnote).foregroundStyle(Color.appMuted)
                            }
                            Spacer()
                            AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted)
                        }
                        .padding(.vertical, 15)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.appScale(0.99))
                    if index < visibleWatches.count - 1 { AppDivider(inset: 44) }
                }
            }
            .padding(.horizontal, 16)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private var timelineSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(filter == .done ? "Done" : "Recently")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.appInk)
            VStack(spacing: 0) {
                ForEach(Array(visibleItems.enumerated()), id: \.element.id) { index, item in
                    activityRow(item)
                    if index < visibleItems.count - 1 { AppDivider(inset: 54) }
                }
            }
            .padding(.horizontal, 16)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func activityRow(_ item: BoardItem) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            if item.workflowId != nil {
                openWorkflowID = item.workflowId
            } else {
                withAnimation(.appExpand) { expandedID = expandedID == item.id ? nil : item.id }
            }
        } label: {
            HStack(alignment: .top, spacing: 13) {
                Text(item.date?.formatted(date: .omitted, time: .shortened) ?? "Now")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 40, alignment: .leading)
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(2)
                    if let detail = item.detail, !detail.isEmpty, detail.caseInsensitiveCompare(item.title) != .orderedSame {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(Color.appMuted)
                            .lineLimit(expandedID == item.id ? nil : 2)
                    }
                    if expandedID == item.id {
                        Text(item.failed == true ? "Adam couldn't complete this." : "Open the related work for more detail.")
                            .font(.footnote)
                            .foregroundStyle(Color.appMuted)
                            .padding(.top, 4)
                    }
                }
                Spacer(minLength: 4)
                if board.handling.contains(where: { $0.id == item.id }) {
                    Circle().fill(Color.appWorking)
                        .frame(width: 8, height: 8)
                        .frame(width: 16, height: 16)
                        .accessibilityLabel("Working")
                } else {
                    AppIcon(item.failed == true ? "alert-circle" : "check-circle", size: 16)
                        .foregroundStyle(item.failed == true ? Color.appWarning : Color.appSuccess)
                        .accessibilityLabel(item.failed == true ? "Couldn't finish" : "Done")
                }
            }
            .padding(.vertical, 15)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.995))
    }

    private var activityEmpty: some View {
        VStack(alignment: .leading, spacing: 16) {
            AppIcon("history", size: 24)
                .foregroundStyle(Color.appMuted)
                .frame(width: 56, height: 56)
                .background(Color.appSurface2, in: Circle())
            Text("Nothing yet")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.appInk)
            Text("Things Adam does for you will appear here.")
                .font(.subheadline)
                .foregroundStyle(Color.appMuted)
        }
        .padding(.top, 30)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            board = ThreadBoardModel.sampleBoard
            errorMessage = nil
            return
        }
        #endif
        do {
            async let boardTask = HomeBoardService.fetchBoard()
            async let watchTask = AgentTasksService.fetchWatches()
            (board, watches) = try await (boardTask, watchTask)
            errorMessage = nil
        } catch {
            errorMessage = "Activity isn't available right now."
        }
    }
}

private struct ActivityWorkflow: Identifiable { let id: String }

private struct AdamYouView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: Destination?
    @State private var showsBackgroundPicker = false

    private enum Destination: String, Identifiable {
        case profile, memory, connections, agents, privacy, settings
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 30) {
                        Text("Settings")
                            .font(.title.weight(.semibold))
                            .appHeroTracking(28)
                            .foregroundStyle(Color.appInk)

                        identityHeader

                        youGroup {
                            youRow(title: "What Adam remembers", subtitle: "See it and change it", icon: "person") { destination = .memory }
                            AppDivider(inset: 50)
                            youRow(title: "Connected apps", subtitle: "Mail, calendar, messages and more", icon: "cube") { destination = .connections }
                        }

                        youGroup {
                            youRow(title: "Privacy and safety", subtitle: "What Adam asks you first", icon: "shield-check") { destination = .privacy }
                            AppDivider(inset: 50)
                            youRow(title: "Account and preferences", subtitle: "Your details, alerts and more", icon: "list") { destination = .settings }
                            AppDivider(inset: 50)
                            youRow(title: "Background", subtitle: ThreadBackground.current.title, icon: "sun") { showsBackgroundPicker = true }
                        }

                        youSection("Advanced") {
                            youRow(title: "Which AI Adam uses", subtitle: "For people who like to choose", icon: "waveform") { destination = .agents }
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 18)
                    .padding(.bottom, 40)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .fullScreenCover(item: $destination) { item in
            destinationView(item).swipeToDismiss()
        }
        .sheet(isPresented: $showsBackgroundPicker) { BackgroundPicker() }
        #if DEBUG
        .onAppear {
            if let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_YOU"],
               let target = Destination(rawValue: raw) { destination = target }
        }
        #endif
    }

    private var identityHeader: some View {
        HStack(spacing: 16) {
            Text(initials)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.appInk)
                .frame(width: 62, height: 62)
                .background(Color.appSurface2, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(displayName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.appInk)
            }
            Spacer()
            Button { destination = .profile } label: {
                AppIcon("chevron-right", size: 13)
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.appScale)
            .accessibilityLabel("Open profile")
        }
        .padding(18)
        .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func youSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.appInk)
            VStack(spacing: 0) { content() }
                .padding(.horizontal, 16)
                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func youGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, 16)
            .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func youRow(title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 13) {
                AppIcon(icon, size: 17)
                    .foregroundStyle(Color.appInk)
                    .frame(width: 36, height: 36)
                    .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.appInk)
                    Text(subtitle).font(.footnote).foregroundStyle(Color.appMuted)
                }
                Spacer()
                AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    @ViewBuilder
    private func destinationView(_ item: Destination) -> some View {
        switch item {
        case .profile: ProfileView()
        case .memory: MemoryView()
        case .connections: ConnectorsView()
        case .agents: ModelRoutingView()
        case .privacy: TrustCenterView()
        case .settings: SettingsView()
        }
    }

    private var displayName: String {
        let saved = savedSettings.userName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !saved.isEmpty, !["user", "demo", "test"].contains(saved.lowercased()) { return saved }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? ""
        return local.isEmpty ? "You" : local.prefix(1).uppercased() + local.dropFirst()
    }

    private var initials: String {
        let parts = displayName.split(separator: " ").prefix(2)
        let value = parts.compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? "Y" : value.uppercased()
    }

    private var savedSettings: OxySettings {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings"),
              let settings = try? JSONDecoder().decode(OxySettings.self, from: data) else { return OxySettings() }
        return settings
    }
}

private struct BackgroundPicker: View {
    @AppStorage(ThreadBackground.storageKey) private var backgroundRaw = ThreadBackground.automatic.rawValue
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Background")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.appInk)
            HStack(spacing: 16) {
                ForEach(ThreadBackground.allCases) { option in
                    Button {
                        HapticManager.shared.select()
                        backgroundRaw = option.rawValue
                        dismiss()
                    } label: {
                        VStack(spacing: 8) {
                            Circle()
                                .fill(option.swatch)
                                .frame(width: 58, height: 58)
                                .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
                                .overlay(Circle().strokeBorder(Color.appInk, lineWidth: backgroundRaw == option.rawValue ? 2.5 : 0).padding(-4))
                            Text(option.title)
                                .font(.footnote)
                                .foregroundStyle(Color.appInk)
                        }
                        .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.appScale)
                    .accessibilityAddTraits(backgroundRaw == option.rawValue ? .isSelected : [])
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appBackground.ignoresSafeArea())
        .presentationDetents([.height(220)])
    }
}

// MARK: - More View

#Preview {
    MainTabView()
        .environment(AppState())
}
   
