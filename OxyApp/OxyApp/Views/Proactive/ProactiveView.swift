import SwiftUI
import UIKit

struct ProactiveView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    @State private var briefings: [Briefing] = []
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var events: [TodayEvent] = []
    @State private var reminders: [TodayReminder] = []
    @State private var isLoading = false
    @State private var isChecking = false
    @State private var errorMessage: String?
    @State private var weatherExpanded = false
    // Throttle for the auto proactive run below.
    @AppStorage("oxy_last_auto_proactive") private var lastAutoProactive: Double = 0
    @State private var contentAppeared = false
    // removed: AI "what matters"/activity cards — 2026-06-25 redesign
    @State private var layout = TodayLayout()
    @State private var editingBoard = false

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
                            // removed: AI "what matters"/activity cards — 2026-06-25 redesign
                            ForEach(Array(layout.visibleOrdered().enumerated()), id: \.element) { idx, kind in
                                card(for: kind, index: idx)
                            }

                            addCardRow

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
        weather != nil || !events.isEmpty || !reminders.isEmpty || !visibleBriefings.isEmpty
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

    @ViewBuilder private func card(for kind: TodayCardKind, index: Int) -> some View {
        Group {
            switch kind {
            case .incoming:  IncomingCard(items: incomingItems, palette: p)
            case .inbox:     inboxCard
            case .agenda:    if !events.isEmpty { agendaCard }
            case .reminders: remindersCard
            }
        }
        .opacity(contentAppeared ? 1 : 0)
        .offset(y: contentAppeared ? 0 : 14)
        .animation(.nmlSpring.delay(0.04 + Double(index) * 0.05), value: contentAppeared)
    }

    /// Incoming items off the freshest briefing's metadata (same source as inbox).
    private var incomingItems: [BriefingIncoming] {
        visibleBriefings.first?.incoming ?? []
    }

    private var addCardRow: some View {
        Button { HapticManager.shared.impact(.light); editingBoard = true } label: {
            HStack(spacing: 9) {
                Image(systemName: "plus").font(.system(size: 15))
                Text("Add a card").font(.nmlBody(14))
            }
            .foregroundStyle(p.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous)
                .strokeBorder(p.hairline, style: StrokeStyle(lineWidth: 0.5, dash: [4, 4])))
        }
        .buttonStyle(.nmlScale(0.99))
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

    // removed: AI "what matters"/activity cards — 2026-06-25 redesign

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

    // removed: AI "what matters"/activity cards — 2026-06-25 redesign

    private func cardLabel(_ text: String) -> some View {
        Text(text).nmlEyebrow().padding(.bottom, 14)
    }

    private func timeString(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    // removed: AI "what matters"/activity cards — 2026-06-25 redesign

    // MARK: - Data

    private func loadDashboard() async {
        isLoading = true
        errorMessage = nil
        async let briefingsResult = loadBriefingsSafely()
        async let weatherResult = OxyWeatherService.shared.currentWeather()
        async let eventsResult = native.todaysEvents()
        async let remindersResult = native.todaysReminders()

        briefings = await briefingsResult
        weather = await weatherResult
        events = await eventsResult
        reminders = await remindersResult
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

    // removed: AI "what matters"/activity cards — 2026-06-25 redesign

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
