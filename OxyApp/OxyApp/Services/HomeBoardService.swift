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

struct PairedDisplay: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let type: String
    let capabilities: [String: Bool]
    let pairedAt: String?
    let lastSeenAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, capabilities
        case pairedAt, lastSeenAt
    }
}

enum DisplayTimestampParser {
    static func date(from raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: raw)
    }
}

struct DisplayPairingChallenge: Codable, Equatable {
    let id: String
    let code: String
    let expiresAt: String
    let displayUrl: String
}

private struct PairedDisplaysResponse: Codable {
    let displays: [PairedDisplay]
}

enum PairedDisplaysService {
    static func createPairing(displayName: String? = nil) async throws -> DisplayPairingChallenge {
        var body: [String: Any] = [:]
        if let displayName, !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["displayName"] = displayName
        }
        let data = try await APIClient.shared.request(path: "/agent/displays/pairing", method: "POST", body: body)
        return try JSONDecoder().decode(DisplayPairingChallenge.self, from: data)
    }

    static func fetchDisplays() async throws -> [PairedDisplay] {
        let data = try await APIClient.shared.request(path: "/agent/displays")
        return try JSONDecoder().decode(PairedDisplaysResponse.self, from: data).displays
    }

    static func revokeDisplay(id: String) async throws {
        _ = try await APIClient.shared.request(path: "/agent/displays/\(id)", method: "DELETE")
    }

    static func render(displayId: String, title: String, body: String, kind: String = "agent_update") async throws {
        _ = try await APIClient.shared.request(
            path: "/agent/displays/\(displayId)/render",
            method: "POST",
            body: ["title": title, "body": body, "kind": kind]
        )
    }
}
