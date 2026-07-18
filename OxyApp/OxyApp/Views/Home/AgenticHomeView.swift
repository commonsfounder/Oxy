import SwiftUI

// MARK: - Agentic home
//
// Visual language after the Gleb Kuznetsov concept (soft pastel wash, glass,
// serif greeting): https://x.com/glebich/status/2066714881911586836
//
// A buy/food-order/ride intent opens AgentTaskSession's native step-flow shell
// (search animation → result → confirm), but every field on it comes from the
// real backend — the same run_browser_task/confirm_browser_payment/book_uber
// pipeline chat already uses, just without rendering a chat transcript. Restaurant
// bookings have no real backend yet, so that intent isn't matched — see
// Models/AgentTaskSession.swift and docs/superpowers/specs/2026-07-18-real-buy-flow-design.md.

struct AgenticHomeView: View {
    @Environment(AppState.self) private var appState

    @State private var briefings: [Briefing] = []
    @State private var isLoading = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var chatLaunch: ChatLaunch?
    @State private var activeSession: AgentTaskSession?
    @State private var localMissions: [HomeMission] = []
    /// "Ignore" on an inbox card is a purely local dismiss — there's no real
    /// archive/mark-read backend action to call, so this never claims the email was
    /// actually archived server-side, only that it's hidden from this feed.
    @State private var dismissedMailIDs: Set<String> = []
    @State private var composerDraft = ""
    @FocusState private var composerFocused: Bool
    private let service = ChatService()

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
                                NotificationCenter.default.post(name: .oxyJumpToMore, object: nil)
                            }
                        )
                        .padding(.top, 8)

                        greetingBlock
                            .padding(.top, 2)

                        if let errorMessage {
                            ErrorBanner(message: errorMessage) {
                                Task { await load(forceCheck: false) }
                            }
                        }

                        if isLoading && missions.isEmpty {
                            ProgressView()
                                .tint(GlebChrome.ink.opacity(0.4))
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if missions.isEmpty {
                            emptyMissions
                                .padding(.top, 4)
                        } else {
                            LazyVStack(spacing: 12) {
                                ForEach(missions) { mission in
                                    MissionCardView(
                                        mission: mission,
                                        ink: GlebChrome.ink,
                                        onCTA: { handleMissionCTA(mission) },
                                        onMailCTA: { email in handleMailCTA(email) }
                                    )
                                    .transition(.asymmetric(
                                        insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: .top)),
                                        removal: .opacity
                                    ))
                                }
                            }
                        }

                        suggestionRail
                            .padding(.top, 2)
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
        }
        .preferredColorScheme(.light)
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .task { await load(forceCheck: false) }
        .onChange(of: chatLaunch) { old, new in
            if old != nil && new == nil {
                Task { await load(forceCheck: false) }
            }
        }
        .fullScreenCover(item: $chatLaunch) { launch in
            NavigationStack {
                ChatView(
                    autoSendTranscript: launch.autoSend,
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
                onDismiss: { activeSession = nil },
                onComplete: { title in
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
                    activeSession = nil
                    openChat(autoSend: prompt, startFresh: true)
                }
            )
        }
    }

    // MARK: - Greeting (video: date + large serif over pastel)

    private var greetingBlock: some View {
        ZStack(alignment: .bottomLeading) {
            // Soft rainbow under the name, like the concept
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 1.0, green: 0.88, blue: 0.75).opacity(0.65),
                            Color(red: 0.9, green: 0.85, blue: 1.0).opacity(0.4),
                            Color(red: 0.85, green: 0.93, blue: 1.0).opacity(0.25),
                            .clear
                        ],
                        center: .center,
                        startRadius: 4,
                        endRadius: 120
                    )
                )
                .frame(width: 280, height: 90)
                .offset(x: 20, y: 10)
                .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 6) {
                Text(dateLine)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(GlebChrome.ink.opacity(0.4))

                Text(greetingLine)
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(GlebChrome.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
    }

    // MARK: - Chrome

    private var emptyMissions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing running right now")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(GlebChrome.ink)
            Text("Ask for a ride, book dinner, order food, or buy something — the job runs as a card and the result lands here.")
                .font(.system(size: 14))
                .foregroundStyle(GlebChrome.ink.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }

    private var suggestionRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { prompt in
                    Button {
                        handleIntent(prompt)
                    } label: {
                        Text(prompt)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(GlebChrome.ink.opacity(0.75))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.ultraThinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.55), lineWidth: 0.5))
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
            .padding(.vertical, 2)
        }
    }

    private static let suggestions = [
        "Book a table for dinner",
        "Book a ride home",
        "Order food nearby",
        "Buy a gift"
    ]

    private var composerBar: some View {
        HStack(spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                openChat(autoSend: nil, startFresh: true)
            } label: {
                AppIcon("plus", size: 16)
                    .foregroundStyle(GlebChrome.ink.opacity(0.6))
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                TextField("Type a message", text: $composerDraft)
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
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.75), lineWidth: 0.6))
            .shadow(color: .black.opacity(0.08), radius: 16, y: 6)
        }
    }

    // MARK: - Data

    private var missions: [HomeMission] {
        (localMissions + HomeMissionBuilder.build(from: briefings)).compactMap { mission in
            guard mission.kind == .mailGroup else { return mission }
            var visible = mission
            visible.mailItems = mission.mailItems.filter { !dismissedMailIDs.contains($0.id) }
            return visible.mailItems.isEmpty ? nil : visible
        }
    }

    // MARK: - Actions

    private func sendComposer() {
        let text = composerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerDraft = ""
        composerFocused = false
        handleIntent(text)
    }

    private func handleMissionCTA(_ mission: HomeMission) {
        let prompt = mission.prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        handleIntent((prompt?.isEmpty == false ? prompt : nil) ?? mission.title)
    }

    /// Inbox card action routing. The concierge already has everything it needs
    /// (sender, subject, the stakes-first summary) — re-opening chat and re-explaining
    /// that context for every tap defeats the point of surfacing it on the card at
    /// all. Route by what the server judged the real next step to be:
    ///  - "Ignore"/"Archive": nothing to hand off — dismiss locally. There's no real
    ///    archive/mark-read action wired up server-side yet, so this only hides the
    ///    card, it doesn't claim to have touched the actual inbox.
    ///  - "Reply": a reply is content sent on the user's behalf under their name —
    ///    that still deserves a look before it goes, so this opens chat (which
    ///    already gates send_email behind a confirm step) rather than firing blind.
    ///  - everything else ("Pay it", "Sort it", "Review", "Confirm"...): never
    ///    routed through run_browser_task or chat's agent loop — a bank/card-issuer
    ///    site can't be safely logged into by a bot (2FA, aggressive anti-automation),
    ///    so that's never even attempted. Instead this mines the ORIGINAL email for
    ///    real links the provider already sent (e.g. Revolut's own "Add money" link)
    ///    and writes manual steps — see buildEmailActionPlan in api/index.js.
    private func handleMailCTA(_ email: BriefingEmail) {
        switch mailCTAKind(email.cta) {
        case .ignore:
            HapticManager.shared.impact(.light)
            withAnimation(.appSpring) { dismissedMailIDs.insert(email.id) }
        case .reply:
            handleIntent(mailGoal(for: email))
        case .handle:
            guard let messageId = email.messageId, !messageId.isEmpty else {
                // Older briefing, created before messageId tagging existed — nothing
                // to look up server-side, so fall back to the honest chat handoff
                // rather than opening a session that's guaranteed to fail.
                handleIntent(mailGoal(for: email))
                return
            }
            HapticManager.shared.impact(.medium)
            activeSession = AgentTaskSession(
                title: email.cta ?? "Handling it",
                originalPrompt: mailGoal(for: email),
                kind: .task,
                userId: appState.userId,
                chatService: service,
                location: LocationManager.shared.locationDict,
                emailAction: .init(provider: email.provider, messageId: messageId)
            )
        }
    }

    private enum MailCTAKind { case reply, ignore, handle }

    private func mailCTAKind(_ cta: String?) -> MailCTAKind {
        let lower = (cta ?? "").lowercased()
        if lower.contains("ignore") || lower.contains("archive") { return .ignore }
        if lower.contains("reply") || lower.contains("respond") { return .reply }
        return .handle
    }

    /// Leads with the server's judged action and the stakes-first summary (not just
    /// the bare subject line) so whichever pipeline picks this up — chat or the
    /// hidden native runner — starts already knowing what actually matters.
    private func mailGoal(for email: BriefingEmail) -> String {
        let action = email.cta?.isEmpty == false ? email.cta! : "Help me with"
        let stakes = email.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        let context = (stakes?.isEmpty == false ? stakes! : email.cleanSubject)
        return "\(action) — email from \(email.cleanFrom): \(context)"
    }

    /// Generated-UI-for-the-job path: a native step session, wired to the real
    /// backend pipeline, when the intent is a buy, food order, or ride — restaurant
    /// bookings and anything else unmatched fall through to real chat, same as any
    /// unmatched message.
    private func handleIntent(_ text: String) {
        HapticManager.shared.impact(.medium)
        if let kind = AgentPlanGenerator.jobKind(for: text) {
            activeSession = AgentTaskSession(
                title: text,
                originalPrompt: text,
                kind: kind,
                userId: appState.userId,
                chatService: service,
                location: LocationManager.shared.locationDict
            )
        } else {
            openChat(autoSend: text, startFresh: true)
        }
    }

    private func openChat(autoSend: String?, startFresh: Bool) {
        chatLaunch = ChatLaunch(autoSend: autoSend, startFresh: startFresh)
    }

    private func load(forceCheck: Bool) async {
        if forceCheck { isRefreshing = true } else if briefings.isEmpty { isLoading = true }
        errorMessage = nil

        async let weatherTask = OxyWeatherService.shared.currentWeather()

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

        #if DEBUG
        // Seed a representative card mix when running against a backend with no
        // data (Simulator/demo) so the Home surface can be seen and iterated on.
        if briefings.isEmpty && appState.isDemoSession {
            errorMessage = nil
            briefings = AgenticHomeView.sampleBriefings
        }
        #endif

        weather = await weatherTask
        isLoading = false
        isRefreshing = false
    }

    #if DEBUG
    static let sampleBriefings: [Briefing] = [
        Briefing(
            id: "sample-1",
            kind: "agent_task",
            title: "Today",
            body: "",
            source: "demo",
            read: false,
            createdAt: nil,
            metadata: BriefingMetadata(
                emails: [
                    BriefingEmail(
                        from: "Dana Kim <dana@studio.co>",
                        subject: "Deck for the 3pm review",
                        snippet: "Can you send the latest before we meet?",
                        date: "9:02 AM",
                        summary: "Wants the deck before the 3pm review"
                    )
                ],
                incoming: [
                    BriefingIncoming(
                        kind: "delivery",
                        title: "Sony WH-1000XM6",
                        vendor: "Amazon",
                        status: "Out for delivery",
                        eta: "2:40 PM",
                        stage: 2
                    ),
                    BriefingIncoming(
                        kind: "reservation",
                        title: "Dinner · Kōji",
                        vendor: "Resy",
                        status: "Confirmed",
                        eta: "Fri 7:30 PM",
                        stage: nil
                    )
                ],
                lead: nil,
                signals: [
                    BriefingSignal(
                        title: "Reply to Dana about the 3pm deck",
                        detail: "She needs the latest version before the review",
                        status: "pending",
                        receipt: nil,
                        label: "Draft reply",
                        prompt: "Draft a reply to Dana about the 3pm deck",
                        undo: nil
                    ),
                    BriefingSignal(
                        title: "Rebooked your 6pm ride to 7:30",
                        detail: nil,
                        status: "done",
                        receipt: "Uber · confirmation #4821",
                        label: nil,
                        prompt: nil,
                        undo: BriefingSignalUndo(type: "ride")
                    )
                ],
                narrative: nil,
                wellbeing: nil
            )
        )
    ]
    #endif

    // MARK: - Copy

    private var firstName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            let name = saved.userName.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty {
                return name.split(separator: " ").first.map(String.init) ?? name
            }
        }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? ""
        let first = local.split(whereSeparator: { ".-_0123456789".contains($0) }).first.map(String.init) ?? ""
        if first.count >= 2, first.count <= 20 {
            return first.prefix(1).uppercased() + first.dropFirst().lowercased()
        }
        return "there"
    }

    private var greetingLine: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let hello: String
        switch hour {
        case 5..<12: hello = "Good morning"
        case 12..<17: hello = "Good afternoon"
        case 17..<22: hello = "Good evening"
        default: hello = "Hey"
        }
        return "\(hello),\n\(firstName)"
    }

    private var dateLine: String {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f.string(from: Date())
    }
}

