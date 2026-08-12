import Foundation

/// Reads the four lanes and acts on them.
///
/// One call fills the whole board — the server assembles it — so Home no longer fans out
/// to briefings, tasks and watches separately and stitches the results together.
enum HomeBoardService {
    static func fetchBoard() async throws -> HomeBoard {
        let data = try await APIClient.shared.request(path: "/agent/state")
        return try JSONDecoder().decode(HomeBoard.self, from: data)
    }

    /// Advances the "changed since" watermark. Called only when the user has genuinely
    /// looked at the board, never from a background poll — otherwise the Changed lane
    /// would empty itself before they ever saw it.
    @discardableResult
    static func markSeen() async throws -> String? {
        let data = try await APIClient.shared.request(path: "/agent/state/seen", method: "POST")
        return try? JSONDecoder().decode(MarkSeenResponse.self, from: data).lastSeenAt
    }

    static func fetchWorkflow(id: String) async throws -> WorkflowDetail {
        let data = try await APIClient.shared.request(path: "/workflows/\(id)")
        return try JSONDecoder().decode(WorkflowDetail.self, from: data)
    }

    /// Answers the question that stopped the work, without leaving the screen.
    static func resolveCheckpoint(
        workflowId: String,
        checkpointId: String,
        approved: Bool,
        choice: String? = nil,
        note: String? = nil
    ) async throws {
        var body: [String: Any] = ["approved": approved]
        if let choice { body["choice"] = choice }
        if let note { body["note"] = note }
        _ = try await APIClient.shared.request(
            path: "/workflows/\(workflowId)/checkpoints/\(checkpointId)/resolve",
            method: "POST",
            body: body
        )
    }

    static func fetchDocuments(workflowId: String? = nil) async throws -> [WorkflowDocument] {
        var query: [URLQueryItem] = []
        if let workflowId { query.append(URLQueryItem(name: "workflowId", value: workflowId)) }
        let data = try await APIClient.shared.request(
            path: "/documents",
            queryItems: query.isEmpty ? nil : query
        )
        return try JSONDecoder().decode(DocumentsResponse.self, from: data).documents
    }
}

private struct MarkSeenResponse: Codable {
    let lastSeenAt: String?
}

private struct DocumentsResponse: Codable {
    let documents: [WorkflowDocument]
}
