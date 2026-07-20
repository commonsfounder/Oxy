import Foundation

/// One recorded step of a completed browser-automation task (see `run_browser_task`
/// in api/index.js). This is a POST-HOC transcript — by the time iOS learns a
/// `taskId` (only delivered on the FINAL action result of a chat turn), the
/// browser task itself has already finished. It is never a live, in-progress
/// feed — see `AgentTaskSession.fetchLiveSteps()`.
struct TaskStep: Codable, Identifiable, Equatable {
    let id: String
    let stepName: String
    let phase: String
    let status: String
    /// Raw server timestamp string — kept as `String` (not `Date`) to match this
    /// app's convention (see `HistoryEntry.createdAt` in Message.swift) rather than
    /// fighting `JSONDecoder`'s date-decoding strategy against Postgres's
    /// `timestamptz` format. Use `createdAtDate` when a parsed `Date` is needed.
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case stepName = "step_name"
        case phase
        case status
        case createdAt = "created_at"
    }

    var createdAtDate: Date? { Date.oxyParse(createdAt) }
}

struct TaskStepsResponse: Codable {
    let steps: [TaskStep]
}
