import Foundation

/// Persistent agent work: goals survive the current chat turn and can be resumed
/// from Home or the Work surface.
enum AgentTasksService {
    static func createTask(goal: String, autonomy: String, guardMode: Bool) async throws -> AgentTask {
        let data = try await APIClient.shared.request(
            path: "/agent/tasks",
            method: "POST",
            body: ["goal": goal, "autonomy": autonomy, "guardMode": guardMode]
        )
        return try JSONDecoder().decode(AgentTaskEnvelope.self, from: data).task
    }

    static func fetchTasks() async throws -> [AgentTask] {
        let data = try await APIClient.shared.request(path: "/agent/tasks")
        return try JSONDecoder().decode(AgentTasksResponse.self, from: data).tasks
    }

    static func fetchWatches() async throws -> [AgentWatch] {
        let data = try await APIClient.shared.request(path: "/agent/scheduled-tasks")
        return try JSONDecoder().decode(AgentWatchesResponse.self, from: data).tasks.filter(\.active)
    }

    static func cancelWatch(id: String) async throws {
        _ = try await APIClient.shared.request(path: "/agent/scheduled-tasks/\(id)", method: "DELETE")
    }

    static func runTask(id: String, deviceType: String = "ios_companion") async throws {
        _ = try await APIClient.shared.request(
            path: "/agent/tasks/\(id)/run",
            method: "POST",
            body: ["deviceType": deviceType]
        )
    }

    static func fetchRuntime(taskID: String) async throws -> AgentRuntimeSnapshot? {
        let data = try await APIClient.shared.request(path: "/agent/tasks/\(taskID)/runtime")
        return try JSONDecoder().decode(AgentRuntimeEnvelope.self, from: data).runtime
    }

    static func updateTask(id: String, autonomy: String, guardMode: Bool) async throws -> AgentTask {
        let data = try await APIClient.shared.request(
            path: "/agent/tasks/\(id)",
            method: "PATCH",
            body: ["autonomy": autonomy, "guardMode": guardMode]
        )
        return try JSONDecoder().decode(AgentTaskEnvelope.self, from: data).task
    }

    static func fetchPermissionPolicy() async throws -> AgentPermissionPolicy {
        let data = try await APIClient.shared.request(path: "/agent/permissions")
        return try JSONDecoder().decode(AgentPermissionPolicy.self, from: data)
    }

    static func fetchAudit() async throws -> [AgentAuditEntry] {
        let data = try await APIClient.shared.request(path: "/agent/audit")
        return try JSONDecoder().decode(AgentAuditResponse.self, from: data).entries
    }
}

private struct AgentTaskEnvelope: Codable {
    let task: AgentTask
}

private struct AgentRuntimeEnvelope: Codable {
    let runtime: AgentRuntimeSnapshot?
}

private struct AgentWatchesResponse: Codable {
    let tasks: [AgentWatch]
}
