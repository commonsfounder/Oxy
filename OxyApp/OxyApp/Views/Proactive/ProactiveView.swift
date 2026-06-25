import SwiftUI
import UIKit

struct ProactiveView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    @State private var briefings: [Briefing] = []
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var events: [TodayEvent] = []
    @State private var reminders: [TodayReminder] = []
    @State private var steps: Int?
    @State private var sleepMinutes: Int?
    @State private var isLoading = false
    @State private var isChecking = false
    @State private var errorMessage: String?
    @State private var weatherExpanded = false
    // Throttle for the auto proactive run below.
    @AppStorage("oxy_last_auto_proactive") private var lastAutoProactive: Double = 0
    @State private var contentAppeared = false
    // Signals the user has undone this session — flips the receipt to "Undone" immediately.
    @State private var undoneSignalIDs: Set<String> = []

    // Light by day, dark at night — tracks the clock, not a manual switch.
    private var lightMode: Bool { TodayFinish.isLight }
    private var p: TodayPalette { lightMode ? .light : .dark }

    private let service = ChatService()
    private let native = NativeIntegrationManager.shared

    private var visibleBriefings: [Briefing] {
        briefings
            .filter(\.isWorthShowing)
            .sorted { (Date.oxyParse($0.createdAt) ?? .distantPast) > (Date.oxyParse($1.createdAt) ?? .distantPast) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                // Canvas is the app-level aurora (see MainTabView) so it bleeds full-screen.
                Color.clear

                ScrollView {
                  nmlGlassContainer(spacing: 16) {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        hero

                        if isLoading && events.isEmpty && weather == nil && visibleBriefings.isEmpty {
                            ProgressView()
                                .tint(p.titanium)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 48)
                        } else {
                            signalsCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.04), value: contentAppeared)
                            // Agenda only earns space when there's something on it — an empty
                            // "Nothing scheduled" card is dead weight.
                            if !events.isEmpty {
                                agendaCard
                                    .opacity(contentAppeared ? 1 : 0)
                                    .offset(y: contentAppeared ? 0 : 14)
                                    .animation(.nmlSpring.delay(0.12), value: contentAppeared)
                            }
                            inboxCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.18), value: contentAppeared)
                            activityCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.24), value: contentAppeared)
                            remindersCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.28), value: contentAppeared)
                            briefingCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.32), value: contentAppeared)

                            if !hasAnyContent {
                                EmptyProactiveState(palette: p)
                                    .opacity(contentAppeared ? 1 : 0)
                                    .offset(y: contentAppeared ? 0 : 14)
                                    .animation(.nmlSpring.delay(0.06), value: contentAppeared)
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 36)
                  }
                }
                .refreshable { await loadDashboard() }
                .hidesTabBarOnScroll()
            }
            // No opaque cap: the aurora gradient runs full-bleed behind the status
            // bar (as in the reference), so content scrolling under it reads as
            // intentional rather than ghosting.
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            // A quiet warning buzz if something goes wrong while gathering the briefing.
            .sensoryFeedback(trigger: errorMessage != nil) { _, failed in
                failed ? .warning : nil
            }
        }
        .environment(\.colorScheme, lightMode ? .light : .dark)
        .task {
            await native.prepareTodayAccess()
            await loadDashboard()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await loadDashboard() }
        }
    }

    private var hasAnyContent: Bool {
        weather != nil || !events.isEmpty || steps != nil || sleepMinutes != nil || !reminders.isEmpty || !visibleBriefings.isEmpty
    }

    // MARK: - Hero (living weather)

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            HeroSky(condition: weather?.symbolName, light: lightMode)
                .frame(height: 264)
                .clipShape(RoundedRectangle(cornerRadius: 0))

            // Top row: day/night glyph + refresh, pinned top-trailing.
            VStack {
                HStack {
                    Spacer()
                    Image(systemName: lightMode ? "sun.max" : "moon.stars")
                        .font(.system(size: 14))
                        .foregroundStyle(p.muted)
                    Button(action: { Task { await checkNow() } }) {
                        if isChecking { ProgressView().scaleEffect(0.7).tint(p.muted) }
                        else { Image(systemName: "arrow.clockwise").font(.system(size: 15)).foregroundStyle(p.titanium) }
                    }
                    .buttonStyle(.nmlScale).disabled(isChecking).accessibilityLabel("Refresh")
                }
                Spacer()
            }
            .padding(.top, 8)

            // Greeting + temperature, bottom-leading. Whole hero is the tap target.
            Button {
                guard weather != nil else { return }
                HapticManager.shared.impact(.light)
                withAnimation(.nmlStandard) { weatherExpanded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(greeting)
                        .font(.nmlDisplay(31, weight: .light))
                        .foregroundStyle(p.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(dateLine)
                        .font(.nmlBody(12)).tracking(0.5).foregroundStyle(p.muted)
                        .padding(.top, 6)
                    if let weather {
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("\(Int(weather.temperatureC.rounded()))")
                                .font(.nmlDisplay(56, weight: .light))
                                .foregroundStyle(p.ink)
                                .contentTransition(.numericText())
                            Text("°").font(.nmlDisplay(24, weight: .light)).foregroundStyle(p.ink)
                            Text("  \(weather.conditionDescription) · feels \(Int(weather.apparentC.rounded()))°")
                                .font(.nmlBody(13)).foregroundStyle(p.muted)
                        }
                        .padding(.top, 14)
                    }
                    if weatherExpanded, let weather {
                        weatherDetailGrid(weather)
                            .padding(.top, 14)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.nmlScale(0.99))
        }
        .padding(.horizontal, 4)
    }

    private var greeting: String {
        let base: String
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: base = "Good morning"
        case 12..<17: base = "Good afternoon"
        default: base = "Good evening"
        }
        let name = userName
        return name.isEmpty ? base : "\(base), \(name)"
    }

    /// The user's first name, from Profile. Falls back to deriving a name from the
    /// account id (email local-part) so the greeting isn't anonymous before it's set.
    private var userName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data),
           !saved.userName.trimmingCharacters(in: .whitespaces).isEmpty {
            return saved.userName.trimmingCharacters(in: .whitespaces)
        }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? appState.userId
        let firstToken = local.split(whereSeparator: { ".-_0123456789".contains($0) }).first.map(String.init) ?? ""
        guard firstToken.count >= 2, firstToken.count <= 14 else { return "" }
        return firstToken.prefix(1).uppercased() + firstToken.dropFirst().lowercased()
    }

    private var dateLine: String {
        let f = DateFormatter()
        f.dateFormat = "EEEE, d MMMM"
        return f.string(from: Date())
    }

    // MARK: - Cards

    @ViewBuilder private func weatherDetailGrid(_ w: OxyWeatherService.OxyWeatherSnapshot) -> some View {
        let cells: [(String, String)] = [
            w.precipProbability.map { ("Rain", "\($0)%") },
            w.uvBand.map { ("UV", $0) },
            w.humidity.map { ("Humidity", "\($0)%") },
            w.windSpeed.map { ("Wind", "\(Int($0.rounded())) km/h") },
            (w.highC).map { ("High", "\(Int($0.rounded()))°") },
            (w.lowC).map { ("Low", "\(Int($0.rounded()))°") }
        ].compactMap { $0 }

        VStack(spacing: 0) {
            Rectangle().fill(p.hairline).frame(height: 0.5)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                ForEach(cells, id: \.0) { cell in
                    VStack(spacing: 4) {
                        Text(cell.0.uppercased())
                            .font(.nmlMono(9))
                            .tracking(0.8)
                            .foregroundStyle(p.muted)
                        Text(cell.1)
                            .font(.nmlMono(15, weight: .regular))
                            .foregroundStyle(p.ink)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 16)
        }
    }

    private func weatherDetail(_ w: OxyWeatherService.OxyWeatherSnapshot) -> String {
        var parts = ["Feels \(Int(w.apparentC.rounded()))°"]
        if let hi = w.highC, let lo = w.lowC {
            parts.append("H:\(Int(hi.rounded()))  L:\(Int(lo.rounded()))")
        }
        return parts.joined(separator: "   ")
    }

    private var agendaCard: some View {
        TodayCard {
            cardLabel("Agenda")
            if events.isEmpty {
                Text("Nothing scheduled today.")
                    .font(.nmlBody(13))
                    .foregroundStyle(p.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(events) { event in
                        Button {
                            HapticManager.shared.impact(.light)
                            openCalendar(at: event.start)
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Text(event.isAllDay ? "all-day" : timeString(event.start))
                                    .font(.nmlMono(12))
                                    .foregroundStyle(p.titanium)
                                    .frame(width: 62, alignment: .leading)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(event.title)
                                        .font(.nmlBody(14))
                                        .foregroundStyle(p.ink)
                                        .lineLimit(2)
                                    if let location = event.location {
                                        Text(location)
                                            .font(.nmlBody(11))
                                            .foregroundStyle(p.muted)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(p.muted)
                                    .offset(y: 2)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.nmlScale(0.98))
                    }
                }
            }
        }
    }

    private var inboxEmails: [BriefingEmail] {
        // Emails ride along on the most recent briefing's metadata. Dedup by id, and drop
        // marketing/bulk mail — the dashboard is for things that actually need you.
        // ponytail: the client has no importance signal (no unread/priority on BriefingEmail),
        // so "important" = freshest non-promotional, newest first, capped to stay glanceable.
        // Real ranking has to come from the proactive job that fills metadata.emails.
        var seen = Set<String>()
        return visibleBriefings
            .flatMap(\.emails)
            .filter { seen.insert($0.id).inserted && !$0.isLikelyPromotional }
            .sorted { (Date.oxyParse($0.date) ?? .distantPast) > (Date.oxyParse($1.date) ?? .distantPast) }
            .prefix(5)
            .map { $0 }
    }

    @ViewBuilder private var inboxCard: some View {
        let emails = inboxEmails
        if !emails.isEmpty {
            TodayCard {
                cardLabel("Inbox")
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(emails.enumerated()), id: \.element.id) { index, email in
                        Button {
                            HapticManager.shared.impact(.light)
                            openMail()
                        } label: {
                            HStack(alignment: .center, spacing: 8) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(email.cleanFrom)
                                        .font(.nmlBody(13, weight: .medium))
                                        .foregroundStyle(p.ink)
                                        .lineLimit(1)
                                    Text(email.cleanSubject)
                                        .font(.nmlBody(13, weight: .light))
                                        .foregroundStyle(p.muted)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(p.muted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .padding(.vertical, 12)
                        }
                        .buttonStyle(.nmlScale(0.98))
                        if index < emails.count - 1 {
                            // .overlay tints the divider line itself; .background only paints
                            // behind it and leaves the default ~1pt system separator showing.
                            Divider().overlay(p.hairline)
                        }
                    }
                }
            }
        }
    }

    /// Opens the system Mail app. ponytail: generic deep link, not a per-message jump
    /// (the briefing payload carries no message ids); good enough to get the user to their inbox.
    private func openMail() {
        if let url = URL(string: "message://"), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }

    /// Opens the Calendar app at the event's date. `calshow:` takes seconds since the
    /// 2001 reference date.
    private func openCalendar(at date: Date) {
        let seconds = Int(date.timeIntervalSinceReferenceDate)
        if let url = URL(string: "calshow:\(seconds)"), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }

    /// Opens the Health app to the activity summary.
    private func openHealth() {
        if let url = URL(string: "x-apple-health://"), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }

    /// Opens chat with the composer pre-filled — a *draft*, not an auto-sent command.
    /// A briefing is multi-topic, so we never guess an action; the user types what they
    /// actually want and sends it themselves.
    private func discuss(_ briefing: Briefing) {
        NotificationCenter.default.post(name: .oxyJumpToChat, object: nil)
        // Slight delay so the chat view is mounted to receive the draft.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            NotificationCenter.default.post(
                name: .oxyDraftMessage,
                object: nil,
                userInfo: ["text": "About this briefing: \(cleanBody(briefing))\n\n"]
            )
        }
    }

    @ViewBuilder private var activityCard: some View {
        if steps != nil || sleepMinutes != nil {
            TodayCard {
                Button {
                    HapticManager.shared.impact(.light)
                    openHealth()
                } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            cardLabel("Activity")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(p.muted)
                        }
                        if let steps {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(steps.formatted())
                                    .font(.nmlMono(32, weight: .ultraLight))
                                    .foregroundStyle(p.ink)
                                    .contentTransition(.numericText())
                                Text("steps")
                                    .font(.nmlBody(13))
                                    .foregroundStyle(p.muted)
                            }
                            .padding(.bottom, 4)
                            // Progress toward a flat 10k goal. ponytail: hardcoded goal, make it a setting if asked.
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(p.hairline)
                                    Capsule().fill(p.titanium)
                                        .frame(width: geo.size.width * min(Double(steps) / 10_000, 1))
                                }
                            }
                            .frame(height: 1.5)
                        }
                        // Last night's sleep rides along as the card's second vital. When steps
                        // are missing it stands alone (no goal bar to anchor to).
                        if let sleepMinutes {
                            sleepRow(sleepMinutes, hasSteps: steps != nil)
                        }
                    }
                    .contentShape(Rectangle())
                    // One transaction rolls the digits and slides the goal bar together.
                    .animation(.nmlRelax, value: steps)
                    .animation(.nmlStandard, value: sleepMinutes)
                }
                .buttonStyle(.nmlScale(0.98))
            }
        }
    }

    @ViewBuilder private func sleepRow(_ minutes: Int, hasSteps: Bool) -> some View {
        VStack(spacing: 0) {
            if hasSteps {
                Rectangle().fill(p.hairline).frame(height: 0.5).padding(.top, 14)
            }
            HStack(alignment: .firstTextBaseline) {
                Text("Last night")
                    .font(.nmlBody(13))
                    .foregroundStyle(p.muted)
                Spacer(minLength: 8)
                Text(sleepLabel(minutes))
                    .font(.nmlMono(15, weight: .regular))
                    .foregroundStyle(p.ink)
                    .contentTransition(.numericText())
            }
            .padding(.top, hasSteps ? 12 : 4)
        }
    }

    /// "7h 20m" / "6h" — whole-hour sleep reads cleaner without a trailing "0m".
    private func sleepLabel(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    @ViewBuilder private var remindersCard: some View {
        if !reminders.isEmpty {
            TodayCard {
                cardLabel("Reminders")
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(reminders) { reminder in
                        Button {
                            complete(reminder)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Circle()
                                    .strokeBorder(p.muted, lineWidth: 1)
                                    .frame(width: 16, height: 16)
                                    .offset(y: 1)
                                Text(reminder.title)
                                    .font(.nmlBody(14))
                                    .foregroundStyle(p.ink)
                                Spacer(minLength: 8)
                                if let due = reminder.due {
                                    Text(reminder.overdue ? "overdue" : timeString(due))
                                        .font(.nmlMono(11, weight: reminder.overdue ? .semibold : .regular))
                                        // Amber = attention-needed; red is reserved for destructive actions.
                                        .foregroundStyle(reminder.overdue ? Color.nmlAttention : p.muted)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.nmlScale(0.98))
                    }
                }
            }
        }
    }

    // MARK: - Signals (what matters today)

    /// The freshest briefing's ranked feed. Empty for legacy briefings (which fall back
    /// to the prose `briefingCard`).
    private var topSignals: [BriefingSignal] {
        visibleBriefings.first?.signals ?? []
    }

    @ViewBuilder private var signalsCard: some View {
        let signals = topSignals
        if !signals.isEmpty {
            TodayCard {
                cardLabel("What matters")
                if let lead = visibleBriefings.first?.lead, !lead.isEmpty {
                    Text(lead)
                        .font(.nmlBody(14, weight: .light))
                        .foregroundStyle(p.ink)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 4)
                }
                VStack(alignment: .leading, spacing: 0) {
                    let briefingId = visibleBriefings.first?.id ?? ""
                    ForEach(Array(signals.enumerated()), id: \.element.id) { index, signal in
                        signalRow(signal, briefingId: briefingId)
                        if index < signals.count - 1 {
                            Divider().overlay(p.hairline)
                        }
                    }
                }
            }
        }
    }

    private func signalRow(_ s: BriefingSignal, briefingId: String) -> some View {
        let undone = undoneSignalIDs.contains(s.id)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(s.title)
                    .font(.nmlBody(14, weight: .medium))
                    .foregroundStyle(p.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = s.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.nmlBody(13, weight: .light))
                        .foregroundStyle(p.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // A safe action already ran — quiet receipt, no tap needed.
                if s.isDone {
                    HStack(spacing: 5) {
                        Image(systemName: undone ? "arrow.uturn.backward" : "checkmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(undone ? p.muted : Color.nmlGlow)
                        Text(undone ? "Undone" : (s.receipt ?? "Done"))
                            .font(.nmlMono(11))
                            .foregroundStyle(p.muted)
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 8)
            // A sensitive action waits for one tap; sending the prompt into chat routes it
            // through the existing flow (which confirms before anything leaves).
            if s.isPending, let label = s.label, let prompt = s.prompt, !label.isEmpty {
                Button { act(prompt) } label: {
                    Text(label)
                        .font(.nmlBody(12, weight: .medium))
                        .foregroundStyle(p.titanium)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous).strokeBorder(p.hairline, lineWidth: 0.5))
                        // Visual chip stays compact; the tap target floors at 44pt.
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale(0.97))
                .fixedSize(horizontal: true, vertical: false)
            } else if s.canUndo && !undone {
                Button { undo(s, briefingId: briefingId) } label: {
                    Text("Undo")
                        .font(.nmlBody(12, weight: .medium))
                        .foregroundStyle(p.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous).strokeBorder(p.hairline, lineWidth: 0.5))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale(0.97))
                .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Reverse an auto-executed safe action. Optimistic — flip the row immediately, revert if
    /// the server can't undo it. The server runs the descriptor it stored, not anything we send.
    private func undo(_ s: BriefingSignal, briefingId: String) {
        guard !briefingId.isEmpty else { return }
        HapticManager.shared.impact(.light)
        undoneSignalIDs.insert(s.id)
        Task {
            do {
                _ = try await APIClient.shared.request(
                    path: "/briefings/\(briefingId)/signal-undo",
                    method: "POST",
                    body: ["userId": appState.userId, "title": s.title]
                )
            } catch {
                await MainActor.run { undoneSignalIDs.remove(s.id) }
            }
        }
    }

    /// Hands a pending signal to chat as a sent message — Millie carries it out, with the
    /// existing review sheet gating anything that leaves the device.
    private func act(_ prompt: String) {
        HapticManager.shared.impact(.light)
        NotificationCenter.default.post(name: .oxyJumpToChat, object: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            NotificationCenter.default.post(name: .oxyVoiceMessage, object: nil, userInfo: ["text": prompt])
        }
    }

    @ViewBuilder private var briefingCard: some View {
        // Only the freshest briefing — the server often has several near-identical runs
        // queued, and stacking them all just repeats the same heatwave/inbox copy.
        // Skipped when the briefing carries structured signals (the Signals card subsumes it).
        if topSignals.isEmpty, let briefing = visibleBriefings.first {
            TodayCard {
                cardLabel("Briefing")
                VStack(alignment: .leading, spacing: 8) {
                    Text(cleanBody(briefing))
                        .font(.nmlBody(14, weight: .light))
                        .foregroundStyle(p.ink)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 18) {
                        Button("Ask about this") {
                            HapticManager.shared.impact(.light)
                            discuss(briefing)
                        }
                        .foregroundStyle(p.titanium)
                        Button("Dismiss") { Task { await markRead(briefing) } }
                            .foregroundStyle(p.muted)
                    }
                    .font(.nmlBody(13, weight: .medium))
                    .tracking(0.3)
                    .buttonStyle(.nmlScale(0.98))
                }
            }
        }
    }

    private func cardLabel(_ text: String) -> some View {
        Text(text).nmlEyebrow().padding(.bottom, 14)
    }

    private func timeString(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    private func cleanBody(_ briefing: Briefing) -> String {
        briefing.body
            .replacingOccurrences(of: #"\([^)]*(unknown|\.unknown|Maps error|couldn't find)[^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Data

    private func loadDashboard() async {
        isLoading = true
        errorMessage = nil
        async let briefingsResult = loadBriefingsSafely()
        async let weatherResult = OxyWeatherService.shared.currentWeather()
        async let eventsResult = native.todaysEvents()
        async let remindersResult = native.todaysReminders()
        async let stepsResult = native.todaysSteps()
        async let sleepResult = native.todaysSleepMinutes()

        briefings = await briefingsResult
        weather = await weatherResult
        events = await eventsResult
        reminders = await remindersResult
        steps = await stepsResult
        sleepMinutes = await sleepResult
        isLoading = false
        contentAppeared = false
        withAnimation(.nmlSpring.delay(0.04)) { contentAppeared = true }
        await maybeAutoProactive()
    }

    /// Today's rich content (the briefing/inbox cards) is generated server-side by the
    /// proactive job — but it was only ever *loaded*, never *triggered*, so a user with no
    /// scheduled run saw an empty screen until they hit Refresh. Kick off a check on open
    /// when there's nothing to show, throttled so foregrounding doesn't hammer the backend.
    private func maybeAutoProactive() async {
        guard !isChecking else { return }
        let newestBriefingAge: TimeInterval = visibleBriefings
            .compactMap { Date.oxyParse($0.createdAt) }
            .map { Date().timeIntervalSince($0) }
            .min() ?? .infinity
        // Trigger when there's nothing to show OR when the freshest briefing is > 6 h old.
        let isStale = visibleBriefings.isEmpty || newestBriefingAge > 6 * 3600
        guard isStale else { return }
        let now = Date().timeIntervalSince1970
        guard now - lastAutoProactive > 2 * 60 * 60 else { return }
        lastAutoProactive = now
        await checkNow()
    }

    private func loadBriefingsSafely() async -> [Briefing] {
        do {
            return try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
            return briefings
        }
    }

    private func checkNow() async {
        guard !isChecking else { return }
        isChecking = true
        errorMessage = nil
        await native.syncNativeContext(userId: appState.userId)
        do {
            try await service.runProactiveCheck(userId: appState.userId)
            // A soft, satisfied tick when a hand-pulled refresh lands cleanly.
            if errorMessage == nil { HapticManager.shared.impact(.soft) }
        } catch {
            errorMessage = error.localizedDescription
        }
        await loadDashboard()
        isChecking = false
    }

    private func markRead(_ briefing: Briefing) async {
        await service.markBriefingRead(userId: appState.userId, briefingId: briefing.id)
        briefings.removeAll { $0.id == briefing.id }
    }

    private func complete(_ reminder: TodayReminder) {
        // A soft, rewarding check-off, then the row springs away.
        HapticManager.shared.impact(.soft)
        withAnimation(.nmlSpring) {
            reminders.removeAll { $0.id == reminder.id }
        }
        Task { await native.completeReminder(id: reminder.id) }
    }
}

/// The hero's atmospheric backdrop. Night = dark gradient with moon + stars;
/// day = soft light wash. ponytail: 5 broad looks keyed off the SF Symbol name —
/// expand only if a condition reads wrong in practice.
private struct HeroSky: View {
    let condition: String?   // OxyWeatherService symbolName, e.g. "cloud.rain"
    let light: Bool

    private var isRain: Bool { (condition ?? "").contains("rain") || (condition ?? "").contains("drizzle") }
    private var isCloud: Bool { (condition ?? "").contains("cloud") }

    var body: some View {
        ZStack {
            LinearGradient(colors: skyColors, startPoint: .top, endPoint: .bottom)
            if !light {
                // Moon + a few stars only at night.
                Circle()
                    .fill(RadialGradient(colors: [Color(white: 0.95), Color(white: 0.78)],
                                         center: .init(x: 0.38, y: 0.35), startRadius: 1, endRadius: 26))
                    .frame(width: 44, height: 44)
                    .blur(radius: 0.3)
                    .shadow(color: .white.opacity(0.18), radius: 18)
                    .offset(x: 110, y: -78)
                ForEach(0..<6, id: \.self) { i in
                    Circle().fill(Color.white.opacity(0.6))
                        .frame(width: 1.6, height: 1.6)
                        .offset(x: [-120, -40, 40, 120, -90, 70][i], y: [-90, -60, -84, -50, -30, -90][i])
                }
            }
            if isRain {
                // Faint diagonal rain hairlines, monochrome.
                Canvas { ctx, size in
                    for i in stride(from: 0, to: Int(size.width), by: 22) {
                        var path = Path()
                        path.move(to: CGPoint(x: Double(i), y: 0))
                        path.addLine(to: CGPoint(x: Double(i) - 10, y: size.height))
                        ctx.stroke(path, with: .color(.white.opacity(0.06)), lineWidth: 0.5)
                    }
                }
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    private var skyColors: [Color] {
        if light {
            return isCloud || isRain
                ? [Color(white: 0.86), Color(white: 0.94)]
                : [Color(red: 0.80, green: 0.88, blue: 0.97), Color(white: 0.97)]
        }
        return isRain
            ? [Color(red: 0.10, green: 0.11, blue: 0.13), Color.black]
            : [Color(red: 0.16, green: 0.19, blue: 0.26), Color.black]
    }
}

private struct EmptyProactiveState: View {
    let palette: TodayPalette
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing needs you right now.")
                .font(.nmlDisplay(21, weight: .regular))
                .foregroundStyle(palette.ink)
            Text("This stays quiet until there's something actually useful.")
                .font(.nmlBody(13, weight: .light))
                .foregroundStyle(palette.muted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
    }
}

private extension Briefing {
    var isWorthShowing: Bool {
        if source == "action_log" { return false }
        if let created = Date.oxyParse(createdAt), Date().timeIntervalSince(created) > 36 * 60 * 60 {
            return false
        }
        let lowerKind = kind.lowercased()
        if lowerKind.contains("failed") || lowerKind.contains("cancel") { return false }
        let lower = body.lowercased()
        let noisyFragments = [
            ".unknown", "maps error", "try a diff", "that hit a snag",
            "cancelled", "canceled", "was cancelled", "was canceled"
        ]
        if noisyFragments.contains(where: { lower.contains($0) }) { return false }
        return true
    }
}

#Preview {
    ProactiveView()
        .environment(AppState())
        .environment(TabBarVisibility())
}
