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
    @State private var restingHR: Int?
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
    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }
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
                Color.appBackground.ignoresSafeArea()
                // Light accent wash for atmosphere — accent is now allowed to live everywhere.
                AtmosphereSky(condition: weather?.symbolName)
                    .allowsHitTesting(false)

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage).padding(.bottom, 16)
                        }

                        hero

                        if isLoading && events.isEmpty && weather == nil && visibleBriefings.isEmpty {
                            loadingSkeleton.padding(.top, 16)
                        } else {
                            // Composable cards (user controls order/visibility).
                            ForEach(Array(layout.visibleOrdered().enumerated()), id: \.element) { idx, kind in
                                card(for: kind, index: idx)
                            }
                            eveningPlate
                            editBoardLink
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 16)
                    .padding(.bottom, 44)
                }
                .refreshable { await loadDashboard() }
                .hidesTabBarOnScroll()
                .sheet(isPresented: $editingBoard, onDismiss: { Task { await loadDashboard() } }) {
                    TodayBoardEditor(layout: layout, native: native)
                }

                // Paper grain over the whole screen for materiality — barely there.
                AppGrain().ignoresSafeArea().allowsHitTesting(false)
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
        .task {
            await native.prepareTodayAccess()
            await loadDashboard()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await loadDashboard() }
        }
    }

    // MARK: - Hero (clean greeting + weather spoken as a line)

    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Date kicker + a discreet refresh — the only control up here.
            HStack(alignment: .firstTextBaseline) {
                Text(dateLine)
                    .font(.appBody(11, weight: .regular)).tracking(2)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.appMuted)
                Spacer()
                Button(action: { Task { await checkNow() } }) {
                    if isChecking { ProgressView().scaleEffect(0.6).tint(Color.appMuted) }
                    else { Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .light)).foregroundStyle(Color.appMuted) }
                }
                .buttonStyle(.appScale).disabled(isChecking).accessibilityLabel("Refresh")
            }
            .padding(.top, 8)

            // Greeting.
            Text(greeting)
                .font(.appTitle(36, weight: .semibold))
                .foregroundStyle(Color.appInk)
                .lineLimit(3)
                .minimumScaleFactor(0.6)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 60)

            if let weather {
                Text(weatherLine(weather))
                    .font(.appBody(17))
                    .foregroundStyle(Color.appAccent)
                    .padding(.top, 16)
            }
        }
        .padding(.bottom, 10)
    }

    /// Weather spoken as an clean line, e.g. "Clear — thirty-two degrees."
    private func weatherLine(_ w: OxyWeatherService.OxyWeatherSnapshot) -> String {
        let t = Int(w.temperatureC.rounded())
        let spelled = Self.spellOutFormatter.string(from: NSNumber(value: t)) ?? "\(t)"
        return "\(w.conditionDescription) — \(spelled) degrees."
    }

    private static let spellOutFormatter: NumberFormatter = {
        let f = NumberFormatter(); f.numberStyle = .spellOut; return f
    }()

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

    /// Flat clean section — a Didot title + content on the bare canvas, no fill or
    /// border. Sections are separated by an `AppRule` drawn in `card(for:)`.
    @ViewBuilder private func boardSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 22)
    }

    private var agendaCard: some View {
        boardSection {
            cardLabel("Your day")
            if events.isEmpty {
                Text("Nothing scheduled — the day is yours.")
                    .font(.appBody(15, weight: .light))
                    .foregroundStyle(Color.appMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(events) { event in
                        Button {
                            HapticManager.shared.impact(.light)
                            openCalendar(at: event.start)
                        } label: {
                            HStack(alignment: .top, spacing: 16) {
                                Text(event.isAllDay ? "all-day" : timeString(event.start))
                                    .font(.appBody(13)).foregroundStyle(Color.appMuted)
                                    .frame(width: 52, alignment: .leading)
                                Text(eventLine(event))
                                    .font(.appBody(16, weight: .light))
                                    .foregroundStyle(Color.edInk)
                                    .lineLimit(2)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.appScale(0.99))
                    }
                }
            }
        }
    }

    /// "Lunch with Amara · Mayfair" — title with the place set muted inline.
    private func eventLine(_ event: TodayEvent) -> AttributedString {
        var a = AttributedString(event.title)
        a.foregroundColor = .edInk
        if let location = event.location, !location.isEmpty {
            var place = AttributedString("  ·  \(location)")
            place.foregroundColor = .edMuted
            a.append(place)
        }
        return a
    }

    @ViewBuilder private func card(for kind: TodayCardKind, index: Int) -> some View {
        VStack(spacing: 0) {
            // A centred-dot clean rule between sections — the only separator.
            if index > 0 {
                AppRule()
            }
            Group {
                switch kind {
                case .incoming:  IncomingCard(items: incomingItems)
                case .inbox:     inboxCard
                case .agenda:    agendaCard
                case .health:    healthCard
                case .reminders: remindersCard
                }
            }
        }
        .opacity(contentAppeared ? 1 : 0)
        .offset(y: contentAppeared ? 0 : 14)
        .animation(.appSpring.delay(0.04 + Double(index) * 0.05), value: contentAppeared)
    }

    /// Incoming items off the freshest briefing's metadata (same source as inbox).
    private var incomingItems: [BriefingIncoming] {
        visibleBriefings.first?.incoming ?? []
    }

    /// The "This evening" plate — the day's narrative voice from the briefing, or a quiet
    /// local line. A tonal grained block, the one place the canvas lifts.
    @ViewBuilder private var eveningPlate: some View {
        if let line = eveningLine {
            VStack(spacing: 0) {
                AppRule()
                EditorialPlate {
                    Text("THIS EVENING")
                        .font(.appBody(11)).tracking(1.8)
                        .foregroundStyle(Color.appMuted)
                    Text(line)
                        .font(.custom("Didot", size: 21)).italic()
                        .foregroundStyle(Color.edInk)
                        .lineSpacing(3)
                        .padding(.top, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 22)
            }
        }
    }

    /// Server narrative if present; otherwise a gentle local reflection on the evening.
    private var eveningLine: String? {
        if let n = visibleBriefings.first?.narrative { return n }
        let openEvening = !events.contains { !$0.isAllDay && Calendar.current.component(.hour, from: $0.start) >= 17 }
        return openEvening ? "Nothing after five — a rare quiet night ahead." : nil
    }

    /// A quiet, text-only way into the board editor — no boxed "add a card" affordance.
    private var editBoardLink: some View {
        VStack(spacing: 0) {
            AppRule()
            Button { HapticManager.shared.impact(.light); editingBoard = true } label: {
                Text("Edit board")
                    .font(.appBody(13, weight: .light))
                    .foregroundStyle(Color.appMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.99))
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
            boardSection {
                cardLabel("Inbox")
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(emails) { email in
                        Button {
                            HapticManager.shared.impact(.light)
                            openMail()
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(email.cleanFrom)
                                    .font(.appBody(14, weight: .regular))
                                    .foregroundStyle(Color.edInk)
                                    .lineLimit(1)
                                Text(email.cleanSubject)
                                    .font(.appBody(14, weight: .light))
                                    .foregroundStyle(Color.appMuted)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.appScale(0.99))
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

    private var remindersCard: some View {
        boardSection {
            cardLabel("Reminders")
            if reminders.isEmpty {
                Text("Nothing to carry today.")
                    .font(.appBody(15, weight: .light))
                    .foregroundStyle(Color.appMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(reminders) { reminder in
                        Button {
                            complete(reminder)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Circle()
                                    .strokeBorder(Color.appMuted, lineWidth: 1)
                                    .frame(width: 15, height: 15)
                                    .offset(y: 2)
                                Text(reminder.title)
                                    .font(.appBody(16, weight: .light))
                                    .foregroundStyle(Color.edInk)
                                Spacer(minLength: 8)
                                if let due = reminder.due {
                                    Text(reminder.overdue ? "overdue" : timeString(due))
                                        .font(.appBody(12))
                                        .foregroundStyle(reminder.overdue ? Color.appAttention : Color.appMuted)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.appScale(0.99))
                    }
                }
            }
        }
    }

    /// Wellbeing — the day's rest and movement spoken as a quiet reflection, not a row of
    /// gauges. Server prose when available, a gentle local sentence otherwise, and a soft
    /// connect prompt when there's no health data at all.
    private var healthCard: some View {
        boardSection {
            cardLabel("Wellbeing")
            if let prose = wellbeingProse {
                DropCapText(text: prose)
            } else {
                Button {
                    if native.healthPermissionRequested {
                        if let url = URL(string: "x-apple-health://") { UIApplication.shared.open(url) }
                    } else {
                        Task { await native.requestHealthAccess(); await loadDashboard() }
                    }
                } label: {
                    Text("Connect Health to weave your rest and movement into the day.")
                        .font(.appBody(15, weight: .light))
                        .foregroundStyle(Color.appMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Server wellbeing prose if present; otherwise a gentle local sentence composed from
    /// whatever health metrics exist. Nil when there's nothing to say.
    private var wellbeingProse: String? {
        if let w = visibleBriefings.first?.wellbeing { return w }
        var parts: [String] = []
        if let s = sleepMinutes, s > 0 {
            let h = s / 60, m = s % 60
            parts.append(m > 0 ? "you slept \(h) hours and \(m) minutes" : "you slept \(h) hours")
        }
        if let st = steps, st > 0 { parts.append("you're already at \(st.formatted()) steps") }
        if let hr = restingHR, hr > 0 { parts.append("your resting heart rate is steady at \(hr)") }
        guard !parts.isEmpty else { return nil }
        let sentence = parts.joined(separator: ", ") + "."
        return sentence.prefix(1).uppercased() + sentence.dropFirst()
    }

    /// Cold-start placeholder: the hero + two cards in skeleton form, shimmering.
    /// Mirrors the real layout so content settles in place instead of replacing a
    /// centered spinner — reads as a luxury app loading, not a web app waiting.
    private var loadingSkeleton: some View {
        // Palette-aware shimmer: light-grey block + white sweep by day, the reverse by night.
        let base: Color = lightMode ? .black.opacity(0.055) : .white.opacity(0.04)
        let highlight: Color = lightMode ? .white.opacity(0.45) : .white.opacity(0.08)
        return VStack(spacing: 16) {
            OxySkeletonCard(height: 264, cornerRadius: 26, base: base, highlight: highlight)
            OxySkeletonCard(height: 132, cornerRadius: NMLRadius.card, base: base, highlight: highlight)
            OxySkeletonCard(height: 96, cornerRadius: NMLRadius.card, base: base, highlight: highlight)
        }
        .accessibilityLabel("Loading your day")
    }

    private func cardLabel(_ text: String) -> some View {
        AppSectionTitle(text).padding(.bottom, 14)
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
        async let eventsResult = native.todaysEvents(excludedCalendarIDs: layout.excludedOptions(for: .agenda))
        async let remindersResult = native.todaysReminders(excludedListIDs: layout.excludedOptions(for: .reminders))
        async let stepsResult = native.todaysSteps()
        async let sleepResult = native.todaysSleepMinutes()
        async let restingHRResult = native.todaysRestingHeartRate()

        briefings = await briefingsResult
        weather = await weatherResult
        events = await eventsResult
        reminders = await remindersResult
        steps = await stepsResult
        sleepMinutes = await sleepResult
        restingHR = await restingHRResult
        isLoading = false
        contentAppeared = false
        withAnimation(.appSpring.delay(0.04)) { contentAppeared = true }
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
        } catch is CancellationError {
            return briefings
        } catch {
            // Cancellation is already handled above, so anything here is a real failure.
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
        } catch is CancellationError {
            // refresh superseded — not a user-facing error
        } catch {
            if !error.isCancellation { errorMessage = error.localizedDescription }
        }
        await loadDashboard()
        isChecking = false
    }

    // removed: AI "what matters"/activity cards — 2026-06-25 redesign

    private func complete(_ reminder: TodayReminder) {
        // A soft, rewarding check-off, then the row springs away.
        HapticManager.shared.impact(.soft)
        withAnimation(.appSpring) {
            reminders.removeAll { $0.id == reminder.id }
        }
        Task { await native.completeReminder(id: reminder.id) }
    }
}

/// Sheet for composing the Today board: reorder via drag, toggle visibility, and
/// for cards that support it, tap the gear to pick which sources/metrics feed it.
struct TodayBoardEditor: View {
    @Bindable var layout: TodayLayout
    let native: NativeIntegrationManager
    @Environment(\.dismiss) private var dismiss
    @State private var configuringKind: TodayCardKind?

    /// Cards with per-card config beyond plain show/hide.
    private func isConfigurable(_ kind: TodayCardKind) -> Bool {
        kind == .health || kind == .agenda || kind == .reminders
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(layout.order) { kind in
                    HStack {
                        Text(kind.title).font(.appBody(15)).foregroundStyle(Color.appInk)
                        Spacer()
                        if isConfigurable(kind) {
                            Button { configuringKind = kind } label: {
                                Image(systemName: "gearshape").foregroundStyle(Color.appMuted)
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 4)
                        }
                        AppToggle(isOn: Binding(
                            get: { !layout.isHidden(kind) },
                            set: { _ in layout.toggle(kind) }
                        ))
                    }
                    .listRowBackground(Color.appSurface)
                }
                .onMove { layout.move(from: $0, to: $1) }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden)
            .background(Color.appObsidian)
            .navigationTitle("Edit Today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(Color.appInk)
                }
            }
            .sheet(item: $configuringKind) { kind in
                TodayCardOptionsEditor(kind: kind, layout: layout, native: native)
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// Per-card option picker: Health metrics are fixed; Agenda/Reminders list the
/// user's actual calendars/lists since those vary per device.
private struct TodayCardOptionsEditor: View {
    let kind: TodayCardKind
    @Bindable var layout: TodayLayout
    let native: NativeIntegrationManager
    @Environment(\.dismiss) private var dismiss

    private var options: [(id: String, title: String)] {
        switch kind {
        case .health:    return HealthMetric.allCases.map { ($0.id, $0.title) }
        case .agenda:    return native.availableCalendars()
        case .reminders: return native.availableReminderLists()
        case .incoming, .inbox: return []
        }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(options, id: \.id) { option in
                    HStack {
                        Text(option.title).font(.appBody(15)).foregroundStyle(Color.appInk)
                        Spacer()
                        AppToggle(isOn: Binding(
                            get: { layout.isOptionEnabled(option.id, for: kind) },
                            set: { layout.setOption(option.id, for: kind, enabled: $0) }
                        ))
                    }
                    .listRowBackground(Color.appSurface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.appObsidian)
            .navigationTitle("\(kind.title) sources")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.foregroundStyle(Color.appInk)
                }
            }
        }
        .preferredColorScheme(.dark)
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
    // "cloud.sun" (partly cloudy) and clear both carry the sun — still a daytime sky.
    private var isSunny: Bool { (condition ?? "").contains("sun") || (condition ?? "").contains("clear") }

    var body: some View {
        ZStack {
            LinearGradient(colors: skyColors, startPoint: .top, endPoint: .bottom)
                .mask(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
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
    }

    private var skyColors: [Color] {
        if light {
            // Rain: cool overcast wash. Sunny/partly: real daytime blue. Overcast (cloud,
            // no sun): a soft blue-grey, not the flat dead grey it used to be.
            if isRain { return [Color(red: 0.80, green: 0.84, blue: 0.89), Color(white: 0.96)] }
            if isSunny { return [Color(red: 0.78, green: 0.87, blue: 0.97), Color(white: 0.975)] }
            if isCloud { return [Color(red: 0.83, green: 0.87, blue: 0.92), Color(white: 0.96)] }
            return [Color(red: 0.78, green: 0.87, blue: 0.97), Color(white: 0.975)]
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
                .font(.appTitle(21, weight: .regular))
                .foregroundStyle(palette.ink)
            Text("This stays quiet until there's something actually useful.")
                .font(.appBody(13, weight: .light))
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

private extension Error {
    // Task cancellation (view gone, refresh superseded) isn't a user-facing error.
    // CancellationError catches Swift concurrency; -999 catches URLSession's cancel.
    var isCancellation: Bool {
        self is CancellationError || (self as NSError).code == NSURLErrorCancelled
    }
}

#Preview {
    ProactiveView()
        .environment(AppState())
        .environment(TabBarVisibility())
}
