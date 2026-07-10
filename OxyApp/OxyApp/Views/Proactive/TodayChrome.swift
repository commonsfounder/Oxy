// OxyApp/OxyApp/Views/Proactive/TodayChrome.swift
import SwiftUI

/// Shared SF Symbol vocabulary for the Today board — one place so headers, the
/// board editor, and row affordances stay visually consistent.
enum TodayGlyph {
    static func section(_ kind: TodayCardKind) -> String {
        switch kind {
        case .agenda:    return "calendar"
        case .health:    return "heart"
        case .reminders: return "checklist"
        case .incoming:  return "shippingbox"
        case .inbox:     return "envelope"
        }
    }

    static let tonight = "moon.stars"

    static func metric(_ metric: HealthMetric) -> String {
        switch metric {
        case .steps:     return "figure.walk"
        case .sleep:     return "bed.double"
        case .restingHR: return "heart"
        }
    }

    /// Delivery vs reservation (and a quiet default for unknown kinds).
    static func incoming(kind: String) -> String {
        switch kind.lowercased() {
        case "delivery", "order", "package", "parcel":
            return "shippingbox"
        case "reservation", "booking", "restaurant", "table":
            return "fork.knife"
        case "flight", "travel":
            return "airplane"
        case "hotel", "stay":
            return "bed.double"
        case "ticket", "event":
            return "ticket"
        default:
            return "tray"
        }
    }
}

/// Card header: accent SF Symbol + display title. Used by every Today section.
struct TodaySectionHeader: View {
    let title: String
    let icon: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.appAccent)
                .frame(width: 18, alignment: .center)
                .accessibilityHidden(true)
            Text(title)
                .font(.appDisplay(16))
                .foregroundStyle(Color.appInk)
        }
        .padding(.bottom, 12)
        .accessibilityElement(children: .combine)
    }
}

/// Small muted glyph used next to secondary labels (health metrics, list chrome).
struct TodayMetricGlyph: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.appMuted)
            .frame(width: 14, alignment: .center)
            .accessibilityHidden(true)
    }
}
