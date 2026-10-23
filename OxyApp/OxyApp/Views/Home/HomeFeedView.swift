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
    @State private var failed = false
    @State private var handled: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "adam.home.handled") ?? [])
    @State private var reading: (read: Int, total: Int)?

    private var visible: [HomeCard] { cards.filter { !handled.contains($0.id) } }

    var body: some View {
        SettingsPage(title: "Today", isRoot: true) {
            if let reading {
                HStack(spacing: 10) {
                    ProgressView().scaleEffect(0.8)
                    Text("Reading your photos for things that need doing: \(reading.read) of \(reading.total)")
                        .font(.appBody(14))
                        .foregroundStyle(Color.appMuted)
                }
            }
            summaryLine
            if visible.isEmpty {
                Text(loaded ? (failed ? "Couldn't load this. Pull down to try again." : reading == nil ? "Nothing needs you right now." : "Nothing yet. This fills in as I read.") : " ")
                    .font(.appBody(17))
                    .foregroundStyle(Color.appMuted)
                    .padding(.top, 8)
            } else {
                if let first = visible.first { focalCard(first) }
                let rest = Array(visible.dropFirst())
                if !rest.isEmpty {
                    Text("Next up")
                        .font(.appRounded(18, weight: .semibold, relativeTo: .title3))
                        .foregroundStyle(Color.appInk)
                        .padding(.top, 12)
                    VStack(spacing: 0) {
                        ForEach(rest) { card in cardView(card) }
                    }
                }
            }
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
    }

    /// State first: the one line that says how the day looks.
    @ViewBuilder
    private var summaryLine: some View {
        if loaded, !failed, !visible.isEmpty {
            Text(visible.count == 1 ? "1 thing needs you" : "\(visible.count) things need you")
                .font(.appRounded(22, weight: .semibold, relativeTo: .title2))
                .foregroundStyle(Color.appInk)
        }
    }

    /// The most pressing ask, given the room and the two answers it needs.
    private func focalCard(_ card: HomeCard) -> some View {
        let color = tint(for: card)
        let (question, context) = split(card.rest)
        return VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center, spacing: 12) {
                tile(card, color: color, size: 52)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(card.verb + " " + question)
                    .font(.appRounded(26, weight: .bold, relativeTo: .title1))
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let context {
                    Text(context).font(.appBody(16)).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                Button { ask(card) } label: {
                    Text("Yes please")
                        .font(.appBody(17, weight: .semibold))
                        .foregroundStyle(Color.appOnAction)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(Color.appAction, in: Capsule())
                }
                .buttonStyle(.appScale(0.97))
                Button { dismiss(card) } label: {
                    Text("Not now")
                        .font(.appBody(17, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .padding(.horizontal, 22)
                        .frame(minHeight: 50)
                        .background(Color.appFillSubtle, in: Capsule())
                }
                .buttonStyle(.appScale(0.97))
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(LinearGradient(colors: [color.opacity(0.22), Color.settingsRaised], startPoint: .topLeading, endPoint: .bottom))
        )
        .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).strokeBorder(color.opacity(0.25), lineWidth: 0.8))
        .accessibilityElement(children: .contain)
    }

    private func tile(_ card: HomeCard, color: Color, size: CGFloat) -> some View {
        Group {
            if let brand = card.brand {
                AppIconView(candidates: [brand, "app-\(brand)"] + Self.logoURL(brand))
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(color)
                    .overlay(Text(String(card.verb.prefix(1)).uppercased()).font(.appRounded(size * 0.42, weight: .bold)).foregroundStyle(Color.black.opacity(0.75)))
            }
        }
        .frame(width: size, height: size)
    }

    private func ask(_ card: HomeCard) {
        HapticManager.shared.impact(.light)
        mark(card)
        NotificationCenter.default.post(name: AskAdam.sendNotification, object: card.prompt)
        revealClose?()
    }

    /// A small palette so each kind of ask has its own colour, steady from one launch to the next.
    private static let tints: [Color] = [
        Color(red: 0.93, green: 0.55, blue: 0.42), Color(red: 0.90, green: 0.72, blue: 0.30),
        Color(red: 0.36, green: 0.72, blue: 0.66), Color(red: 0.55, green: 0.55, blue: 0.90)
    ]

    /// A company with no bundled logo gets its site icon, looked up by name.
    private static func logoURL(_ brand: String) -> [String] {
        let name = brand.lowercased().filter { $0.isLetter || $0.isNumber }
        return name.isEmpty ? [] : ["https://www.google.com/s2/favicons?domain=\(name).com&sz=128"]
    }

    private func tint(for card: HomeCard) -> Color { Color.appTile(for: card.verb) }

    /// The question first, then whatever explains it, in a quieter line.
    private func split(_ rest: String) -> (String, String?) {
        guard let end = rest.firstIndex(where: { $0 == "?" }) else { return (rest, nil) }
        let head = String(rest[..<rest.index(after: end)])
        let tail = rest[rest.index(after: end)...].trimmingCharacters(in: .whitespaces)
        return (head, tail.isEmpty ? nil : tail)
    }

    private func cardView(_ card: HomeCard) -> some View {
        let color = tint(for: card)
        let (question, context) = split(card.rest)
        return HStack(alignment: .top, spacing: 14) {
            Group {
                if let brand = card.brand {
                    AppIconView(candidates: [brand, "app-\(brand)"] + Self.logoURL(brand))
                        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 13, style: .continuous).fill(color)
                        .overlay(Text(String(card.verb.prefix(1)).uppercased()).font(.appBody(19, weight: .bold)).foregroundStyle(Color.black.opacity(0.75)))
                }
            }
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 4) {
                (Text(card.verb + " ").font(.appBody(18, weight: .semibold)).foregroundColor(color)
                    + Text(question).font(.appBody(18)).foregroundColor(Color.appInk))
                    .fixedSize(horizontal: false, vertical: true)
                if let context {
                    Text(context).font(.appBody(14)).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
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
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.appHairline).frame(height: 0.5) }
        .contentShape(Rectangle())
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
