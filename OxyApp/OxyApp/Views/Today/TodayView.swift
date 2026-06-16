import SwiftUI

// The home surface, in the generative aesthetic: a deep obsidian canvas with soft
// organic colour glows that slowly breathe, frosted glass cards that grow into place,
// and luminous SF Pro on dark. Every item is a real tappable link out to the native
// app. Swipe right for Chat; the profile icon folds away account / connectors /
// memory / settings.

// MARK: - Palette

enum Bloom {
    static let base  = Color(red: 0x0A/255, green: 0x0A/255, blue: 0x0F/255)
    static let base2 = Color(red: 0x14/255, green: 0x14/255, blue: 0x1C/255)
    static let purple  = Color(red: 0x6B/255, green: 0x21/255, blue: 0xA8/255)
    static let magenta = Color(red: 0xC0/255, green: 0x26/255, blue: 0xD3/255)
    static let cyan    = Color(red: 0x06/255, green: 0xB6/255, blue: 0xD4/255)
    static let ink      = Color.white
    static let inkSoft  = Color.white.opacity(0.62)
    static let inkFaint = Color.white.opacity(0.38)
}

// MARK: - Breathing background

// Three blurred colour orbs drift in scale + opacity, forever, each on its own clock so
// the field never pulses in lockstep — the "alive" signal. `intensity` (0…1) lets a
// thinking state push the glow brighter later.
struct BloomBackground: View {
    var intensity: Double = 0.5
    @State private var a = false
    @State private var b = false
    @State private var c = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                LinearGradient(colors: [Bloom.base2, Bloom.base], startPoint: .top, endPoint: .bottom)
                orb(Bloom.purple,  x: w * 0.16, y: h * 0.16, d: 380, on: a)
                orb(Bloom.magenta, x: w * 0.92, y: h * 0.30, d: 320, on: b)
                orb(Bloom.cyan,    x: w * 0.42, y: h * 0.94, d: 360, on: c)
            }
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) { a = true }
            withAnimation(.easeInOut(duration: 4.3).repeatForever(autoreverses: true)) { b = true }
            withAnimation(.easeInOut(duration: 3.9).repeatForever(autoreverses: true)) { c = true }
        }
    }

    private func orb(_ color: Color, x: CGFloat, y: CGFloat, d: CGFloat, on: Bool) -> some View {
        Circle()
            .fill(color)
            .frame(width: d, height: d)
            .scaleEffect(on ? 1.12 : 0.9)
            .opacity((0.20 + intensity * 0.14) * (on ? 1.0 : 0.65))
            .blur(radius: 100)
            .position(x: x, y: y)
    }
}

// MARK: - Glass

extension View {
    // Frosted glass on dark — ultra-thin material, a faint white wash so it lifts off
    // black, and a top-lit rim. The visible glassmorphism.
    func bloomGlass(_ radius: CGFloat = 24) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(.ultraThinMaterial))
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.white.opacity(0.05)))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(colors: [Color.white.opacity(0.35), Color.white.opacity(0.05)],
                                       startPoint: .top, endPoint: .bottom),
                        lineWidth: 0.75)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

// MARK: - Feed model (mirrors GET /today/:userId)

struct TodayFeed: Decodable {
    var events: [TodayEvent] = []
    var emails: [TodayEmail] = []
    var news: [TodayNews] = []
    var route: TodayRoute?
    var connectors: [String] = []
}

struct TodayEvent: Decodable { let id: String?; let title: String; let start: String?; let end: String?; let url: String? }
struct TodayEmail: Decodable { let id: String?; let from: String; let subject: String; let snippet: String; let date: String?; let url: String? }
struct TodayNews: Decodable { let title: String; let url: String; let source: String }
struct TodayRoute: Decodable { let destination: String; let summary: String; let duration: String; let distance: String; let mapsUrl: String }

// MARK: - View

