import Foundation

enum AgentContinuityService {
    static func fetch() async throws -> AgentContinuitySnapshot {
        let data = try await APIClient.shared.request(path: "/agent/continuity")
        return try JSONDecoder().decode(AgentContinuitySnapshot.self, from: data)
    }

    /// Dry run. An export whose instructions and memory failed to parse looks identical to a
    /// clean import from the outside, so nothing is written until the user has seen what was
    /// actually found.
    static func preview(fileData: Data) async throws -> AgentContinuityPreview {
        let response = try await APIClient.shared.request(
            path: "/agent/continuity/preview",
            method: "POST",
            body: try payload(from: fileData)
        )
        return try JSONDecoder().decode(AgentContinuityPreview.self, from: response)
    }

    static func `import`(fileData: Data) async throws -> AgentContinuityImportResult {
        let response = try await APIClient.shared.request(
            path: "/agent/continuity/import",
            method: "POST",
            body: try payload(from: fileData)
        )
        return try JSONDecoder().decode(AgentContinuityImportResult.self, from: response)
    }

    /// A vendor export is a ZIP; its loose `conversations.json` is only one file out of
    /// several. The ZIP carries the instructions and memory too, so it is always the better
    /// upload — send it whole and let the server unpack it, rather than asking someone to
    /// unzip and guess which file matters.
    ///
    /// No `source` is sent: the server identifies the export by its layout, and a client
    /// label would only override that with a worse guess.
    private static func payload(from fileData: Data) throws -> [String: Any] {
        if isZip(fileData) {
            return ["zipBase64": fileData.base64EncodedString()]
        }
        let decoded = try JSONSerialization.jsonObject(with: fileData)
        if let object = decoded as? [String: Any] { return object }
        if let array = decoded as? [[String: Any]] { return ["conversations": array] }
        throw AgentContinuityError.invalidFile
    }

    private static func isZip(_ data: Data) -> Bool {
        data.count > 4 && data[0] == 0x50 && data[1] == 0x4B && data[2] == 0x03 && data[3] == 0x04
    }
}

enum AgentContinuityError: LocalizedError {
    case invalidFile
    var errorDescription: String? { "That file is not a supported export." }
}

struct AgentContinuityImportResult: Codable, Equatable {
    let imported: AgentContinuityCounts
}

struct AgentContinuityCounts: Codable, Equatable {
    let conversations: Int
    let messages: Int
    let projects: Int
    let documents: Int
    let memories: Int
    let instructions: Int
    let workflows: Int
}