// MARK: - Chat launch

private struct ChatLaunch: Identifiable, Equatable {
    let id = UUID()
    let autoSend: String?
    let startFresh: Bool
}

// MARK: - Mission model (briefing → cards)

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
    /// Structured payload for bespoke (Gleb-style) card rendering. All optional so
    /// existing call sites are unaffected and cards degrade gracefully.
    var deliveryStage: Int? = nil
    var vendor: String? = nil
    var sender: String? = nil
    /// Every real (non-promotional) inbox email across all recent briefings, swiped
    /// through as one card instead of one card per email — only set on `.mailGroup`.
    var mailItems: [BriefingEmail] = []
}

enum HomeMissionBuilder {
    static func build(from briefings: [Briefing]) -> [HomeMission] {
        var out: [HomeMission] = []
        var seen = Set<String>()
        // Collected across every briefing and appended as one swipeable card at the
        // end, instead of one full card per email — an inbox list doesn't belong in
        // a feed of "what matters today". Deduped by the email's own identity
        // (from+subject), not per-briefing, since the same email can appear in more
        // than one briefing window.
        var mailItems: [BriefingEmail] = []
        var seenMailIDs = Set<String>()

        for briefing in briefings {
            for signal in briefing.signals {
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

            for email in briefing.emails where !email.isLikelyPromotional {
                guard seenMailIDs.insert(email.id).inserted else { continue }
                mailItems.append(email)
            }

            let k = briefing.kind.lowercased()
            if (k.contains("agent") || k.contains("task")) && briefing.signals.isEmpty {
                let id = "br-\(briefing.id)"
                guard seen.insert(id).inserted else { continue }
                out.append(HomeMission(
                    id: id,
                    kind: .agent,
                    eyebrow: "Working",
                    title: briefing.title ?? "Task in progress",
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

    @State private var expanded = false

    private var canExpand: Bool {
        switch mission.kind {
        case .incoming where mission.deliveryStage != nil: return true
        default: return false
        }
    }

    /// Whether tapping the card does anything at all — gates both the button's
    /// enabled state and its press-scale, so a card with nothing to do doesn't
    /// visually invite a tap it can't honour.
    private var isTappable: Bool { canExpand || mission.cta != nil }

    var body: some View {
        // The inbox card owns its own swipe/tap gestures (a per-page "Draft reply"
        // button plus the TabView's own drag recognizer) — wrapping it in the shared
        // outer Button below would have `.disabled(!isTappable)` (true here, since
        // there's no single card-level cta) propagate through the environment and
        // disable those nested controls too. Render it as its own root instead.
        if mission.kind == .mailGroup {
            mailGroupCard
                .padding(16)
                .background { MissionGlassPlate() }
        } else {
            // A plain onTapGesture here gave the single most-tapped surface in the whole
            // Home feed zero press feedback, unlike every other tappable element in the
            // app (pillCTA, AppRow, etc. all use appScale) — a real feedback gap on a
            // tens-of-times-a-day surface, not just a cosmetic nit.
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
                .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
            .buttonStyle(.appScale(0.98))
            .disabled(!isTappable)
        }
    }

    // MARK: - Delivery (Gleb route-card anatomy: title · id-pill · progress rail)

    private var deliveryCard: some View {
        let stage = min(max(mission.deliveryStage ?? 0, 0), 3)
        let labels = ["Ordered", "Shipped", "Out for delivery", "Delivered"]
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(mission.title)
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

    /// Faint route-map strip revealed on expand — mirrors the reference map snippet.
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
        // detail is "vendor · status · eta" — surface the trailing ETA if present.
        guard let parts = mission.detail?.components(separatedBy: " · "), parts.count >= 3 else { return nil }
        return parts.last
    }

    // MARK: - Mail group (one swipeable card for every real inbox email, not one card each)

    @State private var mailPage = 0

    private var mailGroupCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(mission.eyebrow.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(ink.opacity(0.42))
                Spacer(minLength: 8)
                if mission.mailItems.count > 1 {
                    Text("\(mailPage + 1)/\(mission.mailItems.count)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.45))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: Capsule())
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
            // Dismissing (Ignore) or the underlying briefing refreshing can shrink
            // mailItems out from under a page index that was pointing past the new
            // end — clamp so the TabView never holds a selection tag that no longer
            // exists.
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
                    // The one-line summary — this is the actual answer to "why does this
                    // need my attention" — prefers the server's judgment over the raw
                    // (often truncated HTML) Gmail/Outlook snippet.
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

    /// Small full-colour brand mark (Assets: "google" / "outlook") pinned to the
    /// top-left corner so a user with more than one connected inbox can tell which
    /// account an item came from at a glance. AppIcon can't be reused here — it
    /// always renders in monochrome template mode, which would strip the brand colour.
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

    // MARK: - Reservation (calendar-forward)

    private var reservationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                AppIcon("calendar", size: 17)
                    .foregroundStyle(Color(red: 0.55, green: 0.4, blue: 0.85))
                    .frame(width: 40, height: 40)
                    .background(Color(red: 0.55, green: 0.4, blue: 0.85).opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(mission.eyebrow.uppercased())
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(ink.opacity(0.42))
                    Text(mission.title)
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
                        if mission.kind == .agent {
                            Circle().fill(Color(red: 0.18, green: 0.7, blue: 0.34)).frame(width: 7, height: 7)
                        }
                        Text(mission.eyebrow.uppercased())
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(0.8)
                            .foregroundStyle(mission.kind == .status ? Color(red: 0.16, green: 0.6, blue: 0.3) : ink.opacity(0.42))
                    }
                    Text(mission.title)
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
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        ZStack {
            shape.fill(.ultraThinMaterial)
            shape.fill(Color.white.opacity(0.55))
            shape.strokeBorder(Color.white.opacity(0.7), lineWidth: 0.6)
        }
        .shadow(color: Color.black.opacity(0.06), radius: 16, y: 8)
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
