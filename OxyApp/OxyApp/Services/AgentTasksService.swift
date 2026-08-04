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

    static func runTask(id: String) async throws {
        _ = try await APIClient.shared.request(path: "/agent/tasks/\(id)/run", method: "POST")
    }

    static func updateTask(id: String, autonomy: String, guardMode: Bool) async throws -> AgentTask {
        let data = try await APIClient.shared.request(
            path: "/agent/tasks/\(id)",
            method: "PATCH",
            body: ["autonomy": autonomy, "guardMode": guardMode]
        )
        return try JSONDecoder().decode(AgentTaskEnvelope.self, from: data).task
    }
}

private struct AgentTaskEnvelope: Codable {
    let task: AgentTask
}
