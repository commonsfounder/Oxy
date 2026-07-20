import Foundation

/// Fetches the recorded step trace for a finished browser-automation task
/// (`GET /tasks/:id/steps`). This is always a post-hoc transcript of a task that
/// has already completed by the time the caller learns its `taskId` — see the
/// note on `AgentTaskSession.fetchLiveSteps()`.
enum TaskStepsService {
    static func fetchSteps(taskId: String) async throws -> [TaskStep] {
        let data = try await APIClient.shared.request(path: "/tasks/\(taskId)/steps")
        return try JSONDecoder().decode(TaskStepsResponse.self, from: data).steps
    }
}
