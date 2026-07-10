// OxyApp/OxyApp/Views/Proactive/IncomingCard.swift
import SwiftUI

/// Deliveries and reservations from the briefing — same card chrome + header
/// language as the rest of the Today board.
struct IncomingCard: View {
    let items: [BriefingIncoming]

    var body: some View {
        if !items.isEmpty {
            TodayCard(padding: 18) {
                TodaySectionHeader(title: "Incoming", icon: TodayGlyph.section(.incoming))

                VStack(alignment: .leading, spacing: 14) {
                    ForEach(items.prefix(4)) { item in
                        row(item)
                    }
                }
            }
        }
    }

    @ViewBuilder private func row(_ item: BriefingIncoming) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: TodayGlyph.incoming(kind: item.kind))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.appMuted)
                .frame(width: 18, height: 18)
                .padding(.top, 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.cleanTitle)
                        .font(.appBody(16, weight: .regular))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let eta = item.eta, !eta.isEmpty {
                        Text(eta)
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                            .lineLimit(1)
                    }
                }
                Text("\(item.vendor) · \(item.status.lowercased())")
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: item))
    }

    private func accessibilityLabel(for item: BriefingIncoming) -> String {
        var parts = [item.cleanTitle, item.vendor, item.status]
        if let eta = item.eta, !eta.isEmpty { parts.append(eta) }
        return parts.joined(separator: ", ")
    }
}
