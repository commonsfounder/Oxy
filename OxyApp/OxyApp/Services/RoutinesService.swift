import Foundation

/// CRUD for user-saved routines (`/routines`, see api/services/routines.js).
enum RoutinesService {
    static func createRoutine(name: String, prompt: String, intervalMinutes: Int? = nil) async throws -> Routine {
        var body: [String: Any] = ["name": name, "prompt": prompt]
        if let intervalMinutes { body["interval_minutes"] = intervalMinutes }
        let data = try await APIClient.shared.request(
            path: "/routines",
            method: "POST",
            body: body
        )
        return try JSONDecoder().decode(Routine.self, from: data)
    }

    static func fetchRoutines() async throws -> [Routine] {
        let data = try await APIClient.shared.request(path: "/routines")
        return try JSONDecoder().decode(RoutinesResponse.self, from: data).routines
    }

    static func deleteRoutine(id: String) async throws {
        _ = try await APIClient.shared.request(path: "/routines/\(id)", method: "DELETE")
    }
}
