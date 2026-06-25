// OxyApp/OxyApp/Views/Proactive/IncomingCard.swift
import SwiftUI

struct IncomingCard: View {
    let items: [BriefingIncoming]
    let palette: TodayPalette
    private var p: TodayPalette { palette }

    var body: some View {
        if !items.isEmpty {
            TodayCard {
                Text("Incoming").font(.nmlBody(11, weight: .semibold))
                    .tracking(2.4).foregroundStyle(p.muted)
                    .textCase(.uppercase).padding(.bottom, 14)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.prefix(4).enumerated()), id: \.element.id) { index, item in
                        row(item)
                        if index < min(items.count, 4) - 1 {
                            Divider().overlay(p.hairline).padding(.vertical, 14)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func row(_ item: BriefingIncoming) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.cleanTitle).font(.nmlBody(14, weight: .medium))
                    .foregroundStyle(p.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let eta = item.eta, !eta.isEmpty {
                    Text(eta).font(.nmlMono(11)).foregroundStyle(p.titanium)
                }
            }
            Text("\(item.vendor) · \(item.status.lowercased())")
                .font(.nmlBody(12)).foregroundStyle(p.muted).padding(.top, 2)
            if item.isDelivery, let stage = item.stage {
                progressBar(stage: stage).padding(.top, 10)
            }
        }
    }

    /// Four-segment monochrome delivery progress: ordered→shipped→out→delivered.
    @ViewBuilder private func progressBar(stage: Int) -> some View {
        HStack(spacing: 4) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(i <= stage ? p.titanium : p.hairline)
                    .frame(height: 3)
            }
        }
    }
}
