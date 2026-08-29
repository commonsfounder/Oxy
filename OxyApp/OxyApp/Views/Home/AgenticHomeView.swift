import SwiftUI

// MARK: - Home

struct AgenticHomeView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    /// Idle refresh interval.
    private static let pollInterval: Duration = .seconds(90)
    /// Refresh interval while work is active.
    private static let activePollInterval: Duration = .seconds(10)

    /// Home board state.
    @State private var board: HomeBoard = .empty
    @State private var openWorkflowID: String?
    /// Prevents duplicate changed-state acknowledgement.
    @State private var hasMarkedSeen = false

    @State private var briefings: [Briefing] = []
    @State private var lifeBriefing: LifeBriefing?
    @State private var isLoading = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var chatLaunch: ChatLaunch?
    @State private var activeSession: AgentTaskSession?
    /// Sessions that continue after their sheet is dismissed.
    @State private var backgroundSessions: [AgentTaskSession] = []
    @State private var isChatHomePresented = false
    @State private var isMorePresented = false
    @State private var chatDragOffset: CGFloat = 0
    @State private var chatDragActive = false
    @State private var localMissions: [HomeMission] = []
    /// Locally dismissed inbox items.
    @State private var dismissedMailIDs: Set<String> = []
    /// Locally dismissed missions.
    @State private var dismissedMissionIDs: Set<String> = []
    @State private var composerDraft = ""
    @FocusState private var composerFocused: Bool
    private let service = ChatService()
    @State private var agentWatches: [AgentWatch] = []
    @State private var stoppingWatchIDs = Set<String>()
    @State private var isAgentWorkPresented = false
    @State private var hasEmailConnection = false
    /// Recent task entities.
    @State private var recentEntities: [RecentEntity] = []

    var body: some View {
        ZStack {
            GlebChrome.pastelBlob
                .ignoresSafeArea()

            VStack(spacing: 0) {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        GlebTopChrome(
                            weather: weather,
                            onProfile: {
                                HapticManager.shared.impact(.light)
                                isMorePresented = true
                            }
                        )
                        .padding(.top, 8)

                        greetingBlock
                            .padding(.top, 2)

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: {
                                Task { await load(forceCheck: false) }
                            })
                        }

                        if board.isWorking {
                            LiveWorkHeader(
                                count: board.handling.count,
                                waitingCount: board.handling.filter { $0.waitingExternal == true }.count
                            )
                            .transition(.opacity.combined(with: .move(edge: .top)))
                        }

                        if let lifeBriefing = visibleLifeBriefing {
                            LifeBriefingCard(briefing: lifeBriefing) { item in
                                handleLifeBriefingItem(item)
                            }
                            .transition(.opacity.combined(with: .move(edge: .top)))
                        }

                        if isLoading && board.isEmpty && missions.isEmpty && visibleLifeBriefing == nil {
                            ProgressView()
                                .tint(GlebChrome.ink.opacity(0.4))
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else {
                            if !board.isEmpty {
                                boardLanes
                            }

                            if !missions.isEmpty {
                                LazyVStack(spacing: 12) {
                                    ForEach(missions) { mission in
                                        MissionCardView(
                                            mission: mission,
                                            ink: GlebChrome.ink,
                                            onCTA: { handleMissionCTA(mission) },
                                            onMailCTA: { email in handleMailCTA(email) },
                                            onDismiss: mission.kind == .mailGroup || mission.watchID != nil ? nil : {
                                                mission.id.hasPrefix("session-") ? abandonSession(mission.id) : dismissMission(mission.id)
                                            }
                                        )
                                        .transition(.asymmetric(
                                            insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: .top)),
                                            removal: .opacity
                                        ))
                                    }
                                }
                                .padding(.top, 4)
                            }

                            // Shown even when the error banner is up: a failed refresh
                            // still leaves the composer usable, so the page must not
                            // go blank between the banner and the bottom bar.
                            if !isLoading,
                               board.isEmpty,
                               missions.isEmpty,
                               visibleLifeBriefing == nil {
                                homeEmptyState
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }
                        }

                        if !recentEntities.isEmpty {
                            recentEntitiesRail
                                .padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 120)
                }
                .refreshable { await load(forceCheck: true) }
            }

            VStack {
                Spacer()
                composerBar
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
            }

            // Chat edge gesture.
            Color.clear
                .frame(width: 20)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(chatEdgeGesture)
                .frame(maxWidth: .infinity, alignment: .trailing)

            chatPeekIndicator
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .task {
            await load(forceCheck: false)
            await loadBoard()
            await loadRecentEntities()
            await markBoardSeenOnce()
            while !Task.isCancelled {
                try? await Task.sleep(for: board.isWorking ? Self.activePollInterval : Self.pollInterval)
                guard !Task.isCancelled else { break }
                await loadBoard()
                await load(forceCheck: false)
                await loadRecentEntities()
            }
        }
        .onChange(of: chatLaunch) { old, new in
            if old != nil && new == nil {
                Task { await load(forceCheck: false) }
            }
        }
        .onChange(of: isChatHomePresented) { old, new in
            if old && !new {
                Task { await load(forceCheck: false) }
            }
        }
        .onChange(of: isMorePresented) { old, new in
            if old && !new {
                Task { await load(forceCheck: false) }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await load(forceCheck: false) }
            }
        }
        .onAppear {
            loadDismissedMailIDs()
            loadDismissedMissionIDs()
            #if DEBUG
            if let tab = ProcessInfo.processInfo.environment["OXY_DEBUG_TAB"] {
                if tab == "chat" { isChatHomePresented = true }
                if tab == "more" { isMorePresented = true }
                return
            }
            if ProcessInfo.processInfo.environment["OXY_DEBUG_AUTOLOGIN"] == "1" { return }
            #endif
            if appState.isDemoSession || SiriRequestBus.shared.pendingQuery != nil {
                isChatHomePresented = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToChat)) { _ in
            isChatHomePresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToMore)) { _ in
            isMorePresented = true
        }
        .fullScreenCover(isPresented: $isChatHomePresented) {
            ChatHomeView()
                .overlay(alignment: .topTrailing) {
                    Button {
                        HapticManager.shared.impact(.light)
                        isChatHomePresented = false
                    } label: {
                        AppIcon("tab-home", size: 16)
                            .foregroundStyle(Color.appInk)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel("Home")
                    .padding(.top, 8)
                    .padding(.trailing, 12)
                }
        }
        .fullScreenCover(isPresented: $isMorePresented) {
            MoreView()
                .swipeToDismiss()
                .overlay(alignment: .topTrailing) {
                    Button {
                        HapticManager.shared.impact(.light)
                        isMorePresented = false
                    } label: {
                        AppIcon("tab-home", size: 16)
                            .foregroundStyle(Color.appInk)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel("Home")
                    .padding(.top, 8)
                    .padding(.trailing, 12)
                }
        }
        .fullScreenCover(item: $chatLaunch) { launch in
            NavigationStack {
                ChatView(
                    autoSendTranscript: launch.autoSend,
                    initialReviewAction: launch.review,
                    startFresh: launch.startFresh
                )
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            chatLaunch = nil
                        } label: {
                            AppIcon("xmark", size: 14)
                                .foregroundStyle(GlebChrome.ink)
                                .frame(width: 36, height: 36)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                    }
                }
            }
            .swipeToDismiss()
        }
        .fullScreenCover(item: $activeSession) { session in
            AgentTaskSessionView(
                session: session,
                onDismiss: {
                    backgroundIfNeeded(session)
                    activeSession = nil
                },
                onComplete: { title in
                    backgroundSessions.removeAll { $0.id == session.id }
                    localMissions.insert(HomeMission(
                        id: "local-\(UUID().uuidString)",
                        kind: .status,
                        eyebrow: "Done",
                        title: title,
                        detail: nil,
                        cta: nil,
                        prompt: nil,
                        symbol: "checkmark.circle.fill",
                        isPrimary: false
                    ), at: 0)
                    activeSession = nil
                },
                onOpenChat: { prompt in
                    backgroundIfNeeded(session)
                    activeSession = nil
                    // Keep the existing conversation when a session opens chat.
                    openChat(autoSend: prompt, startFresh: false)
                }
            )
        }
        .fullScreenCover(isPresented: $isAgentWorkPresented) {
            AgentWorkView()
                .swipeToDismiss()
        }
        .fullScreenCover(item: Binding(
            get: { openWorkflowID.map(OpenWorkflow.init) },
            set: { openWorkflowID = $0?.id }
        )) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await loadBoard() } })
                .swipeToDismiss()
                .onDisappear { Task { await loadBoard() } }
        }
}

