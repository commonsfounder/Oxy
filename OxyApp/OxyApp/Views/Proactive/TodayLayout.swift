// OxyApp/OxyApp/Views/Proactive/TodayLayout.swift
import SwiftUI

/// The card types the Today board can show. Order here is the default order.
enum TodayCardKind: String, CaseIterable, Codable, Identifiable {
    case agenda, health, reminders, incoming, inbox
    var id: String { rawValue }
    var title: String {
        switch self {
        case .incoming:  return "Incoming"
        case .inbox:     return "Inbox"
        case .agenda:    return "Agenda"
        case .health:    return "Health"
        case .reminders: return "Reminders"
        }
    }
}

/// The configurable metrics on the Health card. Order here is display order.
enum HealthMetric: CaseIterable, Identifiable {
    case steps, sleep, restingHR
    var id: String {
        switch self {
        case .steps: return "steps"
        case .sleep: return "sleep"
        case .restingHR: return "restingHR"
        }
    }
    var title: String {
        switch self {
        case .steps: return "Steps"
        case .sleep: return "Sleep"
        case .restingHR: return "Resting heart rate"
        }
    }
}

/// User-composed Today board state: which cards show and in what order.
/// Client-only — persisted to UserDefaults, no backend, no migration.
@Observable final class TodayLayout {
    private static let key = "today_layout_v1"
    private struct Persisted: Codable {
        var order: [TodayCardKind]
        var hidden: [TodayCardKind]
        // Per-card option ids the user has turned off (e.g. a Health metric, a calendar).
        // Keyed by kind.rawValue rather than TodayCardKind so it round-trips as plain JSON.
        var excludedOptions: [String: [String]] = [:]
    }

    var order: [TodayCardKind]
    var hidden: Set<TodayCardKind>
    private var excludedOptions: [TodayCardKind: Set<String>]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode(Persisted.self, from: data) {
            // Fold in any kinds added in a later app version, drop any removed.
            let known = Set(TodayCardKind.allCases)
            var restored = saved.order.filter { known.contains($0) }
            for kind in TodayCardKind.allCases where !restored.contains(kind) { restored.append(kind) }
            order = restored
            hidden = Set(saved.hidden).intersection(known)
            excludedOptions = Dictionary(uniqueKeysWithValues: saved.excludedOptions.compactMap { key, ids in
                TodayCardKind(rawValue: key).map { ($0, Set(ids)) }
            })
        } else {
            order = TodayCardKind.allCases
            hidden = []
            excludedOptions = [:]
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

    /// Whether a per-card option (a Health metric id, a calendar id, ...) is enabled.
    /// Unknown options default to enabled — nothing is excluded until the user excludes it.
    func isOptionEnabled(_ optionID: String, for kind: TodayCardKind) -> Bool {
        !(excludedOptions[kind]?.contains(optionID) ?? false)
    }

    func setOption(_ optionID: String, for kind: TodayCardKind, enabled: Bool) {
        if enabled { excludedOptions[kind]?.remove(optionID) }
        else { excludedOptions[kind, default: []].insert(optionID) }
        persist()
    }

    /// The set of option ids the user has excluded for a card — for filtering native fetches.
    func excludedOptions(for kind: TodayCardKind) -> Set<String> { excludedOptions[kind] ?? [] }

    private func persist() {
        let payload = Persisted(
            order: order, hidden: Array(hidden),
            excludedOptions: excludedOptions.reduce(into: [:]) { $0[$1.key.rawValue] = Array($1.value) }
        )
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
