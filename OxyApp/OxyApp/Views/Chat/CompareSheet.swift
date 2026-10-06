import SwiftUI

/// One option as a column of facts, aligned to the table's rows. `best` marks the winner of that row.
struct CompareCell {
    let text: String
    var best = false
}

struct CompareColumn: Identifiable {
    let id: String
    let title: String
    let cells: [CompareCell?]
}

struct CompareTable {
    let rows: [String]
    let columns: [CompareColumn]
    /// Said under the table when something was deliberately not ranked.
    var note: String? = nil

    /// Marks the lowest (or highest) numeric value in a row as the best, only when two or more are comparable.
    static func markBest(_ values: [Double?], lowest: Bool) -> Set<Int> {
        let present = values.enumerated().compactMap { index, value in value.map { (index, $0) } }
        guard present.count >= 2, let target = lowest ? present.map(\.1).min() : present.map(\.1).max() else { return [] }
        let winners = present.filter { $0.1 == target }
        return winners.count == present.count ? [] : Set(winners.map(\.0))
    }
}

extension CompareTable {
    static func places(_ places: [PlaceOption]) -> CompareTable {
        let rating = markBest(places.map(\.rating), lowest: false)
        let distance = markBest(places.map { $0.distanceMeters.map(Double.init) }, lowest: true)
        let columns = places.enumerated().map { index, place in
            CompareColumn(id: place.id, title: place.name, cells: [
                place.rating.map { CompareCell(text: "★ \(String(format: "%.1f", $0))" + (place.ratingCount.map { " (\($0))" } ?? ""), best: rating.contains(index)) },
                place.price.map { CompareCell(text: $0) },
                place.openNow.map { CompareCell(text: $0 ? "Open now" : "Closed now") },
                place.distanceMeters.map { CompareCell(text: $0 < 1000 ? "\($0) m" : String(format: "%.1f km", Double($0) / 1000), best: distance.contains(index)) }
            ])
        }
        return CompareTable(rows: ["Rating", "Price", "Open", "Distance"], columns: columns)
    }

    static func travel(_ options: [TravelOption], hotels: Bool) -> CompareTable {
        // Only a price quoted for the dates asked can win, and only against another in the same currency:
        // a cheaper fare for a different week answers a different question.
        let exact = options.map { $0.dateMatch == "exact" }
        let currencies = Set(options.enumerated().filter { exact[$0.offset] }.compactMap { $0.element.currency })
        func eligible(_ values: [Double?]) -> [Double?] {
            values.enumerated().map { exact[$0.offset] ? $0.element : nil }
        }
        let comparablePrices: [Double?] = currencies.count <= 1
            ? eligible(options.map { $0.price ?? $0.pricePerNight ?? $0.totalPrice })
            : options.map { _ in nil }
        let priceBest = markBest(comparablePrices, lowest: true)
        let durationBest = markBest(eligible(options.map { $0.durationMinutes.map(Double.init) }), lowest: true)
        let ratingBest = markBest(eligible(options.map(\.rating)), lowest: false)
        let anyOtherDates = exact.contains(false)

        func money(_ option: TravelOption) -> String? {
            guard let amount = option.price ?? option.pricePerNight ?? option.totalPrice else { return nil }
            let whole = amount.rounded() == amount
            return amount.formatted(.currency(code: option.currency ?? "GBP").precision(.fractionLength(whole ? 0 : 2)))
        }
        func dates(_ option: TravelOption) -> String {
            switch option.dateMatch {
            case "exact": return "Your dates"
            case "adjacent": return "Other dates" + ((option.offByDays ?? 0) > 0 ? " (\(option.offByDays!) d off)" : "")
            default: return "Not stated"
            }
        }
        let columns = options.enumerated().map { index, option -> CompareColumn in
            let price = money(option).map { CompareCell(text: $0, best: priceBest.contains(index)) }
            if hotels {
                return CompareColumn(id: option.id, title: option.title, cells: [
                    price,
                    option.rating.map { CompareCell(text: "★ \(String(format: "%.1f", $0))", best: ratingBest.contains(index)) },
                    option.area.map { CompareCell(text: $0) },
                    CompareCell(text: dates(option)),
                    option.availabilityStated == true ? CompareCell(text: "Yes") : nil
                ])
            }
            return CompareColumn(id: option.id, title: option.title, cells: [
                price,
                option.stops.map { stops in CompareCell(text: stops == 0 ? "Direct" : "\(stops) stop\(stops == 1 ? "" : "s")", best: exact[index] && stops == 0 && options.enumerated().contains { exact[$0.offset] && ($0.element.stops ?? 0) > 0 }) },
                option.durationMinutes.map { CompareCell(text: "\($0 / 60)h \($0 % 60)m", best: durationBest.contains(index)) },
                CompareCell(text: dates(option)),
                option.source.map { CompareCell(text: $0) }
            ])
        }
        return CompareTable(
            rows: hotels ? ["Price", "Rating", "Area", "Dates", "Available"] : ["Price", "Stops", "Duration", "Dates", "Source"],
            columns: columns,
            note: anyOtherDates ? "Options for other dates aren't ranked" : nil
        )
    }
}

/// Options side by side. The best value in a row is marked, never assumed.
struct CompareSheet: View {
    let table: CompareTable

    private let labelWidth: CGFloat = 70
    private let columnWidth: CGFloat = 108

    var body: some View {
        SettingsPage(title: "Compare") {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    row(label: "", cells: table.columns.map { CompareCell(text: $0.title) }, isHeader: true)
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { index, label in
                        SettingsRule()
                        row(label: label, cells: table.columns.map { $0.cells[index] ?? CompareCell(text: "–") }, isHeader: false)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .settingsSurface()
            }
            VStack(alignment: .leading, spacing: 10) {
                SettingsStatement(text: "The best in a row is in blue", solid: false)
                if let note = table.note {
                    SettingsStatement(text: note, solid: false)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private func row(label: String, cells: [CompareCell], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.fineprint)
                .foregroundStyle(Color.appMuted)
                .frame(width: labelWidth, alignment: .leading)
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(cell.text)
                    .font(isHeader ? .rowTitle : .appBody(14, weight: cell.best ? .semibold : .regular))
                    .foregroundStyle(cell.best ? Color.appAccent : (isHeader ? Color.appInk : Color.appInk))
                    .frame(width: columnWidth, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}
