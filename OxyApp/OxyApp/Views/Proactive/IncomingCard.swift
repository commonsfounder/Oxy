// OxyApp/OxyApp/Views/Proactive/IncomingCard.swift
import SwiftUI

/// Deliveries and reservations parsed from the briefing, as a flat editorial section —
/// no card, no progress gauges. Reads as part of the day, not a tracking widget.
struct IncomingCard: View {
    let items: [BriefingIncoming]

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                EditorialSectionTitle("Incoming").padding(.bottom, 14)
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(items.prefix(4)) { item in
                        row(item)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 22)
        }
    }

    @ViewBuilder private func row(_ item: BriefingIncoming) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.cleanTitle)
                    .font(.nmlBody(16, weight: .light))
                    .foregroundStyle(Color.edInk)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let eta = item.eta, !eta.isEmpty {
                    Text(eta).font(.nmlBody(12)).foregroundStyle(Color.edMuted)
                }
            }
            Text("\(item.vendor) · \(item.status.lowercased())")
                .font(.nmlBody(13, weight: .light))
                .foregroundStyle(Color.edMuted)
        }
    }
}