// MARK: - Greeting

    private var greetingBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Dateline — the rule sits above the row, so it reads as a printed
            // masthead rather than a floating eyebrow.
            Rectangle()
                .fill(Color.appAccent.opacity(0.5))
                .frame(height: 1)

            HStack(alignment: .firstTextBaseline) {
                Text("TODAY")
                    .font(.appBody(10, weight: .semibold))
                    .tracking(2.6)
                    .foregroundStyle(Color.appAccent)
                Spacer(minLength: 0)
                Text(dateLine.uppercased())
                    .font(.appMono(10, weight: .medium))
                    .tracking(0.6)
                    .foregroundStyle(GlebChrome.ink.opacity(0.5))
            }
            .padding(.top, 7)

            // Hero. Salutation in ink, name in gold — the one moment the accent
            // gets to carry type instead of a hairline.
            VStack(alignment: .leading, spacing: -2) {
                Text(salutation)
                    .font(.appEditorial(42, weight: 380, soft: 45))
                    .foregroundStyle(GlebChrome.ink)
                if !firstName.isEmpty {
                    Text(firstName)
                        .font(.appEditorial(42, weight: 300, soft: 65))
                        .foregroundStyle(Color.appAccent)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.65)
            .padding(.top, 20)

            Text(homeSummary)
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(GlebChrome.ink.opacity(0.62))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .padding(.bottom, 2)
    }

    private var homeSummary: String {
        if board.isWorking {
            return board.handling.count == 1 ? "One thing is moving." : "\(board.handling.count) things are moving."
        }
        if !missions.isEmpty {
            return missions.count == 1 ? "One item needs your attention." : "\(missions.count) items need your attention."
        }
        return "Nothing needs your attention right now."
    }

    private var homeEmptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                AppIcon("sparkles", size: 14)
                    .foregroundStyle(Color.appAccent)
                Text("READY WHEN YOU ARE")
                    .font(.appBody(10, weight: .bold))
                    .tracking(1.5)
                    .foregroundStyle(Color.appAccent)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text("Start with one request.")
                    .font(.appBody(20, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink)
                Text("Ask for a plan, an update, or a next step.")
                    .font(.appBody(14))
                    .foregroundStyle(GlebChrome.ink.opacity(0.56))
            }

            Button {
                HapticManager.shared.impact(.light)
                openChat(autoSend: nil, startFresh: true)
            } label: {
                HStack(spacing: 7) {
                    Text("Open chat")
                        .font(.appBody(13, weight: .semibold))
                    AppIcon("arrow-up-right", size: 12)
                }
                .foregroundStyle(Color.appOnAccent)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.appAccent, in: Capsule())
            }
            .buttonStyle(.appScale(0.97))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }

    // MARK: - Board

    private var boardLanes: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(BoardLane.allCases) { lane in
                let items = board.items(in: lane)
                if !items.isEmpty {
                    BoardLaneSection(
                        lane: lane,
                        items: items,
                        onOpen: { item in openBoardItem(item) },
                        onDecide: { item, approved, choice in
                            decide(on: item, approved: approved, choice: choice)
                        }
                    )
                }
            }
        }
    }

    private func openBoardItem(_ item: BoardItem) {
        HapticManager.shared.impact(.light)
        if let workflowId = item.workflowId {
            openWorkflowID = workflowId
            return
        }
        if item.taskId != nil {
            isAgentWorkPresented = true
            return
        }
        openChat(autoSend: nil, startFresh: false)
    }

    private func decide(on item: BoardItem, approved: Bool, choice: String?) {
        guard let workflowId = item.workflowId, let checkpointId = item.checkpointId else {
            openBoardItem(item)
            return
        }
        Task {
            do {
                try await HomeBoardService.resolveCheckpoint(
                    workflowId: workflowId,
                    checkpointId: checkpointId,
                    approved: approved,
                    choice: choice
                )
                HapticManager.shared.impact(.medium)
                await loadBoard()
            } catch {
                errorMessage = "Couldn't send that answer."
            }
        }
    }

    /// Acknowledge board changes once per visit.
    private func markBoardSeenOnce() async {
        guard !hasMarkedSeen else { return }
        hasMarkedSeen = true
        do {
            try await HomeBoardService.markSeen()
        } catch {
        }
    }

    private func loadBoard() async {
        do {
            let fetched = try await HomeBoardService.fetchBoard()
            withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { board = fetched }
        } catch {
        }
    }

    // MARK: - Chrome

    private var recentEntitiesRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(recentEntities) { entity in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entity.entityName)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(GlebChrome.ink.opacity(0.85))
                            .lineLimit(1)
                        Text(entity.site)
                            .font(.system(size: 11, weight: .regular))
                            .foregroundStyle(GlebChrome.ink.opacity(0.5))
                            .lineLimit(1)
                    }
                    .frame(width: 180, alignment: .leading)
                    .padding(12)
                    .background { MissionGlassPlate() }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func loadRecentEntities() async {
        do {
            let data = try await APIClient.shared.request(path: "/memory/recent-entities")
            let response = try JSONDecoder().decode(RecentEntitiesResponse.self, from: data)
            await MainActor.run { recentEntities = response.entities }
        } catch {
        }
    }

    private var composerBar: some View {
        HStack(spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                openChat(autoSend: nil, startFresh: true)
            } label: {
                AppIcon("plus", size: 16)
                    .foregroundStyle(GlebChrome.ink.opacity(0.6))
                    .frame(width: 40, height: 40)
                    .background(Color.appSurface, in: Circle())
                    .overlay(Circle().strokeBorder(Color.appHairline, lineWidth: 0.5))
            }
            .buttonStyle(.appScale)

            HStack(spacing: 9) {
                TextField("Ask or delegate", text: $composerDraft)
                    .font(.system(size: 16))
                    .foregroundStyle(GlebChrome.ink)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit { sendComposer() }

                if composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        HapticManager.shared.impact(.light)
                        openChat(autoSend: nil, startFresh: false)
                    } label: {
                        AppIcon("mic", size: 16)
                            .foregroundStyle(GlebChrome.ink.opacity(0.5))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: sendComposer) {
                        AppIcon("arrow-up", size: 14, weight: .bold)
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.black, in: Circle())
                    }
                    .buttonStyle(.appScale(0.94))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(Color.appSurface.opacity(0.94), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(composerFocused ? Color.appAccent.opacity(0.46) : Color.appHairline, lineWidth: composerFocused ? 1 : 0.6))
            .shadow(color: Color.appAccent.opacity(composerFocused ? 0.10 : 0.04), radius: composerFocused ? 14 : 8, y: 4)
        }
        .padding(5)
        .background(Color.appBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 23, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 23, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.6))
    }

    // MARK: - Navigation gestures

    private static let chatDragCommitDistance: CGFloat = -60

    /// Right-edge swipe to Chat.
    private var chatEdgeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard value.translation.width < 0 else { return }
                if !chatDragActive {
                    chatDragActive = true
                    HapticManager.shared.impact(.light)
                }
                chatDragOffset = max(value.translation.width, Self.chatDragCommitDistance - 20)
            }
            .onEnded { value in
                let committed = value.translation.width < Self.chatDragCommitDistance
                if committed {
                    HapticManager.shared.impact(.medium)
                    isChatHomePresented = true
                }
                chatDragActive = false
                withAnimation(.appSpring) { chatDragOffset = 0 }
            }
    }

    /// Chat edge-swipe indicator.
    private var chatPeekIndicator: some View {
        HStack {
            Spacer()
            AppIcon("chat", size: 17)
                .foregroundStyle(GlebChrome.ink.opacity(0.75))
                .frame(width: 44, height: 44)
                .background(Color.appSurface, in: Circle())
                .overlay(Circle().strokeBorder(Color.appHairline, lineWidth: 0.6))
                .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        }
        .padding(.trailing, 10)
        .offset(x: chatDragOffset)
        .opacity(chatDragActive ? min(Double(-chatDragOffset) / Double(-Self.chatDragCommitDistance), 1) : 0)
        .allowsHitTesting(false)
    }

    // MARK: - Data

    /// Deduplicated mission cards.
    private var visibleLifeBriefing: LifeBriefing? {
        guard let lifeBriefing, !lifeBriefing.items.isEmpty else { return nil }
        let missionTitles = missions.map { $0.title.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
        let missionTaskIDs = Set(missions.compactMap(\.taskID))
        let items = lifeBriefing.items.filter { item in
            let title = item.title.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            let duplicatesOutcome = missionTitles.contains { missionTitle in
                !title.isEmpty && !missionTitle.isEmpty &&
                    (missionTitle == title || missionTitle.contains(title) || title.contains(missionTitle))
            }
            let duplicatesInbox = item.kind.lowercased() == "message" &&
                missions.contains { $0.kind == .mailGroup }
            let duplicatesTask = item.taskId.map(missionTaskIDs.contains) ?? false
            return !duplicatesOutcome && !duplicatesInbox && !duplicatesTask
        }
        guard !items.isEmpty else { return nil }
        guard items.count != lifeBriefing.items.count else { return lifeBriefing }
        let headline = items.count == 1 ? "1 update" : "\(items.count) updates"
        return LifeBriefing(
            headline: headline,
            items: items,
            empty: false,
            generatedAt: lifeBriefing.generatedAt,
            coverage: lifeBriefing.coverage
        )
    }

    private var missions: [HomeMission] {
        let briefingMissions = HomeMissionBuilder.build(from: briefings).filter { mission in
            guard mission.kind != .agent else { return false }
            return hasEmailConnection || (mission.kind != .mailGroup && mission.kind != .incoming)
        }
        return (watchMissions + sessionMissions + localMissions + briefingMissions).compactMap { mission in
            guard mission.kind == .mailGroup else {
                return dismissedMissionIDs.contains(mission.id) ? nil : mission
            }
            var visible = mission
            visible.mailItems = mission.mailItems.filter { !dismissedMailIDs.contains($0.id) }
            return visible.mailItems.isEmpty ? nil : visible
        }
    }

    private var watchMissions: [HomeMission] {
        agentWatches.prefix(3).map { watch in
            let detail: String = {
                if let condition = watch.condition, !condition.isEmpty {
                    return "Until \(condition)"
                }
                return watch.cadenceLabel
            }()
            return HomeMission(
                id: "watch-\(watch.id)",
                kind: .agent,
                eyebrow: "Watching",
                title: watch.title,
                detail: detail,
                cta: "Stop watching",
                prompt: nil,
                symbol: "clock",
                isPrimary: true,
                watchID: watch.id
            )
        }
    }

    /// Cards for background sessions.
    private var sessionMissions: [HomeMission] {
        backgroundSessions
            .filter { $0.id != activeSession?.id }
            .map { session in
                let (eyebrow, cta): (String, String?) = {
                    if session.errorMessage != nil { return ("Needs you", "Retry") }
                    if session.isWorking { return ("Handling", nil) }
                    if case .assistantAsk = session.currentStep?.ui { return ("Needs you", "Reply") }
                    return ("Ready", "Review")
                }()
                return HomeMission(
                    id: sessionMissionID(session),
                    kind: .agent,
                    eyebrow: eyebrow,
                    title: session.title,
                    detail: session.errorMessage,
                    cta: cta,
                    prompt: nil,
                    symbol: "circle.dotted",
                    isPrimary: true
                )
            }
    }

    private func sessionMissionID(_ session: AgentTaskSession) -> String { "session-\(session.id)" }

    // MARK: - Actions

    private func handleLifeBriefingItem(_ item: LifeBriefingItem) {
        HapticManager.shared.impact(.light)
        if item.kind.caseInsensitiveCompare("approval") == .orderedSame {
            // Open the saved review before approving.
            openChat(autoSend: nil, startFresh: false, review: item.reviewAction)
            return
        }
        handleIntent(item.prompt ?? "Tell me more about \(item.title)")
    }

    private func sendComposer() {
        let text = composerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerDraft = ""
        composerFocused = false
        handleIntent(text)
    }

    private func handleMissionCTA(_ mission: HomeMission) {
        if let watchID = mission.watchID {
            Task { await stopWatch(id: watchID) }
            return
        }
        if mission.taskID != nil {
            HapticManager.shared.impact(.light)
            isAgentWorkPresented = true
            return
        }
        if let session = backgroundSessions.first(where: { sessionMissionID($0) == mission.id }) {
            HapticManager.shared.impact(.medium)
            activeSession = session
            return
        }
        let prompt = mission.prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        handleIntent((prompt?.isEmpty == false ? prompt : nil) ?? mission.title)
    }

    private func stopWatch(id: String) async {
        guard !stoppingWatchIDs.contains(id) else { return }
        await MainActor.run {
            stoppingWatchIDs.insert(id)
            HapticManager.shared.impact(.light)
        }
        do {
            try await AgentTasksService.cancelWatch(id: id)
            await MainActor.run {
                agentWatches.removeAll { $0.id == id }
                stoppingWatchIDs.remove(id)
            }
        } catch {
            await MainActor.run {
                stoppingWatchIDs.remove(id)
                errorMessage = "Could not stop watching this."
            }
        }
    }

    /// Stop showing a background session.
    private func abandonSession(_ id: String) {
        backgroundSessions.removeAll { sessionMissionID($0) == id }
    }

    /// Start work independently of the sheet lifecycle.
    private func startSession(_ session: AgentTaskSession) {
        activeSession = session
        Task { await session.start() }
    }

    /// Keep unfinished sessions visible on Home.
    private func backgroundIfNeeded(_ session: AgentTaskSession) {
        guard !session.isComplete, !backgroundSessions.contains(where: { $0.id == session.id }) else { return }
        backgroundSessions.append(session)
    }

    /// Reply opens review; other email actions use original links.
    private func handleMailCTA(_ email: BriefingEmail) {
        switch mailCTAKind(email.cta) {
        case .ignore:
            HapticManager.shared.impact(.light)
            _ = withAnimation(.appSpring) { dismissedMailIDs.insert(email.id) }
            persistDismissedMailIDs()
        case .reply:
            handleIntent(mailGoal(for: email))
        case .handle:
            guard let messageId = email.messageId, !messageId.isEmpty else {
                handleIntent(mailGoal(for: email))
                return
            }
            HapticManager.shared.impact(.medium)
            startSession(AgentTaskSession(
                title: email.cta ?? "Handling it",
                originalPrompt: mailGoal(for: email),
                kind: .task,
                userId: appState.userId,
                chatService: service,
                location: LocationManager.shared.locationDict,
                emailAction: .init(provider: email.provider, messageId: messageId)
            ))
        }
    }

    private var dismissedMailIDsKey: String { "oxy_dismissed_mail_ids_\(appState.userId)" }

    private func loadDismissedMailIDs() {
        let saved = UserDefaults.standard.stringArray(forKey: dismissedMailIDsKey) ?? []
        dismissedMailIDs = Set(saved)
    }

    private func persistDismissedMailIDs() {
        UserDefaults.standard.set(Array(dismissedMailIDs), forKey: dismissedMailIDsKey)
    }

    private var dismissedMissionIDsKey: String { "oxy_dismissed_mission_ids_\(appState.userId)" }

    private func loadDismissedMissionIDs() {
        let saved = UserDefaults.standard.stringArray(forKey: dismissedMissionIDsKey) ?? []
        dismissedMissionIDs = Set(saved)
    }

    private func dismissMission(_ id: String) {
        dismissedMissionIDs.insert(id)
        UserDefaults.standard.set(Array(dismissedMissionIDs), forKey: dismissedMissionIDsKey)
    }

    private enum MailCTAKind { case reply, ignore, handle }

    private func mailCTAKind(_ cta: String?) -> MailCTAKind {
        let lower = (cta ?? "").lowercased()
        if lower.contains("ignore") || lower.contains("archive") { return .ignore }
        if lower.contains("reply") || lower.contains("respond") { return .reply }
        return .handle
    }

    private func mailGoal(for email: BriefingEmail) -> String {
        let action = email.cta?.isEmpty == false ? email.cta! : "Help me with"
        let stakes = email.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        let context = (stakes?.isEmpty == false ? stakes! : email.cleanSubject)
        return "\(action) — email from \(email.cleanFrom): \(context)"
    }

    private func handleIntent(_ text: String) {
        HapticManager.shared.impact(.medium)
        openChat(autoSend: text, startFresh: true)
    }

    private func openChat(autoSend: String?, startFresh: Bool, review: ActionResult? = nil) {
        chatLaunch = ChatLaunch(autoSend: autoSend, startFresh: startFresh, review: review)
    }

    private func load(forceCheck: Bool) async {
        if forceCheck { isRefreshing = true } else if briefings.isEmpty { isLoading = true }
        errorMessage = nil

        async let weatherTask = OxyWeatherService.shared.currentWeather()
        async let emailConnectionTask = loadEmailConnection()

        if forceCheck {
            await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
            do {
                try await service.runProactiveCheck(userId: appState.userId)
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        do {
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }

        if let fetchedLifeBriefing = try? await service.loadLifeBriefing() {
            lifeBriefing = fetchedLifeBriefing
        }

        if let fetchedWatches = try? await AgentTasksService.fetchWatches() {
            agentWatches = fetchedWatches
        }

        weather = await weatherTask
        hasEmailConnection = await emailConnectionTask
        isLoading = false
        isRefreshing = false
    }

    private func loadEmailConnection() async -> Bool {
        do {
            let data = try await APIClient.shared.request(path: "/connectors/\(appState.userId)")
            let connectors = try JSONDecoder().decode(ConnectorsResponse.self, from: data).connectors
            return connectors.contains { connector in
                connector.enabled && ["google", "microsoft"].contains(connector.id)
            }
        } catch {
            return false
        }
    }

    // MARK: - Copy

    private var firstName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            let name = saved.userName.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty && !["user", "demo", "demo user", "test"].contains(name.lowercased()) {
                return name.split(separator: " ").first.map(String.init) ?? name
            }
        }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? ""
        let first = local.split(whereSeparator: { ".-_0123456789".contains($0) }).first.map(String.init) ?? ""
        if first.count >= 2, first.count <= 20,
           !["user", "demo", "test"].contains(first.lowercased()) {
            return first.prefix(1).uppercased() + first.dropFirst().lowercased()
        }
        return ""
    }

    /// Set on its own line so the name below can carry the accent.
    private var salutation: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let hello: String
        switch hour {
        case 5..<12: hello = "Good morning"
        case 12..<17: hello = "Good afternoon"
        case 17..<22: hello = "Good evening"
        default: hello = "Hey"
        }
        return firstName.isEmpty ? hello : "\(hello),"
    }

    private var dateLine: String {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f.string(from: Date())
    }
}

