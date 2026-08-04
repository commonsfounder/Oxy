import Foundation

/// A user-saved routine: a name + prompt the user can re-run later from the More menu
/// (`POST/GET/DELETE /routines`, see api/services/routines.js).
struct Routine: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let prompt: String
    /// Raw server timestamp string — kept as `String` (not `Date`) to match this app's
    /// convention (see `TaskStep.createdAt`, `HistoryEntry.createdAt`) rather than fighting
    /// `JSONDecoder`'s date-decoding strategy against Postgres's `timestamptz` format.
    let createdAt: String?
    /// Imported automations arrive switched off — the original is still live at its source,
    /// and enabling the copy before retiring it double-fires every action. Optional because
    /// routines created before the provenance migration have no value stored.
    let enabled: Bool?
    /// Where an imported routine came from ("zapier"); nil for one the user wrote here.
    let source: String?
    let intervalMinutes: Int?

    var isEnabled: Bool { enabled ?? true }
    var isImported: Bool { !(source ?? "").isEmpty }

    enum CodingKeys: String, CodingKey {
        case id, name, prompt, enabled, source
        case createdAt = "created_at"
        case intervalMinutes = "interval_minutes"
    }
}

struct RoutinesResponse: Codable {
    let routines: [Routine]
}
