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
    @State private var isLoading = false
    @State private var isChecking = false
    @State private var errorMessage: String?
    @State private var weatherExpanded = false
    // Throttle for the auto proactive run below.
    @AppStorage("oxy_last_auto_proactive") private var lastAutoProactive: Double = 0
    @State private var contentAppeared = false

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
                            weatherCard
                                .opacity(contentAppeared ? 1 : 0)
                                .offset(y: contentAppeared ? 0 : 14)
                                .animation(.nmlSpring.delay(0.06), value: contentAppeared)
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
        weather != nil || !events.isEmpty || steps != nil || !reminders.isEmpty || !visibleBriefings.isEmpty
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(greeting)
                    .font(.nmlDisplay(40, weight: .light))
                    .foregroundStyle(p.ink)
                Spacer()
                // Passive day/night indicator (the finish follows the clock automatically).
                Image(systemName: lightMode ? "sun.max" : "moon.stars")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(p.muted)
                    .frame(width: 30, height: 30)
                    .accessibilityLabel(lightMode ? "Daytime" : "Night")
                Button(action: { Task { await checkNow() } }) {
                    if isChecking {
                        ProgressView().scaleEffect(0.7).tint(p.muted)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(p.titanium)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                }
                .buttonStyle(.nmlScale)
                .disabled(isChecking)
                .accessibilityLabel("Refresh")
            }
            Text(dateLine)
                .font(.nmlBody(12, weight: .regular))
                .tracking(0.5)
                .foregroundStyle(p.muted)
                .padding(.bottom, 16)

            Rectangle()
                .fill(p.hairline)
                .frame(height: 0.5)
        }
        .padding(.bottom, 4)
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

    @ViewBuilder private var weatherCard: some View {
        if weather == nil && !isLoading && !LocationManager.shared.isAuthorized {
            TodayCard {
                HStack {
                    cardLabel("Weather")
                    Spacer()
                    Image(systemName: "location.slash")
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(p.muted)
                }
                Button {
                    HapticManager.shared.impact(.light)
                    LocationManager.shared.requestPermission()
                } label: {
                    Text("Allow location to see weather.")
                        .font(.nmlBody(13, weight: .light))
                        .foregroundStyle(p.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.nmlScale(0.98))
            }
        } else if let weather {
            TodayCard {
                Button {
                    HapticManager.shared.impact(.light)
                    withAnimation(.nmlStandard) { weatherExpanded.toggle() }
                } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            cardLabel("Weather")
                            Spacer()
                            Image(systemName: weatherExpanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(p.muted)
                        }
                        HStack(alignment: .center, spacing: 14) {
                            Image(systemName: weather.symbolName)
                                .font(.system(size: 26, weight: .light))
                                .foregroundStyle(p.titanium)
                                .frame(width: 34)
                            Text("\(Int(weather.temperatureC.rounded()))°")
                                .font(.nmlMono(40, weight: .ultraLight))
                                .foregroundStyle(p.ink)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(weather.conditionDescription)
                                    .font(.nmlBody(13))
                                    .foregroundStyle(p.ink)
                                Text(weatherDetail(weather))
                                    .font(.nmlMono(11))
                                    .foregroundStyle(p.muted)
                            }
                            Spacer()
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale(0.98))

                if weatherExpanded {
                    weatherDetailGrid(weather)
                        .padding(.top, 16)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

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
        var seen = Set<String>()
        return visibleBriefings
            .flatMap(\.emails)
            .filter { seen.insert($0.id).inserted && !$0.isLikelyPromotional }
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
                            Divider().background(p.hairline)
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
        if let steps {
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
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(steps.formatted())
                                .font(.nmlMono(32, weight: .ultraLight))
                                .foregroundStyle(p.ink)
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
                    .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale(0.98))
            }
        }
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

    @ViewBuilder private var briefingCard: some View {
        // Only the freshest briefing — the server often has several near-identical runs
        // queued, and stacking them all just repeats the same heatwave/inbox copy.
        if let briefing = visibleBriefings.first {
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

        briefings = await briefingsResult
        weather = await weatherResult
        events = await eventsResult
        reminders = await remindersResult
        steps = await stepsResult
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
        HapticManager.shared.impact(.light)
        // Optimistic removal — drop it from the card immediately, then persist.
        withAnimation(.nmlFast) {
            reminders.removeAll { $0.id == reminder.id }
        }
        Task { await native.completeReminder(id: reminder.id) }
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