// MARK: - Chat launch

/// `fullScreenCover(item:)` needs an Identifiable, and a bare workflow id string is not one.
private struct OpenWorkflow: Identifiable, Equatable {
    let id: String
}

private struct ChatLaunch: Identifiable, Equatable {
    let id = UUID()
    let autoSend: String?
    let startFresh: Bool
    let review: ActionResult?
}

private struct LifeBriefingCard: View {
    let briefing: LifeBriefing
    let onItem: (LifeBriefingItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("What matters")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink.opacity(0.5))
                Spacer()
                AppIcon("sparkles", size: 15)
                    .foregroundStyle(GlebChrome.ink.opacity(0.45))
            }

            VStack(spacing: 0) {
                ForEach(briefing.items) { item in
                    Button {
                        HapticManager.shared.impact(.light)
                        onItem(item)
                    } label: {
                        HStack(alignment: .top, spacing: 11) {
                            AppIcon(item.iconName, size: 16)
                                .foregroundStyle(GlebChrome.ink.opacity(0.6))
                                .frame(width: 26, height: 26)
                                .background(GlebChrome.ink.opacity(0.06), in: Circle())

                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.displayTitle)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(GlebChrome.ink)
                                    .multilineTextAlignment(.leading)
                                if item.kind.caseInsensitiveCompare("approval") != .orderedSame,
                                   let detail = item.displayDetail {
                                    Text(detail)
                                        .font(.system(size: 13))
                                        .foregroundStyle(GlebChrome.ink.opacity(0.55))
                                        .multilineTextAlignment(.leading)
                                }
                            }

                            Spacer(minLength: 6)
                            AppIcon("arrow-right", size: 12)
                                .foregroundStyle(GlebChrome.ink.opacity(0.35))
                                .padding(.top, 7)
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)

                    if item.id != briefing.items.last?.id {
                        Divider()
                            .overlay(GlebChrome.ink.opacity(0.08))
                    }
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }
}

