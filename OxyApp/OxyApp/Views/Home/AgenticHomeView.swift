import SwiftUI

// MARK: - North star: agentic home
//
// Home is the product. Living mission cards for real jobs. Chat is a mode you
// open from the composer or a card CTA — not the whole identity of the app.
// Soft glass, soft wash, fat primary actions. UI generated for the job.

struct AgenticHomeView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme

    @State private var briefings: [Briefing] = []
    @State private var isLoading = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var chatLaunch: ChatLaunch?
    @State private var activeSession: AgentTaskSession?
    @State private var localMissions: [HomeMission] = []
    @State private var composerDraft = ""
    @FocusState private var composerFocused: Bool

    private let service = ChatService()

    /// Local ink for this surface — global `appInk` is dark-canvas only.
    private var ink: Color {
        colorScheme == .dark
            ? Color(red: 0.95, green: 0.95, blue: 0.94)
            : Color(red: 0.12, green: 0.12, blue: 0.14)
    }

    var body: some View {
        ZStack {
            AgenticWashBackground()
                .ignoresSafeArea()

            VStack(spacing: 0) {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        topChrome
                            .padding(.top, 8)

                        greetingBlock
                            .padding(.top, 4)

                        if let errorMessage {
                            ErrorBanner(message: errorMessage) {
                                Task { await load(forceCheck: false) }
                            }
                        }

                        if isLoading && missions.isEmpty {
                            ProgressView()
                                .tint(ink.opacity(0.45))
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if missions.isEmpty {
                            emptyMissions
                                .padding(.top, 8)
                        } else {
                            LazyVStack(spacing: 14) {
                                ForEach(missions) { mission in
                                    MissionCardView(mission: mission, ink: ink) {
                                        handleMissionCTA(mission)
                                    }
                                    .transition(.asymmetric(
                                        insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: .top)),
                                        removal: .opacity
                                    ))
                                }
                            }
                        }

                        suggestionRail
                            .padding(.top, 6)
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
        .toolbar(.hidden, for: .navigationBar)
        .task { await load(forceCheck: false) }
        .onChange(of: chatLaunch) { old, new in
            // Chat just closed: a job that ran in chat (not the plan generator) may have
            // produced a result. Quiet refresh so it lands here as a mission card instead
            // of staying trapped in the chat transcript.
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
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.appInk)
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

    // MARK: - Data → missions

    private var missions: [HomeMission] {
        localMissions + HomeMissionBuilder.build(from: briefings)
    }

    // MARK: - Chrome

    private var topChrome: some View {
        HStack(spacing: 10) {
            if let weather {
                HomeChip(ink: ink) {
                    HStack(spacing: 6) {
                        Image(systemName: weather.symbolName)
                            .font(.system(size: 13, weight: .semibold))
                        Text("\(Int(weather.temperatureC.rounded()))°")
                            .font(.system(size: 14, weight: .semibold))
                    }
                }
            }

            Spacer()

            Button {
                HapticManager.shared.impact(.light)
                Task { await load(forceCheck: true) }
            } label: {
                HomeChip(ink: ink) {
                    if isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(isRefreshing)

            Button {
                HapticManager.shared.impact(.light)
                NotificationCenter.default.post(name: .oxyJumpToMore, object: nil)
            } label: {
                HomeChip(ink: ink) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 18, weight: .medium))
                        .symbolRenderingMode(.hierarchical)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var greetingBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(dateLine)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ink.opacity(0.45))

            Text(greetingLine)
                .font(.appEditorial(34))
                .foregroundStyle(ink)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyMissions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing running right now")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(ink)
            Text("Ask for a ride, check mail, order food, or handle something real — the result will land here as a card.")
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.55))
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
                            .foregroundStyle(ink.opacity(0.75))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.ultraThinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.55), lineWidth: 0.5))
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
            .padding(.vertical, 2)
        }
    }

    private static let suggestions = [
        "What's on today?",
        "Book a ride",
        "Check my email",
        "Order food nearby",
        "Text someone I'm late"
    ]

    // MARK: - Composer

    private var composerBar: some View {
        HStack(spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                openChat(autoSend: nil, startFresh: true)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.7))
                    .frame(width: 36, height: 36)
                    .background(ink.opacity(0.06), in: Circle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                TextField("Type a message", text: $composerDraft)
                    .font(.system(size: 16))
                    .foregroundStyle(ink)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit { sendComposer() }

                if composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        HapticManager.shared.impact(.light)
                        openChat(autoSend: nil, startFresh: false)
                    } label: {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(ink.opacity(0.55))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: sendComposer) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
                            .frame(width: 30, height: 30)
                            .background(ink, in: Circle())
                    }
                    .buttonStyle(.appScale(0.94))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.1 : 0.65), lineWidth: 0.6))
            .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.35 : 0.08), radius: 18, y: 8)
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

    /// Generated-UI-for-the-job path: a client-side plan session when the intent
    /// matches a known job shape, otherwise fall back to free chat.
    private func handleIntent(_ text: String) {
        HapticManager.shared.impact(.medium)
        if let session = AgentPlanGenerator.generate(for: text) {
            activeSession = session
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
                // Soft-fail: still show last briefings
                errorMessage = error.localizedDescription
            }
        }

        do {
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }

        weather = await weatherTask
        isLoading = false
        isRefreshing = false
    }

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
        return "\(hello), \(firstName)"
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

// MARK: - Mission model

