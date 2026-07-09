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
    // Throttle for the auto proactive run below.
    @AppStorage("oxy_last_auto_proactive") private var lastAutoProactive: Double = 0
    @State private var contentAppeared = false
    @State private var layout = TodayLayout()
    @State private var editingBoard = false

    private let service = ChatService()
    private let native = NativeIntegrationManager.shared

    private var visibleBriefings: [Briefing] {
        briefings
            .filter(\.isWorthShowing)
            .sorted { (Date.oxyParse($0.createdAt) ?? .distantPast) > (Date.oxyParse($1.createdAt) ?? .distantPast) }
    }

    private var agendaEmpty: Bool { events.isEmpty }
    private var remindersEmpty: Bool { reminders.isEmpty }
    private var eveningOpen: Bool { !events.contains { !$0.isAllDay && Calendar.current.component(.hour, from: $0.start) >= 17 } }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

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
                            let visible = layout.visibleOrdered()
                            let collapse = visible.contains(.agenda) && agendaEmpty && visible.contains(.reminders) && remindersEmpty
                            ForEach(Array(visible.enumerated()), id: \.element) { idx, kind in
                                if collapse && (kind == .agenda || kind == .reminders) {
                                    EmptyView()
                                } else {
                                    card(for: kind, index: idx)
                                }
                            }
                            if collapse {
                                clearDaySummary
                                    .padding(.top, 12)
                            }
                            eveningPlate
                        }
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 16)
                    .padding(.bottom, 44)
                }
                .scrollIndicators(.hidden)
                .refreshable { await loadDashboard() }
                .hidesTabBarOnScroll()
                .sheet(isPresented: $editingBoard, onDismiss: { Task { await loadDashboard() } }) {
                    TodayBoardEditor(layout: layout, native: native)
                }

                // Paper grain over the whole screen for materiality — barely there.
                AppGrain().ignoresSafeArea().allowsHitTesting(false)
            }
            // Scrolled content fades out under the status bar instead of colliding
            // with the clock (the nav bar is hidden, so nothing else protects it).
            .overlay(alignment: .top) {
                LinearGradient(colors: [Color.appBackground, Color.appBackground.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 54)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            // A quiet warning buzz if something goes wrong while gathering the briefing.
            .sensoryFeedback(trigger: errorMessage != nil) { _, failed in
                failed ? .warning : nil
            }
        }
        .task {
            guard !appState.isDemoSession else { return }
            await native.prepareTodayAccess()
            await loadDashboard()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !appState.isDemoSession else { return }
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
                Button { HapticManager.shared.impact(.light); editingBoard = true } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 13, weight: .regular)).foregroundStyle(Color.appMuted)
                }
                .buttonStyle(.appScale).accessibilityLabel("Customise Today")
                .padding(.trailing, 14)
                Button(action: { Task { await checkNow() } }) {
                    if isChecking { ProgressView().scaleEffect(0.6).tint(Color.appMuted) }
                    else { Image(systemName: "arrow.clockwise").font(.system(size: 13, weight: .light)).foregroundStyle(Color.appMuted) }
                }
                .buttonStyle(.appScale).disabled(isChecking).accessibilityLabel("Refresh")
            }
            .padding(.top, 8)

            // Greeting.
            Text(greeting)
                .font(.heroDisplay(26))
                .foregroundStyle(Color.appInk)
                .lineLimit(3)
                .minimumScaleFactor(0.6)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 20)

            if let weather {
                Text(weatherLine(weather))
                    .font(.appBody(17))
                    .foregroundStyle(Color.appMuted)
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

    /// A board section is a real card now — lifted surface, rounded, scannable.
    @ViewBuilder private func boardSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        TodayCard(padding: 18) { content() }
    }

    /// Actionable sections stay quiet; the action itself carries affordance.
    @ViewBuilder private func actionableBoardSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        TodayCard(padding: 18) { content() }
    }

    /// The single combined empty state when both the agenda and reminders have nothing —
    /// replaces what would otherwise be 2-3 separate near-empty cards.
    private var clearDaySummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppRule()
                .padding(.bottom, 4)
            Text(eveningOpen ? "A clear day, with space this evening." : "A clear day.")
                .font(.appBody(15))
                .foregroundStyle(Color.appMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 2)
    }

    private var agendaCard: some View {
        boardSection {
            cardLabel("Your day", icon: "calendar")
            if events.isEmpty {
                Text("Nothing scheduled — the day is yours.")
                    .font(.appBody(15))
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
                                    .font(.appBody(13, weight: .medium)).foregroundStyle(Color.appAccent)
                                    .frame(width: 56, alignment: .leading)
                                Text(eventLine(event))
                                    .font(.appBody(16))
                                    .foregroundStyle(Color.appInk)
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
        a.foregroundColor = .appInk
        if let location = event.location, !location.isEmpty {
            var place = AttributedString("  ·  \(location)")
            place.foregroundColor = .appMuted
            a.append(place)
        }
        return a
    }

    @ViewBuilder private func card(for kind: TodayCardKind, index: Int) -> some View {
        Group {
            switch kind {
            case .incoming:  IncomingCard(items: incomingItems)
            case .inbox:     inboxCard
            case .agenda:    agendaCard
            case .health:    healthCard
            case .reminders: remindersCard
            }
        }
        .padding(.top, 12)
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
            TodayCard(padding: 18) {
                cardLabel("Tonight", icon: "moon.stars")
                Text(line)
                    .font(.appBody(16))
                    .foregroundStyle(Color.appInk)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 12)
        }
    }

    /// Server narrative if present and fresh; otherwise a gentle local reflection on
    /// the evening. Freshness matters: a briefing written at 3am opens with "it's the
    /// middle of the night" and must not still be on the board at 18:51.
    private var eveningLine: String? {
        if let briefing = visibleBriefings.first,
           let narrative = briefing.narrative,
           let created = Date.oxyParse(briefing.createdAt),
           Calendar.current.isDateInToday(created),
           Date().timeIntervalSince(created) < 6 * 3600 {
            return narrative
        }
        return nil
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
                cardLabel("Inbox", icon: "envelope")
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(emails) { email in
                        Button {
                            HapticManager.shared.impact(.light)
                            openMail()
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(email.cleanFrom)
                                    .font(.appBody(14, weight: .regular))
                                    .foregroundStyle(Color.appInk)
                                    .lineLimit(1)
                                Text(email.cleanSubject)
                                    .font(.appBody(14))
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

    private var remindersCard: some View {
        boardSection {
            cardLabel("Reminders", icon: "checklist")
            if reminders.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.appSuccess)
                    Text("All clear — nothing due today.")
                        .font(.appBody(15))
                        .foregroundStyle(Color.appMuted)
                }
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
                                    .font(.appBody(16))
                                    .foregroundStyle(Color.appInk)
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

    /// Wellbeing — today's numbers as scannable figures, server prose beneath them
    /// when the briefing has something to say, and a real connect button when there's
    /// no health data yet.
    @ViewBuilder private var healthCard: some View {
        if hasHealthMetrics {
            boardSection {
                cardLabel("Wellbeing", icon: "heart.fill")
                HStack(spacing: 0) {
                    if let st = steps, st > 0 { healthMetric(st.formatted(), label: "steps") }
                    if let s = sleepMinutes, s > 0 { healthMetric(sleepText(s), label: "sleep") }
                    if let hr = restingHR, hr > 0 { healthMetric("\(hr)", label: "resting HR") }
                }
                if let prose = visibleBriefings.first?.wellbeing {
                    Text(prose)
                        .font(.appBody(14))
                        .foregroundStyle(Color.appMuted)
                        .padding(.top, 12)
                }
            }
        } else if let prose = visibleBriefings.first?.wellbeing {
            boardSection {
                cardLabel("Wellbeing", icon: "heart.fill")
                Text(prose)
                    .font(.appBody(15))
                    .foregroundStyle(Color.appInk)
            }
        } else {
            actionableBoardSection {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Image(systemName: "heart")
                                .font(.system(size: 13, weight: .regular))
                                .foregroundStyle(Color.appMuted)
                            Text("Wellbeing")
                                .font(.appBody(14, weight: .medium))
                                .foregroundStyle(Color.appInk)
                        }
                        Text("Sleep, steps, and heart rate when Health is connected.")
                            .font(.appBody(14))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Button {
                        if native.healthPermissionRequested {
                            if let url = URL(string: "x-apple-health://") { UIApplication.shared.open(url) }
                        } else {
                            Task { await native.requestHealthAccess(); await loadDashboard() }
                        }
                    } label: {
                        Text("Connect Health")
                            .font(.appBody(13, weight: .semibold))
                            .foregroundStyle(Color.appInk)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.appSurface2.opacity(0.8))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.appScale)
                }
            }
        }
    }

    private var hasHealthMetrics: Bool {
        (steps ?? 0) > 0 || (sleepMinutes ?? 0) > 0 || (restingHR ?? 0) > 0
    }

    private func sleepText(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        return m > 0 ? "\(h)h \(m)m" : "\(h)h"
    }

    private func healthMetric(_ value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.appDisplay(22))
                .foregroundStyle(Color.appInk)
                .monospacedDigit()
            Text(label)
                .font(.appBody(12))
                .foregroundStyle(Color.appMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Cold-start placeholder: the hero + two cards in skeleton form, shimmering.
    /// Mirrors the real layout so content settles in place instead of replacing a
    /// centered spinner — reads as a luxury app loading, not a web app waiting.
    private var loadingSkeleton: some View {
        let base: Color = .white.opacity(0.04)
        let highlight: Color = .white.opacity(0.08)
        return VStack(spacing: 16) {
            OxySkeletonCard(height: 264, cornerRadius: 26, base: base, highlight: highlight)
            OxySkeletonCard(height: 132, cornerRadius: AppRadius.md, base: base, highlight: highlight)
            OxySkeletonCard(height: 96, cornerRadius: AppRadius.md, base: base, highlight: highlight)
        }
        .accessibilityLabel("Loading your day")
    }

    private func cardLabel(_ text: String, icon: String? = nil) -> some View {
        HStack(spacing: 8) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.appAccent)
            }
            Text(text)
                .font(.appDisplay(16))
                .foregroundStyle(Color.appInk)
        }
        .padding(.bottom, 12)
    }

    private func timeString(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

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
                    .listRowBackground(Color.appBackground)
                }
                .onMove { layout.move(from: $0, to: $1) }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden)
            .background(Color.appBackground)
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
                    .listRowBackground(Color.appBackground)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.appBackground)
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