// MARK: - Mission cards

struct HomeMission: Identifiable, Equatable {
    enum Kind: Equatable {
        case action
        case status
        case mailGroup
        case incoming
        case agent
    }

    let id: String
    let kind: Kind
    let eyebrow: String
    let title: String
    let detail: String?
    let cta: String?
    let prompt: String?
    let symbol: String
    let isPrimary: Bool
    var taskID: String? = nil
    var watchID: String? = nil
    /// Optional card payload.
    var deliveryStage: Int? = nil
    var vendor: String? = nil
    var sender: String? = nil
    /// Inbox emails grouped on one card.
    var mailItems: [BriefingEmail] = []

    var displayTitle: String {
        var words = title.split(separator: " ").map(String.init)
        while words.count > 1,
              words[words.count - 1].caseInsensitiveCompare(words[words.count - 2]) == .orderedSame {
            words.removeLast()
        }
        let collapsed = words.joined(separator: " ")
        return collapsed.replacingOccurrences(of: "a appointment", with: "an appointment", options: .caseInsensitive)
    }
}

enum HomeMissionBuilder {
    static func build(from briefings: [Briefing]) -> [HomeMission] {
        var out: [HomeMission] = []
        var seen = Set<String>()
        var mailItems: [BriefingEmail] = []
        var seenMailIDs = Set<String>()
        let latestEmailBriefingID = briefings.first(where: { !$0.emails.isEmpty })?.id

        for briefing in briefings {
            let briefingAge = Date.oxyParse(briefing.createdAt).map { Date().timeIntervalSince($0) }
            let signalsAreFresh = briefingAge.map { $0 < 2 * 24 * 3600 } ?? false
            for signal in (signalsAreFresh ? briefing.signals : []) {
                let id = "sig-\(briefing.id)-\(signal.id)"
                guard seen.insert(id).inserted else { continue }

                if signal.isPending {
                    out.append(HomeMission(
                        id: id,
                        kind: .action,
                        eyebrow: "Needs you",
                        title: signal.title,
                        detail: signal.detail,
                        cta: signal.label ?? "Open",
                        prompt: signal.prompt ?? signal.title,
                        symbol: "bolt.fill",
                        isPrimary: true
                    ))
                } else if signal.isDone {
                    out.append(HomeMission(
                        id: id,
                        kind: .status,
                        eyebrow: "Done",
                        title: signal.title,
                        detail: signal.receipt ?? signal.detail,
                        cta: signal.canUndo ? "Undo" : nil,
                        prompt: signal.canUndo ? "Undo: \(signal.title)" : nil,
                        symbol: "checkmark.circle.fill",
                        isPrimary: false
                    ))
                } else if let detail = signal.detail, !detail.isEmpty {
                    out.append(HomeMission(
                        id: id,
                        kind: .status,
                        eyebrow: "For you",
                        title: signal.title,
                        detail: detail,
                        cta: "Ask",
                        prompt: signal.prompt ?? "About: \(signal.title). \(detail)",
                        symbol: "sparkles",
                        isPrimary: false
                    ))
                }
            }

            for item in briefing.incoming {
                let id = "in-\(briefing.id)-\(item.id)"
                guard seen.insert(id).inserted else { continue }
                let cta = item.isDelivery ? "Track" : "Details"
                var incomingParts = [item.vendor, item.status]
                if let eta = item.eta, !eta.isEmpty { incomingParts.append(eta) }
                out.append(HomeMission(
                    id: id,
                    kind: .incoming,
                    eyebrow: item.isDelivery ? "Incoming" : "Reservation",
                    title: item.cleanTitle,
                    detail: incomingParts.joined(separator: " · "),
                    cta: cta,
                    prompt: "Update me on \(item.cleanTitle) from \(item.vendor)",
                    symbol: item.isDelivery ? "shippingbox.fill" : "calendar",
                    isPrimary: item.isDelivery,
                    deliveryStage: item.isDelivery ? item.stage : nil,
                    vendor: item.vendor
                ))
            }

            if briefing.id == latestEmailBriefingID {
                for email in briefing.emails where !email.isLikelyPromotional {
                    guard seenMailIDs.insert(email.id).inserted else { continue }
                    mailItems.append(email)
                }
            }

            let k = briefing.kind.lowercased()
            if (k.contains("agent") || k.contains("task")) && briefing.signals.isEmpty {
                let id = "br-\(briefing.id)"
                guard seen.insert(id).inserted else { continue }
                out.append(HomeMission(
                    id: id,
                    kind: .agent,
                    eyebrow: "Handling",
                    title: briefing.title ?? "Update",
                    detail: briefing.body,
                    cta: "Continue",
                    prompt: briefing.body,
                    symbol: "circle.dotted",
                    isPrimary: true
                ))
            }
        }

        if !mailItems.isEmpty {
            out.append(HomeMission(
                id: "mail-group",
                kind: .mailGroup,
                eyebrow: "Inbox",
                title: mailItems.count == 1 ? "1 email needs you" : "\(mailItems.count) emails need you",
                detail: nil,
                cta: nil,
                prompt: nil,
                symbol: "envelope.fill",
                isPrimary: false,
                mailItems: mailItems
            ))
        }

        let ranked = out.sorted { a, b in
            if a.isPrimary != b.isPrimary { return a.isPrimary && !b.isPrimary }
            return false
        }
        return Array(ranked.prefix(8))
    }
}