struct HomeMission: Identifiable, Equatable {
    enum Kind: Equatable {
        case action
        case status
        case mail
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
}

enum HomeMissionBuilder {
    static func build(from briefings: [Briefing]) -> [HomeMission] {
        var out: [HomeMission] = []
        var seen = Set<String>()

        for briefing in briefings {
            // Pending / done signals first — these are the “jobs”
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

            // Incoming deliveries / reservations
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
                    isPrimary: item.isDelivery
                ))
            }

            // Important mail (skip promo)
            for email in briefing.emails where !email.isLikelyPromotional {
                let id = "mail-\(briefing.id)-\(email.id)"
                guard seen.insert(id).inserted else { continue }
                out.append(HomeMission(
                    id: id,
                    kind: .mail,
                    eyebrow: "Inbox",
                    title: email.cleanSubject,
                    detail: email.cleanFrom + (email.cleanSnippet.map { " · \($0)" } ?? ""),
                    cta: "Open",
                    prompt: "Help me with this email from \(email.cleanFrom): \(email.cleanSubject)",
                    symbol: "envelope.fill",
                    isPrimary: false
                ))
            }

            // Agent / task briefings without structured signals
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

        // Cap so home stays scannable; primary jobs first
        let ranked = out.sorted { a, b in
            if a.isPrimary != b.isPrimary { return a.isPrimary && !b.isPrimary }
            return false
        }
        return Array(ranked.prefix(8))
    }
}

// MARK: - Mission card

struct MissionCardView: View {
    let mission: HomeMission
    var ink: Color
    var onCTA: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: mission.symbol)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.7))
                    .frame(width: 34, height: 34)
                    .background(ink.opacity(0.06), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text(mission.eyebrow.uppercased())
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(ink.opacity(0.42))

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
                    Button(action: onCTA) {
                        HStack(spacing: 8) {
                            Text(cta)
                                .font(.system(size: 14, weight: .semibold))
                            Image(systemName: "arrow.right.circle.fill")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .foregroundStyle(
                            mission.isPrimary
                                ? (colorScheme == .dark ? Color.black : Color.white)
                                : ink
                        )
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background {
                            if mission.isPrimary {
                                Capsule().fill(ink)
                            } else {
                                Capsule().fill(ink.opacity(0.08))
                            }
                        }
                    }
                    .buttonStyle(.appScale(0.96))
                }
            }
        }
        .padding(16)
        .background { MissionGlassPlate() }
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            if mission.cta != nil { onCTA() }
        }
    }
}

// MARK: - Shared chrome

private struct HomeChip<Content: View>: View {
    var ink: Color
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        content
            .foregroundStyle(ink.opacity(0.8))
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.55), lineWidth: 0.5))
    }
}

struct MissionGlassPlate: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        ZStack {
            if colorScheme == .dark {
                shape.fill(Color.white.opacity(0.06))
            } else {
                shape.fill(.ultraThinMaterial)
                shape.fill(Color.white.opacity(0.55))
            }
            shape.strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.1 : 0.7), lineWidth: 0.6)
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.25 : 0.06), radius: 16, y: 8)
    }
}

/// Soft living wash — light pastel like the north-star concept; dark twin stays calm.
struct AgenticWashBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12.0, paused: false)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            ZStack {
                (colorScheme == .dark
                    ? Color(red: 0.05, green: 0.05, blue: 0.06)
                    : Color(red: 0.96, green: 0.96, blue: 0.97))

                if #available(iOS 18.0, *) {
                    MeshGradient(
                        width: 3,
                        height: 3,
                        points: Self.points(t),
                        colors: colorScheme == .dark ? Self.darkColors : Self.lightColors
                    )
                    .opacity(colorScheme == .dark ? 0.55 : 0.9)
                } else {
                    LinearGradient(
                        colors: colorScheme == .dark
                            ? [Color(red: 0.08, green: 0.09, blue: 0.14), Color(red: 0.05, green: 0.05, blue: 0.06)]
                            : [Color(red: 0.93, green: 0.90, blue: 0.98), Color(red: 0.98, green: 0.94, blue: 0.88), Color(red: 0.90, green: 0.95, blue: 0.99)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                }
            }
        }
    }

    private static func points(_ t: Double) -> [SIMD2<Float>] {
        func w(_ base: Double, _ speed: Double, _ amp: Double) -> Float {
            Float(base + sin(t * speed) * amp)
        }
        return [
            [0, 0], [w(0.5, 0.25, 0.04), 0], [1, 0],
            [0, w(0.5, 0.22, 0.04)], [w(0.5, 0.18, 0.05), w(0.5, 0.28, 0.05)], [1, w(0.5, 0.24, 0.04)],
            [0, 1], [w(0.5, 0.27, 0.04), 1], [1, 1]
        ]
    }

    private static let lightColors: [Color] = {
        let white = Color(red: 0.98, green: 0.975, blue: 0.97)
        let lilac = Color(red: 0.90, green: 0.88, blue: 0.98)
        let peach = Color(red: 0.99, green: 0.92, blue: 0.86)
        let sky = Color(red: 0.88, green: 0.94, blue: 0.99)
        return [white, white, white, lilac, peach, sky, white, white, white]
    }()

    private static let darkColors: [Color] = {
        let base = Color(red: 0.05, green: 0.05, blue: 0.07)
        let lift = Color(red: 0.10, green: 0.11, blue: 0.16)
        let warm = Color(red: 0.12, green: 0.09, blue: 0.12)
        return [base, base, base, lift, warm, lift, base, base, base]
    }()
}

#Preview {
    AgenticHomeView()
        .environment(AppState())
}
