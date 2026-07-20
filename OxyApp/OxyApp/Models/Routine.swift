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

    enum CodingKeys: String, CodingKey {
        case id, name, prompt
        case createdAt = "created_at"
    }
}

struct RoutinesResponse: Codable {
    let routines: [Routine]
}
