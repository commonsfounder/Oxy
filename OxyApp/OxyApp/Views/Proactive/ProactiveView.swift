import SwiftUI

struct ProactiveView: View {
    @Environment(AppState.self) private var appState
    @State private var briefings: [Briefing] = []
    @State private var isLoading = false
    @State private var isChecking = false
    @State private var errorMessage: String?
    @State private var weather: OxyWeatherService.OxyWeatherSnapshot?

    private let service = ChatService()
    private var visibleBriefings: [Briefing] {
        briefings.filter(\.isWorthShowing)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlBackground.ignoresSafeArea()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                                .padding(.bottom, 20)
                        }

                        ProactiveHeader(
                            isChecking: isChecking,
                            weather: weather,
                            onCheckNow: { Task { await checkNow() } }
                        )
                        .padding(.top, 8)
                        .padding(.bottom, 28)

                        if isLoading && briefings.isEmpty {
                            ProgressView()
                                .tint(Color.nmlTitanium)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if visibleBriefings.isEmpty {
                            EmptyProactiveState()
                                .padding(.top, 24)
                        } else {
                            ForEach(Array(visibleBriefings.enumerated()), id: \.element.id) { index, briefing in
                                if index != 0 { NamelessDivider() }
                                BriefingRow(briefing: briefing) {
                                    Task { await markRead(briefing) }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
                .refreshable {
                    await loadBriefings()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.nmlBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .task {
            await loadBriefings()
            weather = await OxyWeatherService.shared.currentWeather()
        }
    }

    private func loadBriefings() async {
        isLoading = true
        errorMessage = nil
        do {
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func checkNow() async {
        guard !isChecking else { return }
        isChecking = true
        errorMessage = nil
        await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        do {
            try await service.runProactiveCheck(userId: appState.userId)
            briefings = try await service.loadBriefings(userId: appState.userId)
        } catch {
            errorMessage = error.localizedDescription
        }
        isChecking = false
    }

    private func markRead(_ briefing: Briefing) async {
        await service.markBriefingRead(userId: appState.userId, briefingId: briefing.id)
        if let index = briefings.firstIndex(where: { $0.id == briefing.id }) {
            briefings.remove(at: index)
        }
    }
}

private struct ProactiveHeader: View {
    let isChecking: Bool
    let weather: OxyWeatherService.OxyWeatherSnapshot?
    let onCheckNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(greeting)
                        .font(.system(size: 13, weight: .semibold))
                        .tracking(1.6)
                        .textCase(.uppercase)
                        .foregroundStyle(Color.nmlTitanium)
                    Text("Today")
                        .font(.system(size: 38, weight: .regular, design: .serif))
                        .foregroundStyle(Color.nmlInk)
                }
                Spacer()
                Button(action: onCheckNow) {
                    if isChecking {
                        ProgressView()
                            .scaleEffect(0.7)
                            .tint(Color.nmlMuted)
                    } else {
                        NamelessGlassIcon(systemName: "arrow.clockwise", size: 16, diameter: 42)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isChecking)
            }

            if let weather {
                HStack(spacing: 8) {
                    Image(systemName: weather.symbolName)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Color.nmlTitanium)
                    Text(weather.shortLine)
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(Color.nmlMuted)
                }
            }
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Good night"
        }
    }
}

private struct BriefingRow: View {
    let briefing: Briefing
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(briefing.title ?? title)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Color.nmlInk)
                Spacer(minLength: 12)
                Text(timeLabel)
                    .font(.nmlMono(11))
                    .foregroundStyle(Color.nmlMuted)
            }

            Text(cleanBody)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Text(sourceLabel.uppercased())
                    .font(.nmlMono(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(Color.nmlMuted)
                Spacer()
                Button("DISMISS", action: onDismiss)
                    .font(.nmlMono(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(Color.nmlTitanium)
                    .buttonStyle(.plain)
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 24)
    }

    private var title: String {
        briefing.kind
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

    private var cleanBody: String {
        briefing.body
            .replacingOccurrences(of: #"\([^)]*(unknown|\.unknown|Maps error|couldn't find)[^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var sourceLabel: String {
        switch briefing.source {
        case "healthkit": return "HealthKit"
        case "location": return "Location"
        case "action_log": return "Action follow-up"
        case "schedule": return "Scheduled"
        default: return "Proactive"
        }
    }

    private var timeLabel: String {
        guard let createdAt = briefing.createdAt,
              let date = ISO8601DateFormatter().date(from: createdAt) else {
            return ""
        }
        return DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
    }
}

private struct EmptyProactiveState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing needs you right now.")
                .font(.system(size: 17, weight: .regular, design: .serif))
                .foregroundStyle(Color.nmlInk)
            Text("Nameless will only interrupt when there's something actually useful.")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(Color.nmlMuted)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
    }
}

private extension Briefing {
    var isWorthShowing: Bool {
        if source == "action_log" { return false }
        // "Today" feed — drop stale cards (older than 36h) so read briefings from past days
        // don't linger.
        if let created = Date.oxyParse(createdAt), Date().timeIntervalSince(created) > 36 * 60 * 60 {
            return false
        }
        let lowerKind = kind.lowercased()
        if lowerKind.contains("failed") || lowerKind.contains("cancel") { return false }
        let lower = body.lowercased()
        let noisyFragments = [
            ".unknown",
            "maps error",
            "try a diff",
            "that hit a snag",
            "cancelled",
            "canceled",
            "was cancelled",
            "was canceled"
        ]
        if noisyFragments.contains(where: { lower.contains($0) }) {
            return false
        }
        return true
    }
}

#Preview {
    ProactiveView()
        .environment(AppState())
}
