import SwiftUI

struct HomeCard: Codable, Identifiable, Equatable {
    let id: String
    let verb: String
    let rest: String
    let prompt: String
    let brand: String?
}

private struct HomeFeedResponse: Codable { let cards: [HomeCard] }

/// Suggestions open the same conversation; this surface never executes an action itself.
struct HomeFeedView: View {
    var body: some View {
        SettingsPage(title: "Today", isRoot: true) {
            Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                .font(.appBody(15)).foregroundStyle(Color.appMuted)
            TodaySuggestionsContent()
        }
    }
}

/// The same real suggestions can live on the overview or their full page.
struct TodaySuggestionsContent: View {
    @Environment(\.dismiss) private var dismissPage
    var limit: Int? = nil
    var onMore: (() -> Void)? = nil
    @Environment(\.revealClose) private var revealClose
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var cards: [HomeCard] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var handled: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
    @State private var reading: (read: Int, total: Int)?

    private static let handledChanged = Notification.Name("Adam.todaySuggestionsChanged")

    private var visible: [HomeCard] { cards.filter { !handled.contains($0.id) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let reading {
                HStack(spacing: 10) {
                    ProgressView().tint(Color.appAccent)
                    Text("Reading photos · \(reading.read) of \(reading.total)")
                        .font(.appBody(14)).foregroundStyle(Color.appMuted)
                }
                .padding(.vertical, 8)
            }

            if !loaded {
                OxySkeletonCard(height: 210, cornerRadius: 18)
                OxySkeletonCard(height: 92, cornerRadius: 18)
            } else if failed {
                quietState("Couldn't load today", detail: "", icon: "refresh")
                Button("Try again") { Task { await load() } }
                    .font(.appBody(17, weight: .semibold))
                    .foregroundStyle(Color.appAccent)
                    .frame(minHeight: 44)
            } else if let first = visible.first {
                if limit == nil {
                    featured(first)
                } else {
                    suggestion(first)
                }
                if limit == nil && visible.count > 1 {
                    Text("More for today")
                        .font(.sectionTitle)
                        .foregroundStyle(Color.appInk)
                        .padding(.top, 14)
                    VStack(spacing: 0) {
                        ForEach(Array(visible.dropFirst())) { card in
                            suggestion(card)
                        }
                    }
                    .padding(.top, 6)
                }
                if let onMore, let limit, visible.count > limit {
                    Button(action: onMore) {
                        HStack {
                            Text("All suggestions")
                            Spacer()
                            Text("\(visible.count)").monospacedDigit()
                            AppIcon("chevron-right", size: 13)
                        }
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appAccent)
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                quietState("No suggestions today", detail: "", icon: "wheel-today")
            }
        }
        .task {
            await load()
            #if DEBUG
            if PreviewData.isIsolated, limit == nil,
               ProcessInfo.processInfo.environment["OXY_DEBUG_TODAY_DISMISS"] == "1", let first = visible.first {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                dismiss(first)
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                dismissPage()
            }
            #endif
            while !Task.isCancelled {
                refreshProgress()
                try? await Task.sleep(for: .seconds(8))
                if reading != nil { await load() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Self.handledChanged)) { _ in
            handled = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
        }
        .refreshable { await load() }
    }

    private func featured(_ card: HomeCard) -> some View {
        let parts = split(card.rest)
        return VStack(alignment: .leading, spacing: 0) {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
            layout {
                sourceIcon(card, size: 28)
                    .frame(width: 44, height: 44)
                    .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(title(card, question: parts.0))
                        .font(.title3.weight(.semibold))
                        .tracking(-0.5)
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if let context = parts.1 {
                        Text(context).font(.appBody(15)).foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(20)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { primaryAction(card); Spacer(minLength: 0); laterAction(card) }
                VStack(alignment: .leading, spacing: 8) { primaryAction(card); laterAction(card) }
            }
            .padding(.horizontal, 20).padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func primaryAction(_ card: HomeCard, onFeature: Bool = false) -> some View {
        Button { ask(card) } label: {
            HStack(spacing: 12) {
                Text("Ask Adam").font(.appBody(16, weight: .semibold))
                AppIcon("arrow-up-right", size: 16)
            }
            .foregroundStyle(onFeature ? Color(red: 0.04, green: 0.29, blue: 0.96) : Color.appOnAction)
            .padding(.horizontal, 22).padding(.vertical, 15)
            .frame(minHeight: 50)
            .background(onFeature ? Color.white : Color.appAction, in: Capsule())
        }
        .buttonStyle(.appScale(0.97))
        .accessibilityHint("Asks Adam to help with this suggestion")
    }

    private func laterAction(_ card: HomeCard, onFeature: Bool = false) -> some View {
        Button { dismiss(card) } label: {
            Text("Not now").font(.appBody(15, weight: .medium))
                .foregroundStyle(onFeature ? Color.white : Color.appMuted)
                .padding(.horizontal, 14).frame(minHeight: 50)
        }
        .buttonStyle(.appScale(0.97))
    }

    private func suggestion(_ card: HomeCard) -> some View {
        let parts = split(card.rest)
        return HStack(alignment: .top, spacing: 8) {
            Button { ask(card) } label: {
                HStack(alignment: .top, spacing: 16) {
                    sourceIcon(card, size: 28).frame(width: 36, height: 40)
                    VStack(alignment: .leading, spacing: 7) {
                        Text(title(card, question: parts.0))
                            .font(.appBody(18, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .fixedSize(horizontal: false, vertical: true)
                        if let detail = parts.1 {
                            Text(detail).font(.appBody(14)).foregroundStyle(Color.appMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if limit != nil {
                            HStack(spacing: 6) {
                                Text("Ask Adam")
                                AppIcon("arrow-up-right", size: 12)
                                    .accessibilityHidden(true)
                            }
                            .font(.appBody(14, weight: .semibold))
                            .foregroundStyle(Color.appAccent)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.99))
            .accessibilityHint("Asks Adam to help with this suggestion")
            Button { dismiss(card) } label: {
                AppIcon("xmark", size: 12).foregroundStyle(Color.appMuted)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss suggestion")
        }
        .padding(.vertical, 22)
        .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
    }

    @ViewBuilder
    private func sourceIcon(_ card: HomeCard, size: CGFloat, tint: Color = .appAccent) -> some View {
        if let brand = card.brand {
            AppIconView(candidates: [brand, "app-\(brand)"])
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            AppIcon("sparkles", size: size * 0.72)
                .foregroundStyle(tint)
                .frame(width: size, height: size)
        }
    }

    private func quietState(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            if limit == nil {
                AppIcon(icon, size: 32).foregroundStyle(Color.appAccent)
                    .padding(20).background(Color.appAccent.opacity(0.10), in: Circle())
            }
            Text(title).font(limit == nil ? .appRounded(28, weight: .semibold) : .body).foregroundStyle(Color.appInk)
            if !detail.isEmpty {
                Text(detail).font(.appBody(16)).foregroundStyle(Color.appMuted)
            }
        }
        .padding(.top, limit == nil ? 46 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func title(_ card: HomeCard, question: String) -> String {
        (card.verb + " " + question).trimmingCharacters(in: CharacterSet(charactersIn: "? "))
    }

    private func split(_ text: String) -> (String, String?) {
        guard let end = text.firstIndex(of: "?") else { return (text, nil) }
        let head = String(text[..<end])
        let tail = text[text.index(after: end)...].trimmingCharacters(in: .whitespaces)
        return (head, tail.isEmpty ? nil : tail)
    }

    private func ask(_ card: HomeCard) {
        HapticManager.shared.impact(.light)
        mark(card)
        NotificationCenter.default.post(name: AskAdam.sendNotification, object: card.prompt)
        revealClose?()
    }

    private func refreshProgress() {
        if let value = UserDefaults.standard.dictionary(forKey: PhotoLearner.progressKey),
           let read = value["read"] as? Int, let total = value["total"] as? Int, total > 0,
           Date().timeIntervalSince1970 - (value["at"] as? Double ?? 0) < 120 {
            reading = (read, total)
        } else {
            reading = nil
        }
    }

    private func dismiss(_ card: HomeCard) { withAnimation(.appStandard) { mark(card) } }

    private func mark(_ card: HomeCard) {
        handled.insert(card.id)
        var order = (UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? []).filter { $0 != card.id }
        order.append(card.id)
        UserDefaults.standard.set(Array(order.suffix(500)), forKey: "adam.home.handled")
        NotificationCenter.default.post(name: Self.handledChanged, object: nil)
    }

    private func load() async {
        handled = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
        defer { loaded = true }
        guard let data = try? await APIClient.shared.request(path: "/agent/home-feed"),
              let response = try? JSONDecoder().decode(HomeFeedResponse.self, from: data) else { failed = true; return }
        failed = false
        cards = response.cards
    }
}
