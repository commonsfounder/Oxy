// OxyApp/OxyApp/Views/Proactive/TodayLayout.swift
import SwiftUI

/// The card types the Today board can show. Order here is the default order.
enum TodayCardKind: String, CaseIterable, Codable, Identifiable {
    case incoming, inbox, agenda, reminders
    var id: String { rawValue }
    var title: String {
        switch self {
        case .incoming:  return "Incoming"
        case .inbox:     return "Inbox"
        case .agenda:    return "Agenda"
        case .reminders: return "Reminders"
        }
    }
}

/// User-composed Today board state: which cards show and in what order.
/// Client-only — persisted to UserDefaults, no backend, no migration.
@Observable final class TodayLayout {
    private static let key = "today_layout_v1"
    private struct Persisted: Codable { var order: [TodayCardKind]; var hidden: [TodayCardKind] }

    var order: [TodayCardKind]
    var hidden: Set<TodayCardKind>

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode(Persisted.self, from: data) {
            // Fold in any kinds added in a later app version, drop any removed.
            let known = Set(TodayCardKind.allCases)
            var restored = saved.order.filter { known.contains($0) }
            for kind in TodayCardKind.allCases where !restored.contains(kind) { restored.append(kind) }
            order = restored
            hidden = Set(saved.hidden).intersection(known)
        } else {
            order = TodayCardKind.allCases
            hidden = []
        }
    }

    func visibleOrdered() -> [TodayCardKind] { order.filter { !hidden.contains($0) } }

    func isHidden(_ kind: TodayCardKind) -> Bool { hidden.contains(kind) }

    func toggle(_ kind: TodayCardKind) {
        if hidden.contains(kind) { hidden.remove(kind) } else { hidden.insert(kind) }
        persist()
    }

    func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    private func persist() {
        let payload = Persisted(order: order, hidden: Array(hidden))
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
