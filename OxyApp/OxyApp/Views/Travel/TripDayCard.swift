import SwiftUI

// A single day card in the itinerary — morning / afternoon / evening blocks
// with an optional "why" rationale for each slot.

struct TripDayCard: View {
    let day: ItineraryDay
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("DAY \(day.day)")
                            .font(.system(.caption2, design: .monospaced))
                            .tracking(1.2)
                            .foregroundStyle(Color.nmlMuted)
                        Text(day.theme ?? day.area ?? "")
                            .font(.system(.callout, weight: .medium))
                            .foregroundStyle(Color.nmlInk)
                    }
                    Spacer()
                    if let date = day.date {
                        Text(shortDate(date))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.nmlMuted)
                }
                .padding(16)
            }
            .buttonStyle(.plain)

            // Slots — shown when expanded
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    Divider().background(Color.nmlHairline)
                    if let morning = day.morning { slotRow("MORNING", morning) }
                    if let afternoon = day.afternoon { slotRow("AFTERNOON", afternoon) }
                    if let evening = day.evening { slotRow("EVENING", evening) }
                    if let meals = day.meals, hasMeals(meals) { mealsRow(meals) }
                    if let tips = day.travelTips, !tips.isEmpty { tipsRow(tips) }
                    if let alts = day.alternatives, !alts.isEmpty { alternativesRow(alts) }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color.nmlSurface)
        .border(Color.nmlHairline, width: 0.5)
    }

    private func slotRow(_ label: String, _ slot: DaySlot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(.caption2, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(Color.nmlMuted)
            Text(slot.activity ?? "—")
                .font(.system(.callout))
                .foregroundStyle(Color.nmlInk)
            HStack(spacing: 12) {
                if let duration = slot.duration {
                    badge(duration)
                }
                if let cost = slot.estimatedCost {
                    badge("~£\(Int(cost))")
                }
            }
            if let why = slot.why, !why.isEmpty {
                Text(why)
                    .font(.system(.caption))
                    .foregroundStyle(Color.nmlMuted)
                    .italic()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func mealsRow(_ meals: DayMeals) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("MEALS")
                .font(.system(.caption2, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(Color.nmlMuted)
            VStack(alignment: .leading, spacing: 3) {
                if let b = meals.breakfast { mealLine("Breakfast", b) }
                if let l = meals.lunch     { mealLine("Lunch", l) }
                if let d = meals.dinner    { mealLine("Dinner", d) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func mealLine(_ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(Color.nmlMuted)
            Text(value)
                .font(.system(.caption))
                .foregroundStyle(Color.nmlInk)
        }
    }

    private func tipsRow(_ tips: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("TIPS")
                .font(.system(.caption2, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(Color.nmlMuted)
            Text(tips)
                .font(.system(.caption))
                .foregroundStyle(Color.nmlMuted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func alternativesRow(_ alts: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ALTERNATIVES")
                .font(.system(.caption2, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(Color.nmlMuted)
            ForEach(alts, id: \.self) { alt in
                Text("· \(alt)")
                    .font(.system(.caption))
                    .foregroundStyle(Color.nmlMuted)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(Color.nmlMuted)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Color.nmlSurface2)
    }

    private func hasMeals(_ meals: DayMeals) -> Bool {
        meals.breakfast != nil || meals.lunch != nil || meals.dinner != nil
    }

    private func shortDate(_ iso: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: iso) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "d MMM"
        return out.string(from: d)
    }
}
