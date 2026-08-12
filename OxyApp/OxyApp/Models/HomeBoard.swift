import Foundation

/// The four questions Home answers, in the order a person asks them.
///
/// The server (api/services/home-state.js) does the assembly across workflows,
/// commitments and tasks, so this is a straight decode — no client-side merging of
/// sources, which is what made the previous mission feed so hard to reason about.
enum BoardLane: String, CaseIterable, Identifiable {
    case needsYou
    case handling
    case changed
    case completed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .handling: return "Handling"
        case .changed: return "Changed"
        case .completed: return "Completed"
        }
    }
}

/// One row on the board. Every source collapses into this shape, so the UI renders a
/// lane without knowing whether a row came from a workflow, a task or a promise.
struct BoardItem: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let kind: String
    let title: String
    let detail: String?
    let at: String?

    var workflowId: String?
    var taskId: String?
    var commitmentId: String?
    var checkpointId: String?

    /// Only on `needsYou` — the question that stopped the work, in the user's language.
    var prompt: String?
    var options: [BoardChoice]?

    var deadline: String?
    var overdue: Bool?
    var failed: Bool?
    /// Waiting on someone else rather than actively running. Nothing is required of the
    /// user either way, but a person reads the difference immediately.
    var waitingExternal: Bool?
    var progress: BoardProgress?

    var date: Date? { at.flatMap(Date.oxyParse) }

    /// A row is only actionable when there is something specific to answer. A promise the
    /// user owes has no machinery waiting on it, so it opens chat rather than a decision.
    var hasDecision: Bool { checkpointId != nil }
}

struct BoardChoice: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let label: String
    let detail: String?
}

struct BoardProgress: Codable, Equatable, Hashable {
    let done: Int
    let total: Int

    var fraction: Double {
        guard total > 0 else { return 0 }
        return min(max(Double(done) / Double(total), 0), 1)
    }
}

struct BoardCounts: Codable, Equatable {
    let needsYou: Int
    let handling: Int
    let changed: Int
    let completed: Int
}

struct HomeBoard: Codable, Equatable {
    let generatedAt: String?
    let lastSeenAt: String?
    let needsYou: [BoardItem]
    let handling: [BoardItem]
    let changed: [BoardItem]
    let completed: [BoardItem]
    let counts: BoardCounts

    static let empty = HomeBoard(
        generatedAt: nil, lastSeenAt: nil,
        needsYou: [], handling: [], changed: [], completed: [],
        counts: BoardCounts(needsYou: 0, handling: 0, changed: 0, completed: 0)
    )

    func items(in lane: BoardLane) -> [BoardItem] {
        switch lane {
        case .needsYou: return needsYou
        case .handling: return handling
        case .changed: return changed
        case .completed: return completed
        }
    }

    /// Drives the live header and the poll interval. Anything in flight means the screen
    /// should be refreshing quickly and showing motion.
    var isWorking: Bool { !handling.isEmpty }

    var isEmpty: Bool {
        needsYou.isEmpty && handling.isEmpty && changed.isEmpty && completed.isEmpty
    }
}

// MARK: - One responsibility, in full

struct WorkflowDetail: Codable, Equatable {
    let workflow: WorkflowSummary
    let timeline: [WorkflowEvent]
    let pendingCheckpoints: [WorkflowCheckpoint]
    let documents: [WorkflowDocument]
}

struct WorkflowSummary: Codable, Equatable {
    let id: String
    let type: String?
    let goal: String
    let status: String
    let currentStep: String?
    let nextAction: String?
    let deadline: String?
    let createdAt: String?
    let closedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, type, goal, status, deadline
        case currentStep = "current_step"
        case nextAction = "next_action"
        case createdAt = "created_at"
        case closedAt = "closed_at"
    }

    var isFinished: Bool {
        ["completed", "failed", "cancelled"].contains(status.lowercased())
    }

    /// What the user is told. Never a status enum — see AGENTS.md editing rule 6.
    var plainStatus: String {
        switch status.lowercased() {
        case "gathering": return "Getting what I need"
        case "working": return "Working on it"
        case "waiting_for_user": return "Waiting on you"
        case "waiting_external": return "Waiting to hear back"
        case "completed": return "Done"
        case "failed": return "Couldn't finish"
        case "cancelled": return "Stopped"
        default: return status
        }
    }
}

struct WorkflowEvent: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let kind: String
    let summary: String?
    let actor: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, summary, actor
        case createdAt = "created_at"
    }

    var date: Date? { createdAt.flatMap(Date.oxyParse) }
    var isUser: Bool { actor?.lowercased() == "user" }
}

struct WorkflowCheckpoint: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let type: String
    let status: String
    let prompt: String
    let options: [BoardChoice]?

    /// An approval is a yes/no. A choice is a pick. The card renders differently for each,
    /// so the difference has to survive the decode.
    var isChoice: Bool { type == "choice_required" && !(options ?? []).isEmpty }
}

struct WorkflowDocument: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let filename: String
    let label: String?
    let mimeType: String?
    let byteSize: Int?

    enum CodingKeys: String, CodingKey {
        case id, filename, label
        case mimeType = "mime_type"
        case byteSize = "byte_size"
    }

    var displayName: String { label?.isEmpty == false ? label! : filename }

    var sizeText: String? {
        guard let byteSize, byteSize > 0 else { return nil }
        let units = ["B", "KB", "MB"]
        var value = Double(byteSize)
        var unit = 0
        while value >= 1024, unit < units.count - 1 { value /= 1024; unit += 1 }
        return String(format: value < 10 && unit > 0 ? "%.1f %@" : "%.0f %@", value, units[unit])
    }
}