struct TodayView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL

    @State private var feed = TodayFeed()
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?
    @State private var isLoading = false
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var appeared = false
    @State private var showProfile = false
    @State private var stage = AgentStage()

    private let weatherService = OxyWeatherService()

    var body: some View {
        ZStack {
            BloomBackground(intensity: isLoading ? 0.85 : 0.5)

            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    header

                    // The agent orb: pulsing when thinking, expands while mic is live.
                    // Tapping focuses the input bar (keyboard) as a secondary affordance.
                    AgentOrb(active: stage.isThinking, diameter: 92) {
                        HapticManager.shared.impact(.medium)
                    }
                    .frame(maxWidth: .infinity)
                    .opacity(appeared ? 1 : 0)
                    .animation(.spring(response: 0.6, dampingFraction: 0.8).delay(0.05), value: appeared)

                    if let route = feed.route { card(0) { routeSection(route) } }
                    if !feed.events.isEmpty { card(1) { calendarSection } }
                    if !feed.emails.isEmpty { card(2) { mailSection } }
                    if !feed.news.isEmpty { card(3) { newsSection } }

                    if loaded && isEmptyFeed { statusCard }
                }
                .padding(.horizontal, 22)
                .padding(.top, 14)
                .padding(.bottom, 110)  // clear floating input bar
            }
            .refreshable { await load() }

            // The agent's summoned card floats over everything.
            AgentCardOverlay(stage: stage)

            // Floating glass input bar — voice + text, drives the orb + generative cards.
            VStack {
                Spacer()
                TodayInputBar(stage: stage, userId: appState.userId)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 18)
            }
            .ignoresSafeArea(.keyboard)
        }
        .environment(\.colorScheme, .dark)
        .fullScreenCover(isPresented: $showProfile) {
            MoreView().swipeToDismiss()
        }
        .task { if !loaded { await load() } }
    }

    private var isEmptyFeed: Bool {
        feed.events.isEmpty && feed.emails.isEmpty && feed.news.isEmpty && feed.route == nil
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 7) {
                Text(greeting.uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2.4)
                    .foregroundStyle(Bloom.inkFaint)
                Text(dateLine)
                    .font(.system(size: 38, weight: .bold))
                    .tracking(-0.8)
                    .foregroundStyle(Bloom.ink)
                if let weather {
                    Text(weather.shortLine)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Bloom.inkSoft)
                        .padding(.top, 1)
                }
            }
            Spacer()
            profileButton
        }
        .padding(.top, 4)
    }

    private var profileButton: some View {
        Button {
            HapticManager.shared.impact(.light)
            showProfile = true
        } label: {
            Text(monogram)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Bloom.ink)
                .frame(width: 44, height: 44)
                .bloomGlass(22)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Sections

    private func routeSection(_ route: TodayRoute) -> some View {
        section("Commute", icon: "car.fill") {
            row(url: route.mapsUrl) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(route.duration) to \(route.destination)")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Bloom.ink)
                    Text([route.distance, route.summary.isEmpty ? nil : "via \(route.summary)"]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(Bloom.inkSoft)
                }
            }
        }
    }

    private var calendarSection: some View {
        section("Calendar", icon: "calendar") {
            ForEach(Array(feed.events.enumerated()), id: \.offset) { i, event in
                if i != 0 { divider }
                row(url: event.url) {
                    HStack(alignment: .firstTextBaseline, spacing: 14) {
                        Text(eventTime(event.start))
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Bloom.cyan)
                            .frame(width: 58, alignment: .leading)
                        Text(event.title)
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(Bloom.ink)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private var mailSection: some View {
        section("Inbox", icon: "envelope.fill") {
            ForEach(Array(feed.emails.enumerated()), id: \.offset) { i, mail in
                if i != 0 { divider }
                row(url: mail.url) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(mail.from)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Bloom.inkSoft)
                        Text(mail.subject)
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(Bloom.ink)
                            .lineLimit(1)
                        if !mail.snippet.isEmpty {
                            Text(mail.snippet)
                                .font(.system(size: 13, weight: .regular))
                                .foregroundStyle(Bloom.inkFaint)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
    }

    private var newsSection: some View {
        section("News", icon: "newspaper.fill") {
            ForEach(Array(feed.news.enumerated()), id: \.offset) { i, item in
                if i != 0 { divider }
                row(url: item.url) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title)
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(Bloom.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(item.source)
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(Bloom.inkFaint)
                    }
                }
            }
        }
    }

    // Connected-but-empty vs. not-connected vs. load failure — never blame the user
    // for being disconnected when they're not.
    private var statusCard: some View {
        let hasAccount = feed.connectors.contains("google") || feed.connectors.contains("microsoft")
        let title: String
        let detail: String
        if loadFailed {
            title = "Couldn't reach the server"
            detail = "Pull to refresh."
        } else if hasAccount {
            title = "You're all caught up"
            detail = "Nothing on the agenda right now."
        } else {
            title = "Connect an account"
            detail = "Link Google or Microsoft in your profile to see calendar, mail and your commute."
        }
        return card(0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Bloom.ink)
                Text(detail)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(Bloom.inkSoft)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
        }
    }

    // MARK: - Building blocks

    // A glass card that grows into place: scales up from 0.96 + fades in, staggered by
    // its index so the surface assembles itself rather than hard-loading.
    private func card<Content: View>(_ index: Int, @ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .bloomGlass(24)
            .opacity(appeared ? 1 : 0)
            .scaleEffect(appeared ? 1 : 0.96, anchor: .top)
            .animation(.spring(response: 0.5, dampingFraction: 0.7).delay(Double(index) * 0.08), value: appeared)
    }

    private func section<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Bloom.inkFaint)
                Text(title.uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(Bloom.inkFaint)
            }
            VStack(spacing: 0) { content() }
        }
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
    }

    private func row<Content: View>(url: String?, @ViewBuilder content: () -> Content) -> some View {
        Button {
            guard let url, let u = URL(string: url) else { return }
            HapticManager.shared.impact(.light)
            openURL(u)
        } label: {
            HStack(spacing: 12) {
                content()
                Spacer(minLength: 0)
                if url != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Bloom.inkFaint)
                }
            }
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(url == nil)
    }

    // MARK: - Data

    private func load() async {
        isLoading = true
        defer {
            isLoading = false
            loaded = true
            withAnimation { appeared = true }
        }
        async let weatherTask = weatherService.currentWeather()
        async let feedTask: TodayFeed? = fetchFeed()
        weather = await weatherTask
        if let f = await feedTask {
            feed = f
            loadFailed = false
        } else {
            loadFailed = true
        }
    }

    private func fetchFeed() async -> TodayFeed? {
        guard !appState.userId.isEmpty else { return nil }
        do {
            let data = try await APIClient.shared.request(path: "/today/\(appState.userId)")
            return try JSONDecoder().decode(TodayFeed.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: - Formatting

    private var monogram: String {
        String(appState.userId.trimmingCharacters(in: .whitespaces).first ?? "—").uppercased()
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Tonight"
        }
    }

    private var dateLine: String {
        let f = DateFormatter()
        f.dateFormat = "EEEE, d MMMM"
        return f.string(from: Date())
    }

    private func eventTime(_ iso: String?) -> String {
        guard let iso else { return "" }
        if !iso.contains("T") { return "All day" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let out = DateFormatter()
        out.dateFormat = "HH:mm"
        return out.string(from: date)
    }
}
