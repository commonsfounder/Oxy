import SwiftUI

/// Flights or hotels a search found, side by side. Each card says whether its price is for the dates asked.
struct TravelOptionsCard: View {
    enum Kind { case flights, hotels }

    let action: ActionResult
    let kind: Kind

    private var options: [TravelOption] { action.travelOptions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(kind == .flights ? "Flights" : "Hotels")
                    .font(.sectionLabel)
                    .foregroundStyle(Color.appMuted)
                Spacer(minLength: 8)
                Text("Seen in search, not held")
                    .font(.fineprint)
                    .foregroundStyle(Color.appMuted)
            }
            .padding(.horizontal, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(options) { option in
                        card(option)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 2)
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollClipDisabled()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(kind == .flights ? "Flights found" : "Hotels found")
    }

    private func card(_ option: TravelOption) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(option.title)
                .font(.rowTitle)
                .foregroundStyle(Color.appInk)
                .lineLimit(1)

            if let facts = facts(for: option), !facts.isEmpty {
                Text(facts)
                    .font(.rowSecondary)
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }

            if let price = priceText(option) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(price)
                        .font(.sectionTitle)
                        .foregroundStyle(Color.appInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let basis = basisText(option) {
                        Text(basis)
                            .font(.rowSecondary)
                            .foregroundStyle(Color.appMuted)
                    }
                }
            }

            dateNote(option)

            HStack(spacing: 8) {
                if let source = option.source {
                    Text("via \(source)")
                        .font(.fineprint)
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let link = option.sourceUrl, let url = URL(string: link) {
                    Button {
                        HapticManager.shared.impact(.light)
                        UIApplication.shared.open(url)
                    } label: {
                        Text("View")
                            .font(.appBody(14, weight: .medium))
                            .foregroundStyle(Color.appOnAction)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(Color.appAction))
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
        }
        .padding(14)
        .frame(width: 252, alignment: .leading)
        .settingsSurface(radius: 16)
        .accessibilityElement(children: .combine)
    }

    /// Says plainly whether the price is for the dates asked, never leaving it to be assumed.
    @ViewBuilder
    private func dateNote(_ option: TravelOption) -> some View {
        switch option.dateMatch {
        case "exact":
            HStack(spacing: 6) {
                AdamDot(solid: true, size: 8)
                Text("For your dates").font(.fineprint).foregroundStyle(Color.appInk)
            }
        case "adjacent":
            HStack(spacing: 6) {
                AdamDot(solid: false, size: 8)
                Text(adjacentText(option)).font(.fineprint).foregroundStyle(Color.appWarning)
                    .lineLimit(2)
            }
        default:
            HStack(spacing: 6) {
                AdamDot(solid: false, size: 8)
                Text("Dates not stated").font(.fineprint).foregroundStyle(Color.appMuted)
            }
        }
    }

    private func adjacentText(_ option: TravelOption) -> String {
        var text = "Different dates"
        if let days = option.offByDays, days > 0 { text += " · \(days) day\(days == 1 ? "" : "s") off" }
        if let quoted = option.quotedFor, !quoted.isEmpty { text += " · \(quoted)" }
        return text
    }

    private func facts(for option: TravelOption) -> String? {
        var parts: [String] = []
        switch kind {
        case .flights:
            if let stops = option.stops { parts.append(stops == 0 ? "Direct" : "\(stops) stop\(stops == 1 ? "" : "s")") }
            if let minutes = option.durationMinutes { parts.append("\(minutes / 60)h \(minutes % 60)m") }
        case .hotels:
            if let rating = option.rating { parts.append("★ \(String(format: "%.1f", rating))") }
            if let area = option.area { parts.append(area) }
            if option.availabilityStated == true { parts.append("Available") }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func priceText(_ option: TravelOption) -> String? {
        guard let amount = option.price ?? option.pricePerNight ?? option.totalPrice else { return nil }
        let code = option.currency ?? "GBP"
        let whole = amount.rounded() == amount
        return amount.formatted(.currency(code: code).precision(.fractionLength(whole ? 0 : 2)))
    }

    private func basisText(_ option: TravelOption) -> String? {
        switch kind {
        case .flights: return option.priceBasis == "one_way" ? "one way" : "return"
        case .hotels: return option.pricePerNight != nil ? "a night" : "total"
        }
    }
}
