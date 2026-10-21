import SwiftUI

struct HomeCard: Codable, Identifiable, Equatable {
    let id: String
    let verb: String
    let rest: String
    let prompt: String
    let brand: String?
}

private struct HomeFeedResponse: Codable { let cards: [HomeCard] }

/// What needs doing: a few short sentences, each led by a verb, with a company's logo when one is named.
/// Tapping one hands it to Adam as a normal request.
struct HomeFeedView: View {
    @Environment(\.revealClose) private var revealClose
    @State private var cards: [HomeCard] = []
    @State private var loaded = false
    @State private var handled: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
    @State private var showsPlaces = false
    @State private var reading: (read: Int, total: Int)?

    private var visible: [HomeCard] { cards.filter { !handled.contains($0.id) } }

    var body: some View {
        SettingsPage(title: "Home", isRoot: true) {
            if let reading {
                HStack(spacing: 10) {
                    ProgressView().scaleEffect(0.8)
                    Text("Reading your photos for things that need doing: \(reading.read) of \(reading.total)")
                        .font(.appBody(14))
                        .foregroundStyle(Color.appMuted)
                }
            }
            if visible.isEmpty {
                Text(loaded ? (reading == nil ? "Nothing needs you right now." : "Nothing yet. This fills in as I read.") : " ")
                    .font(.appBody(17))
                    .foregroundStyle(Color.appMuted)
                    .padding(.top, 8)
            } else {
                VStack(spacing: 12) {
                    ForEach(visible) { card in
                        cardView(card)
                    }
                }
            }

            Button { showsPlaces = true } label: {
                HStack {
                    Text("Devices and places")
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                    Spacer()
                    AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                .settingsSurface()
            }
            .buttonStyle(.appScale(0.99))
        }
        .task {
            await load()
            // While photos are being read, keep the cards and the count fresh.
            while !Task.isCancelled {
                refreshProgress()
                try? await Task.sleep(for: .seconds(8))
                if reading != nil { await load() }
            }
        }
        .refreshable { await load() }
        .fullScreenCover(isPresented: $showsPlaces) {
            YourHomeView().swipeToDismiss().environment(\.revealClose, nil)
        }
    }

    private func cardView(_ card: HomeCard) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let brand = card.brand {
                AppIconView(candidates: [brand, "app-\(brand)"])
                    .frame(width: 34, height: 34)
                    .clipShape(Circle())
            }
            WrapLayout(spacing: 5, lineSpacing: 6) {
                Text(card.verb)
                    .font(.appBody(16, weight: .semibold))
                    .foregroundStyle(Color.appBackground)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.appInk, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                ForEach(Array(card.rest.split(separator: " ").enumerated()), id: \.offset) { _, word in
                    Text(String(word))
                        .font(.appBody(17))
                        .foregroundStyle(Color.appInk)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { dismiss(card) } label: {
                AppIcon("xmark", size: 11)
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Not now")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsSurface(radius: 22)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            HapticManager.shared.impact(.light)
            mark(card)
            NotificationCenter.default.post(name: AskAdam.sendNotification, object: card.prompt)
            revealClose?()
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Asks Adam to do this")
        .accessibilityAddTraits(.isButton)
    }

    private func refreshProgress() {
        if let value = UserDefaults.standard.dictionary(forKey: PhotoLearner.progressKey),
           let read = value["read"] as? Int, let total = value["total"] as? Int, total > 0 {
            reading = (read, total)
        } else {
            reading = nil
        }
    }

    private func dismiss(_ card: HomeCard) { withAnimation(.appStandard) { mark(card) } }

    private func mark(_ card: HomeCard) {
        handled.insert(card.id)
        UserDefaults.standard.set(Array(handled.suffix(300)), forKey: "adam.home.handled")
    }

    private func load() async {
        defer { loaded = true }
        guard let data = try? await APIClient.shared.request(path: "/agent/home-feed"),
              let response = try? JSONDecoder().decode(HomeFeedResponse.self, from: data) else { return }
        cards = response.cards
    }
}


/// Lays views out left to right and wraps them onto new lines, like words in a paragraph.
private struct WrapLayout: Layout {
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { y += lineHeight + lineSpacing; x = 0; lineHeight = 0 }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return CGSize(width: maxX, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // Group into lines first, so every word can sit centred on its line next to the taller verb pill.
        var lines: [[(index: Int, size: CGSize)]] = [[]]
        var x: CGFloat = 0
        for (index, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > bounds.width { lines.append([]); x = 0 }
            lines[lines.count - 1].append((index, size))
            x += size.width + spacing
        }
        var y = bounds.minY
        for line in lines {
            let height = line.map(\.size.height).max() ?? 0
            var cursor = bounds.minX
            for item in line {
                subviews[item.index].place(at: CGPoint(x: cursor, y: y + (height - item.size.height) / 2), proposal: ProposedViewSize(item.size))
                cursor += item.size.width + spacing
            }
            y += height + lineSpacing
        }
    }
}
