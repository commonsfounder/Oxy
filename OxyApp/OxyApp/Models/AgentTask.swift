import Foundation

/// A durable goal owned by the agent. The backend may attach arbitrary JSON plans
/// and results, so the iOS list deliberately decodes the stable task envelope only.
struct AgentTask: Codable, Identifiable, Equatable {
    let id: String
    let goal: String
    var status: String
    let currentStep: Int
    var autonomy: String
    var guardMode: Bool
    let activities: [AgentTaskActivity]
    let createdAt: String?
    let updatedAt: String?
    let completedAt: String?
    /// Why a run stopped. A paused task with no explanation is exactly the state the
    /// durability work exists to eliminate, so this is shown wherever status is.
    let lastError: String?
    /// A checkpoint survived, so this run can continue rather than start over.
    let resumable: Bool

    enum CodingKeys: String, CodingKey {
        case id, goal, status, autonomy, resumable
        case currentStep = "current_step"
        case guardMode = "guard_mode"
        case activities = "results"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
        case lastError = "last_error"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        goal = try values.decode(String.self, forKey: .goal)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "pending"
        currentStep = try values.decodeIfPresent(Int.self, forKey: .currentStep) ?? 0
        autonomy = try values.decodeIfPresent(String.self, forKey: .autonomy) ?? "Active"
        guardMode = try values.decodeIfPresent(Bool.self, forKey: .guardMode) ?? false
        activities = try values.decodeIfPresent([AgentTaskActivity].self, forKey: .activities) ?? []
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
        completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
        lastError = try values.decodeIfPresent(String.self, forKey: .lastError)
        resumable = try values.decodeIfPresent(Bool.self, forKey: .resumable) ?? false
    }

    var isActive: Bool {
        ["pending", "running", "paused", "failed"].contains(status.lowercased())
    }

    var statusLabel: String {
        switch status.lowercased() {
        case "running": return "Working"
        case "paused": return "Paused"
        case "failed": return "Needs you"
        case "completed": return "Done"
        case "cancelled": return "Cancelled"
        case "recipe": return "Saved"
        default: return "Ready"
        }
    }

    var updatedDate: Date? { Date.oxyParse(updatedAt ?? createdAt) }
}

struct AgentTaskActivity: Codable, Identifiable, Equatable {
    let id: String
    let action: String
    let success: Bool
    let pending: Bool
    let summary: String
}

struct AgentTasksResponse: Codable {
    let tasks: [AgentTask]
}
