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
    /// "success" | "failed" | nil (never run yet). Set by the proactive sweep after every
    /// scheduled firing — see markRoutineRun in api/services/routines.js.
    let lastRunStatus: String?
    let lastRunError: String?
    let consecutiveFailures: Int?

    var isEnabled: Bool { enabled ?? true }
    var isImported: Bool { !(source ?? "").isEmpty }
    /// One bad run can be a transient hiccup; several in a row is the routine actually being
    /// broken (dead connector, bad prompt) — that's the point worth surfacing to the user.
    var isFailing: Bool { lastRunStatus == "failed" && (consecutiveFailures ?? 0) >= 2 }

    enum CodingKeys: String, CodingKey {
        case id, name, prompt, enabled, source
        case createdAt = "created_at"
        case intervalMinutes = "interval_minutes"
        case lastRunStatus = "last_run_status"
        case lastRunError = "last_run_error"
        case consecutiveFailures = "consecutive_failures"
    }
}

struct RoutinesResponse: Codable {
    let routines: [Routine]
}