// MARK: - Briefing mission card (secondary under concept cards)

struct MissionCardView: View {
    let mission: HomeMission
    var ink: Color
    var onCTA: () -> Void
    /// Fires with the specific email a page's "Draft reply" was tapped on — only
    /// used by `.mailGroup`, which has no single card-level prompt to send via `onCTA`.
    var onMailCTA: (BriefingEmail) -> Void = { _ in }
    /// Swipe-to-dismiss, either direction. Nil for `.mailGroup` — that card already owns
    /// its own horizontal gesture (TabView paging between emails) and per-email "Ignore".
    var onDismiss: (() -> Void)? = nil

    @State private var expanded = false
    @State private var dragOffset: CGFloat = 0
    @State private var dragStarted = false
    @State private var isDismissing = false

    private static let dismissCommitDistance: CGFloat = 110

    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                guard onDismiss != nil else { return }
                if !dragStarted {
                    dragStarted = true
                    HapticManager.shared.impact(.light)
                }
                dragOffset = value.translation.width
            }
            .onEnded { value in
                guard onDismiss != nil else { return }
                dragStarted = false
                if abs(value.translation.width) > Self.dismissCommitDistance {
                    HapticManager.shared.impact(.medium)
                    isDismissing = true
                    withAnimation(.appSpring) {
                        dragOffset = value.translation.width > 0 ? 600 : -600
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                        onDismiss?()
                    }
                } else {
                    withAnimation(.appSpring) { dragOffset = 0 }
                }
            }
    }

    private var canExpand: Bool {
        switch mission.kind {
        case .incoming where mission.deliveryStage != nil: return true
        default: return false
        }
    }

    private var isTappable: Bool { canExpand || mission.cta != nil }

    var body: some View {
        if mission.kind == .mailGroup {
            mailGroupCard
                .padding(16)
                .background { MissionGlassPlate() }
        } else {
            Button {
                if canExpand {
                    HapticManager.shared.impact(.light)
                    withAnimation(.appExpand) { expanded.toggle() }
                } else if mission.cta != nil {
                    onCTA()
                }
            } label: {
                Group {
                    switch mission.kind {
                    case .incoming where mission.deliveryStage != nil:
                        deliveryCard
                    case .incoming:
                        reservationCard
                    default:
                        standardCard
                    }
                }
                .padding(16)
                .background { MissionGlassPlate() }
                .contentShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
            }
            .buttonStyle(.appScale(0.98))
            .disabled(!isTappable)
            .offset(x: dragOffset)
            .opacity(isDismissing ? 0 : 1)
            .simultaneousGesture(dismissGesture)
        }
    }

    // MARK: - Delivery

    private var deliveryCard: some View {
        let stage = min(max(mission.deliveryStage ?? 0, 0), 3)
        let labels = ["Ordered", "Shipped", "Out for delivery", "Delivered"]
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(mission.displayTitle)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let vendor = mission.vendor {
                        HStack(spacing: 5) {
                            AppIcon("box", size: 11)
                            Text(vendor)
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(ink.opacity(0.5))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(ink.opacity(0.05), in: Capsule())
                    }
                }
                Spacer(minLength: 8)
                brandBadge(mission.vendor, color: Color(red: 0.13, green: 0.15, blue: 0.2))
            }

            deliveryRail(stage: stage, labels: labels)

            if expanded {
                routeMap
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            HStack {
                if let eta = deliveryETA {
                    HStack(spacing: 5) {
                        AppIcon("clock", size: 12)
                        Text(eta).font(.system(size: 12, weight: .medium))
                    }
                    .foregroundStyle(ink.opacity(0.5))
                }
                Spacer()
                pillCTA(mission.cta ?? "Track", primary: true)
            }
        }
    }

    private var routeMap: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(red: 0.93, green: 0.94, blue: 0.96))
            GeometryReader { geo in
                Path { p in
                    p.move(to: CGPoint(x: 16, y: geo.size.height - 14))
                    p.addCurve(
                        to: CGPoint(x: geo.size.width - 24, y: 16),
                        control1: CGPoint(x: geo.size.width * 0.4, y: geo.size.height - 8),
                        control2: CGPoint(x: geo.size.width * 0.5, y: 10)
                    )
                }
                .stroke(Color(red: 0.18, green: 0.7, blue: 0.34).opacity(0.6),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [1, 6]))
                Circle()
                    .fill(Color(red: 0.18, green: 0.7, blue: 0.34))
                    .frame(width: 9, height: 9)
                    .position(x: geo.size.width - 24, y: 16)
            }
        }
        .frame(height: 86)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func deliveryRail(stage: Int, labels: [String]) -> some View {
        VStack(spacing: 7) {
            HStack(spacing: 3) {
                ForEach(0..<labels.count, id: \.self) { i in
                    Circle()
                        .fill(i <= stage ? Color(red: 0.18, green: 0.7, blue: 0.34) : ink.opacity(0.16))
                        .frame(width: i == stage ? 11 : 9, height: i == stage ? 11 : 9)
                        .overlay {
                            if i == stage {
                                Circle().stroke(Color(red: 0.18, green: 0.7, blue: 0.34).opacity(0.22), lineWidth: 4)
                            }
                        }
                    if i < labels.count - 1 {
                        Capsule()
                            .fill(i < stage ? Color(red: 0.18, green: 0.7, blue: 0.34) : ink.opacity(0.12))
                            .frame(height: 2)
                    }
                }
            }
            HStack {
                ForEach(0..<labels.count, id: \.self) { i in
                    Text(labels[i])
                        .font(.system(size: 10, weight: i == stage ? .semibold : .regular))
                        .foregroundStyle(i == stage ? ink.opacity(0.8) : ink.opacity(0.4))
                        .frame(maxWidth: .infinity, alignment: i == 0 ? .leading : (i == labels.count - 1 ? .trailing : .center))
                }
            }
        }
    }

    private var deliveryETA: String? {
        guard let parts = mission.detail?.components(separatedBy: " · "), parts.count >= 3 else { return nil }
        return parts.last
    }

    // MARK: - Mail group

    @State private var mailPage = 0

    private var mailGroupCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(mission.eyebrow)
                    .font(.appBody(13, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.42))
                Spacer(minLength: 8)
                if mission.mailItems.count > 1 {
                    Text("\(mailPage + 1)/\(mission.mailItems.count)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.45))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Color.appSurface2, in: Capsule())
                }
            }

            TabView(selection: $mailPage) {
                ForEach(Array(mission.mailItems.enumerated()), id: \.element.id) { index, email in
                    mailPageCard(email)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: 176)
            .onChange(of: mission.mailItems.count) { _, newCount in
                if mailPage >= newCount { mailPage = max(0, newCount - 1) }
            }
        }
    }

    private func mailPageCard(_ email: BriefingEmail) -> some View {
        let name = email.displayFrom
        let summary = email.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack(alignment: .topLeading) {
                    Circle()
                        .fill(ink.opacity(0.08))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Text(monogram(name))
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(ink.opacity(0.65))
                        )
                    providerBadge(email.provider)
                        .offset(x: -6, y: -6)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(ink)
                        .lineLimit(1)
                    Text(email.cleanSubject)
                        .font(.system(size: 13))
                        .foregroundStyle(ink.opacity(0.55))
                        .lineLimit(1)
                    if let text = (summary?.isEmpty == false ? summary : email.cleanSnippet), !text.isEmpty {
                        Text(text)
                            .font(.system(size: 12.5))
                            .foregroundStyle(ink.opacity(0.6))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
            HStack {
                Button {
                    HapticManager.shared.impact(.light)
                    onMailCTA(email)
                } label: {
                    HStack(spacing: 8) {
                        Text(email.cta?.isEmpty == false ? email.cta! : "Draft reply")
                            .font(.system(size: 14, weight: .semibold))
                        AppIcon("arrow-right", size: 15, weight: .semibold)
                    }
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background { Capsule().fill(Color.black) }
                }
                .buttonStyle(.appScale(0.96))
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func providerBadge(_ provider: String?) -> some View {
        switch provider {
        case "outlook":
            providerBadgeIcon("outlook")
        case "gmail":
            providerBadgeIcon("google")
        default:
            EmptyView()
        }
    }

    private func providerBadgeIcon(_ assetName: String) -> some View {
        Image(assetName)
            .resizable()
            .scaledToFit()
            .frame(width: 16, height: 16)
            .padding(3)
            .background(Circle().fill(Color.white))
            .overlay(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1))
            .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
    }

    // MARK: - Reservation

    private var reservationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                AppIcon("calendar", size: 17)
                    .foregroundStyle(Color(red: 0.55, green: 0.4, blue: 0.85))
                    .frame(width: 40, height: 40)
                    .background(Color(red: 0.55, green: 0.4, blue: 0.85).opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(mission.eyebrow)
                        .font(.appBody(13, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.42))
                    Text(mission.displayTitle)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(ink)
                    if let detail = mission.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 13))
                            .foregroundStyle(ink.opacity(0.55))
                    }
                }
                Spacer(minLength: 0)
            }
            HStack {
                Spacer(minLength: 0)
                pillCTA(mission.cta ?? "Details", primary: false)
            }
        }
    }

    // MARK: - Standard (action / status / reservation / agent)

    private var standardCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                AppIcon(AppGlyph.mission(mission.symbol), size: 15)
                    .foregroundStyle(accent)
                    .frame(width: 34, height: 34)
                    .background(accent.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if mission.kind == .agent && mission.eyebrow == "Handling" {
                            PulsingWorkDot(active: true)
                                .frame(width: 10, height: 10)
                        }
                        Text(mission.eyebrow)
                            .font(.appBody(13, weight: .semibold))
                            .foregroundStyle(mission.kind == .status ? Color(red: 0.16, green: 0.6, blue: 0.3) : ink.opacity(0.42))
                    }
                    Text(mission.displayTitle)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = mission.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 13))
                            .foregroundStyle(ink.opacity(0.55))
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }

            if let cta = mission.cta {
                HStack {
                    Spacer(minLength: 0)
                    pillCTA(cta, primary: mission.isPrimary)
                }
            }
        }
    }

    private var accent: Color {
        switch mission.kind {
        case .action: return Color(red: 0.16, green: 0.15, blue: 0.2)
        case .status: return Color(red: 0.18, green: 0.6, blue: 0.32)
        default: return ink.opacity(0.7)
        }
    }

    // MARK: - Shared bits

    private func pillCTA(_ label: String, primary: Bool) -> some View {
        Button(action: onCTA) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                AppIcon("arrow-right", size: 15, weight: .semibold)
            }
            .foregroundStyle(primary ? Color.white : ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background {
                if primary { Capsule().fill(Color.black) }
                else { Capsule().fill(ink.opacity(0.07)) }
            }
        }
        .buttonStyle(.appScale(0.96))
    }

    private func brandBadge(_ vendor: String?, color: Color) -> some View {
        Circle()
            .fill(color)
            .frame(width: 36, height: 36)
            .overlay(
                Text(monogram(vendor ?? "•"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
            )
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    }

    private func monogram(_ s: String) -> String {
        let parts = s.split(separator: " ").prefix(2)
        let initials = parts.compactMap { $0.first }.map(String.init).joined()
        return initials.isEmpty ? String(s.prefix(1)).uppercased() : initials.uppercased()
    }
}

struct MissionGlassPlate: View {
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
        ZStack {
            Color.appSurface.opacity(0.92)
            AppGrain(intensity: 0.028)
        }
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.appHairline, lineWidth: 0.6))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.white.opacity(0.20))
                    .frame(height: 0.7)
                    .clipShape(shape)
            }
            .shadow(color: Color(red: 0.19, green: 0.14, blue: 0.08).opacity(0.07), radius: 12, y: 5)
    }
}

/// Kept for AgentTaskSessionView and other call sites.
struct AgenticWashBackground: View {
    var body: some View {
        GlebChrome.pastelBlob
    }
}

#Preview {
    AgenticHomeView()
        .environment(AppState())
}
