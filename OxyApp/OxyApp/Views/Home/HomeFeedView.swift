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
    @Environment(\.revealClose) private var revealClose
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var cards: [HomeCard] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var handled: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
    @State private var reading: (read: Int, total: Int)?

    private var visible: [HomeCard] { cards.filter { !handled.contains($0.id) } }

    var body: some View {
        SettingsPage(title: "Today", isRoot: true) {
            HStack(spacing: 8) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                    .font(.appBody(15)).foregroundStyle(Color.appMuted)
                Spacer()
                if loaded && !failed {
                    Text("\(visible.count)")
                        .font(.appMono(13, weight: .medium))
                        .foregroundStyle(Color.appAccent)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color.appAccent.opacity(0.12), in: Capsule())
                        .accessibilityLabel("\(visible.count) suggestions")
                }
            }
            .padding(.top, -8)

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
                quietState("Couldn't load today", detail: "Pull down to try again.", icon: "refresh")
            } else if let first = visible.first {
                featured(first)
                if visible.count > 1 {
                    VStack(spacing: 0) {
                        ForEach(Array(visible.dropFirst())) { card in
                            suggestion(card)
                        }
                    }
                    .padding(.top, 6)
                }
            } else {
                quietState("You're all caught up", detail: reading == nil ? "Nothing needs your attention." : "New suggestions will appear as photos are read.", icon: "check-circle")
            }
        }
        .task {
            await load()
            while !Task.isCancelled {
                refreshProgress()
                try? await Task.sleep(for: .seconds(8))
                if reading != nil { await load() }
            }
        }
        .refreshable { await load() }
    }

    private func featured(_ card: HomeCard) -> some View {
        let parts = split(card.rest)
        return VStack(alignment: .leading, spacing: 22) {
            HStack {
                sourceIcon(card, size: 30)
                Spacer()
                Text("Suggestion")
                    .font(.appBody(13, weight: .medium))
                    .foregroundStyle(Color.appMuted)
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(title(card, question: parts.0))
                    .font(.appRounded(27, weight: .semibold, relativeTo: .title1))
                    .tracking(-0.6)
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let context = parts.1 {
                    Text(context)
                        .font(.appBody(16))
                        .foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { primaryAction(card); laterAction(card) }
                VStack(alignment: .leading, spacing: 12) { primaryAction(card); laterAction(card) }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appReceivedBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 1).fill(Color.appAccent)
                .frame(width: 36, height: 3).padding(.top, 0)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
    }

    private func primaryAction(_ card: HomeCard) -> some View {
        Button { ask(card) } label: {
            HStack(spacing: 12) {
                Text("Continue").font(.appBody(16, weight: .semibold))
                AppIcon("arrow-up-right", size: 16)
            }
            .foregroundStyle(Color.appOnAction)
            .padding(.horizontal, 22).padding(.vertical, 15)
            .frame(minHeight: 50)
            .background(Color.appAction, in: Capsule())
        }
        .buttonStyle(.appScale(0.97))
        .accessibilityHint("Asks Adam to help with this suggestion")
    }

    private func laterAction(_ card: HomeCard) -> some View {
        Button { dismiss(card) } label: {
            Text("Not now").font(.appBody(15, weight: .medium))
                .foregroundStyle(Color.appMuted)
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
    private func sourceIcon(_ card: HomeCard, size: CGFloat) -> some View {
        if let brand = card.brand {
            AppIconView(candidates: [brand, "app-\(brand)"])
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            AppIcon("sparkles", size: size * 0.72)
                .foregroundStyle(Color.appAccent)
                .frame(width: size, height: size)
        }
    }

    private func quietState(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            AppIcon(icon, size: 32).foregroundStyle(Color.appAccent)
                .padding(20).background(Color.appAccent.opacity(0.10), in: Circle())
            Text(title).font(.appRounded(28, weight: .semibold)).foregroundStyle(Color.appInk)
            Text(detail).font(.appBody(16)).foregroundStyle(Color.appMuted)
        }
        .padding(.top, 46)
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
    }

    private func load() async {
        defer { loaded = true }
        guard let data = try? await APIClient.shared.request(path: "/agent/home-feed"),
              let response = try? JSONDecoder().decode(HomeFeedResponse.self, from: data) else { failed = true; return }
        failed = false
        cards = response.cards
    }
}
