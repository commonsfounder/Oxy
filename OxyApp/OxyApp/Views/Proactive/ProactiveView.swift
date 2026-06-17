import SwiftUI

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

    private let service = ChatService()
    private let native = NativeIntegrationManager.shared

    private var visibleBriefings: [Briefing] {
        briefings.filter(\.isWorthShowing)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlObsidian.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        hero

                        if isLoading && events.isEmpty && weather == nil && visibleBriefings.isEmpty {
                            ProgressView()
                                .tint(Color.nmlTitanium)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 48)
                        } else {
                            weatherCard
                            agendaCard
                            inboxCard
                            activityCard
                            remindersCard
                            briefingCard

                            if !hasAnyContent {
                                EmptyProactiveState()
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 36)
                }
                .refreshable { await loadDashboard() }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.nmlObsidian, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
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

    private var hasAnyContent: Bool {
        weather != nil || !events.isEmpty || steps != nil || !reminders.isEmpty || !visibleBriefings.isEmpty
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(greeting)
                    .font(.nmlDisplay(32, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Spacer()
                Button(action: { Task { await checkNow() } }) {
                    if isChecking {
                        ProgressView().scaleEffect(0.7).tint(Color.nmlMuted)
                    } else {
                        Text("Refresh")
                            .font(.nmlBody(12, weight: .medium))
                            .tracking(0.6)
                            .foregroundStyle(Color.nmlTitanium)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isChecking)
            }
            Text(dateLine)
                .font(.nmlBody(13, weight: .regular))
                .foregroundStyle(Color.nmlMuted)
        }
        .padding(.bottom, 4)
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Good evening"
        }
    }

    private var dateLine: String {
        let f = DateFormatter()
        f.dateFormat = "EEEE, d MMMM"
        return f.string(from: Date())
    }

    // MARK: - Cards

    @ViewBuilder private var weatherCard: some View {
        if let weather {
            TodayCard {
                cardLabel("Weather")
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: weather.symbolName)
                        .font(.system(size: 26, weight: .light))
                        .foregroundStyle(Color.nmlTitanium)
                        .frame(width: 34)
                    Text("\(Int(weather.temperatureC.rounded()))°")
                        .font(.nmlMono(40, weight: .ultraLight))
                        .foregroundStyle(Color.nmlInk)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(weather.conditionDescription)
                            .font(.nmlBody(13))
                            .foregroundStyle(Color.nmlInk)
                        Text(weatherDetail(weather))
                            .font(.nmlMono(11))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    Spacer()
                }
            }
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
                    .foregroundStyle(Color.nmlMuted)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(events) { event in
                        HStack(alignment: .top, spacing: 12) {
                            Text(event.isAllDay ? "all-day" : timeString(event.start))
                                .font(.nmlMono(12))
                                .foregroundStyle(Color.nmlTitanium)
                                .frame(width: 62, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.title)
                                    .font(.nmlBody(14))
                                    .foregroundStyle(Color.nmlInk)
                                if let location = event.location {
                                    Text(location)
                                        .font(.nmlBody(11))
                                        .foregroundStyle(Color.nmlMuted)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
        }
    }

    private var inboxEmails: [BriefingEmail] {
        // Emails ride along on the most recent briefing's metadata. Dedup by id in case
        // multiple briefings carry overlapping inbox snapshots.
        var seen = Set<String>()
        return visibleBriefings.flatMap(\.emails).filter { seen.insert($0.id).inserted }
    }

    @ViewBuilder private var inboxCard: some View {
        let emails = inboxEmails
        if !emails.isEmpty {
            TodayCard {
                cardLabel("Inbox")
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(emails) { email in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(email.from)
                                    .font(.nmlBody(13, weight: .medium))
                                    .foregroundStyle(Color.nmlInk)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                            }
                            Text(email.subject)
                                .font(.nmlBody(13))
                                .foregroundStyle(Color.nmlInk)
                                .lineLimit(1)
                            if let snippet = email.snippet, !snippet.isEmpty {
                                Text(snippet)
                                    .font(.nmlBody(12, weight: .light))
                                    .foregroundStyle(Color.nmlMuted)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var activityCard: some View {
        if let steps {
            TodayCard {
                cardLabel("Activity")
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(steps.formatted())
                        .font(.nmlMono(32, weight: .ultraLight))
                        .foregroundStyle(Color.nmlInk)
                    Text("steps")
                        .font(.nmlBody(13))
                        .foregroundStyle(Color.nmlMuted)
                }
                .padding(.bottom, 4)
                // Progress toward a flat 10k goal. ponytail: hardcoded goal, make it a setting if asked.
                ProgressView(value: min(Double(steps) / 10_000, 1))
                    .tint(Color.nmlTitanium)
                    .scaleEffect(x: 1, y: 0.6, anchor: .center)
            }
        }
    }

    @ViewBuilder private var remindersCard: some View {
        if !reminders.isEmpty {
            TodayCard {
                cardLabel("Reminders")
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(reminders) { reminder in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Circle()
                                .strokeBorder(Color.nmlMuted, lineWidth: 1)
                                .frame(width: 7, height: 7)
                                .offset(y: 2)
                            Text(reminder.title)
                                .font(.nmlBody(14))
                                .foregroundStyle(Color.nmlInk)
                            Spacer(minLength: 8)
                            if let due = reminder.due {
                                Text(reminder.overdue ? "overdue" : timeString(due))
                                    .font(.nmlMono(11))
                                    .foregroundStyle(reminder.overdue ? Color.nmlDanger : Color.nmlMuted)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var briefingCard: some View {
        if !visibleBriefings.isEmpty {
            TodayCard {
                cardLabel("Briefing")
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(visibleBriefings) { briefing in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(cleanBody(briefing))
                                .font(.nmlBody(14, weight: .light))
                                .foregroundStyle(Color.nmlMuted)
                                .lineSpacing(3)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Dismiss") { Task { await markRead(briefing) } }
                                .font(.nmlBody(11, weight: .medium))
                                .tracking(0.3)
                                .foregroundStyle(Color.nmlTitanium)
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func cardLabel(_ text: String) -> some View {
        Text(text).nmlEyebrow().padding(.bottom, 10)
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
}

// MARK: - Card container

private struct TodayCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.nmlSurface)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
        )
    }
}

private struct EmptyProactiveState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing needs you right now.")
                .font(.nmlDisplay(21, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Text("This stays quiet until there's something actually useful.")
                .font(.nmlBody(13, weight: .light))
                .foregroundStyle(Color.nmlMuted)
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
}
