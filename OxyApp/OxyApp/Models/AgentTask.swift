import Foundation

/// A durable goal with a stable client-facing envelope.
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
    /// The reason a run stopped, when one is available.
    let lastError: String?
    /// Whether the task can continue from its last checkpoint.
    let resumable: Bool
    /// Whether an action needs approval before the task continues.
    let awaitingApproval: Bool
    /// The durable execution identity behind this goal, when one has been started.
    var runtime: AgentRuntimeSnapshot?

    enum CodingKeys: String, CodingKey {
        case id, goal, status, autonomy, resumable
        case currentStep = "current_step"
        case guardMode = "guard_mode"
        case activities = "results"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
        case lastError = "last_error"
        case awaitingApproval = "awaiting_approval"
        case runtime
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
        awaitingApproval = try values.decodeIfPresent(Bool.self, forKey: .awaitingApproval) ?? false
        runtime = try values.decodeIfPresent(AgentRuntimeSnapshot.self, forKey: .runtime)
    }

    var isActive: Bool {
        ["pending", "running", "paused", "failed"].contains(status.lowercased())
    }

    var statusLabel: String {
        switch status.lowercased() {
        case "running": return "Handling"
        case "paused": return awaitingApproval ? "Needs your OK" : "Paused"
        case "failed": return "Needs you"
        case "completed": return "Done"
        case "cancelled": return "Cancelled"
        case "recipe": return "Saved"
        default: return "Ready"
        }
    }

    var displayGoal: String {
        var words = goal.split(separator: " ").map(String.init)
        while words.count > 1,
              words[words.count - 1].caseInsensitiveCompare(words[words.count - 2]) == .orderedSame {
            words.removeLast()
        }
        return words.joined(separator: " ")
            .replacingOccurrences(of: "a appointment", with: "an appointment", options: .caseInsensitive)
    }

    var interruptionMessage: String? {
        guard let lastError = lastError?.trimmingCharacters(in: .whitespacesAndNewlines), !lastError.isEmpty else {
            return nil
        }
        let sentence = lastError.split(separator: ".", maxSplits: 1).first.map(String.init) ?? lastError
        return sentence.hasSuffix(".") ? sentence : sentence + "."
    }

    var updatedDate: Date? { Date.oxyParse(updatedAt ?? createdAt) }
}

struct AgentRuntimeSnapshot: Codable, Equatable {
    let id: String
    let taskId: String
    let deviceId: String?
    let deviceType: String
    let kind: String
    let projectRef: String?
    let title: String
    let state: String
    let createdAt: String?
    let updatedAt: String?
    let heartbeatAt: String?
    let completedAt: String?
    let artifacts: [AgentRuntimeArtifact]

    enum CodingKeys: String, CodingKey {
        case id, deviceId, deviceType, kind, projectRef, title, state, artifacts
        case taskId = "taskId"
        case createdAt, updatedAt, heartbeatAt, completedAt
    }

    var stateLabel: String {
        switch state.lowercased() {
        case "running": return "Handling"
        case "waiting_approval": return "Needs your OK"
        case "completed": return "Complete"
        case "failed": return "Needs you"
        case "paused": return "Paused"
        case "cancelled": return "Cancelled"
        default: return "Ready"
        }
    }
}

struct AgentRuntimeArtifact: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let path: String?
    let title: String
    let summary: String
    let status: String
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, path, title, summary, status
        case createdAt
    }
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

/// A user-created background watch. The app receives only the safe description
/// needed to understand and stop it; the private instruction stays server-side.
struct AgentWatch: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let recurrence: String
    let nextRunAt: String?
    let condition: String?
    let intervalMinutes: Int?
    let expiresAt: String?
    let active: Bool

    enum CodingKeys: String, CodingKey {
        case id, title, recurrence, condition, active
        case nextRunAt, intervalMinutes, expiresAt
    }

    var cadenceLabel: String {
        switch recurrence.lowercased() {
        case "poll":
            if let condition, !condition.isEmpty { return "Until \(condition)" }
            if let intervalMinutes { return "Every \(intervalMinutes) minutes" }
            return "Watching for an update"
        case "daily": return "Every day"
        case "weekly": return "Every week"
        default: return "One check"
        }
    }

    var nextCheckLabel: String? {
        guard let nextRunAt, let date = Date.oxyParse(nextRunAt) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return "Next check \(formatter.string(from: date))"
    }
}

struct AgentPermissionPolicy: Codable, Equatable {
    let guardMode: Bool
    let read: AgentPermissionRule
    let write: AgentPermissionRule
    let payment: AgentPermissionRule
    let audit: AgentAuditPolicy
}

struct AgentPermissionRule: Codable, Equatable {
    let defaultRule: String
    let description: String

    enum CodingKeys: String, CodingKey {
        case defaultRule = "default"
        case description
    }
}

struct AgentAuditPolicy: Codable, Equatable {
    let enabled: Bool
    let undo: String
}

struct AgentAuditEntry: Codable, Identifiable, Equatable {
    let type: String
    let status: String
    let error: String?
    let createdAt: String?
    let risk: String
    let executionMode: String
    let reviewRequired: Bool
    let undo: String?

    var id: String { [createdAt ?? "", type, status].joined(separator: "-") }
}

struct AgentAuditResponse: Codable {
    let entries: [AgentAuditEntry]
}
