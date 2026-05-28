import Foundation

struct ChatService {
    private let api = APIClient.shared

    func backendVersion() async throws -> BackendVersion {
        let data = try await api.request(path: "/version")
        return try JSONDecoder().decode(BackendVersion.self, from: data)
    }

    func sendMessage(
        userId: String,
        message: String,
        chatStartedAt: String? = nil,
        settings: OxySettings? = nil,
        location: [String: Double]? = nil,
        nativeHints: [String: Any]? = nil,
        tts: Bool = false
    ) -> AsyncStream<SSEEvent> {
        var body: [String: Any] = [
            "userId": userId,
            "message": message
        ]

        if let chatStartedAt {
            body["chatStartedAt"] = chatStartedAt
        }

        if let settings {
            body["settings"] = [
                "name": settings.name,
                "voice": settings.voice,
                "voiceOn": settings.voiceOn,
                "voiceEngine": settings.voiceEngine,
                "autonomy": settings.autonomy,
                "preferredMapsApp": settings.preferredMapsApp,
                "preferredTransportMode": settings.preferredTransportMode,
                "reviewBeforeOpeningApps": settings.reviewBeforeOpeningApps,
                "confirmSensitiveAppOpens": settings.confirmSensitiveAppOpens
            ]
        }

        if let location {
            body["location"] = location
        }

        if let nativeHints, !nativeHints.isEmpty {
            body["nativeHints"] = nativeHints
        }

        var queryItems = [URLQueryItem(name: "stream", value: "true")]
        if tts || (settings?.voiceOn == true) {
            queryItems.append(URLQueryItem(name: "tts", value: "true"))
        }

        return api.sseStream(
            path: "/chat",
            method: "POST",
            body: body,
            queryItems: queryItems
        )
    }

    func loadHistory(userId: String, limit: Int = 50, since: String? = nil) async throws -> [HistoryEntry] {
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        if let since {
            queryItems.append(URLQueryItem(name: "since", value: since))
        }
        let data = try await api.request(
            path: "/history/\(userId)",
            queryItems: queryItems
        )
        return try JSONDecoder().decode(HistoryResponse.self, from: data).history
    }

    func loadHistoryAround(userId: String, createdAt: String) async throws -> [HistoryEntry] {
        let data = try await api.request(
            path: "/history/\(userId)/around",
            queryItems: [
                URLQueryItem(name: "createdAt", value: createdAt),
                URLQueryItem(name: "before", value: "24"),
                URLQueryItem(name: "after", value: "24")
            ]
        )
        return try JSONDecoder().decode(HistoryResponse.self, from: data).history
    }

    func logNativeLocalAction(userId: String, message: String, result: ActionResult, chatStartedAt: String? = nil) async {
        var body: [String: Any] = [
            "userId": userId,
            "message": message,
            "result": result.dictionary
        ]
        if let chatStartedAt {
            body["chatStartedAt"] = chatStartedAt
        }
        _ = try? await api.request(
            path: "/native/local-action",
            method: "POST",
            body: body
        )
    }

    func sendImageMessage(
        userId: String,
        message: String,
        imageData: Data,
        fileName: String,
        mimeType: String,
        chatStartedAt: String? = nil,
        settings: OxySettings? = nil
    ) async throws -> ImageChatResponse {
        var fields: [String: String] = [
            "userId": userId,
            "message": message
        ]
        if let chatStartedAt {
            fields["chatStartedAt"] = chatStartedAt
        }
        if let settings {
            let payload: [String: Any] = [
                "name": settings.name,
                "voice": settings.voice,
                "voiceOn": settings.voiceOn,
                "voiceEngine": settings.voiceEngine,
                "autonomy": settings.autonomy,
                "preferredMapsApp": settings.preferredMapsApp,
                "preferredTransportMode": settings.preferredTransportMode,
                "reviewBeforeOpeningApps": settings.reviewBeforeOpeningApps,
                "confirmSensitiveAppOpens": settings.confirmSensitiveAppOpens
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload),
               let json = String(data: data, encoding: .utf8) {
                fields["settings"] = json
            }
        }

        var queryItems: [URLQueryItem] = []
        if settings?.voiceOn == true {
            queryItems.append(URLQueryItem(name: "tts", value: "true"))
        }

        let data = try await api.multipartRequest(
            path: "/chat-with-image",
            fields: fields,
            fileField: "image",
            fileName: fileName,
            mimeType: mimeType,
            fileData: imageData,
            queryItems: queryItems
        )
        return try JSONDecoder().decode(ImageChatResponse.self, from: data)
    }

    func loadBriefings(userId: String, limit: Int = 30) async throws -> [Briefing] {
        let data = try await api.request(
            path: "/briefings/\(userId)",
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
        return try JSONDecoder().decode(BriefingsResponse.self, from: data).briefings
    }

    func markBriefingRead(userId: String, briefingId: String) async {
        _ = try? await api.request(
            path: "/briefings/\(briefingId)/read",
            method: "POST",
            body: ["userId": userId]
        )
    }

    func runProactiveCheck(userId: String) async throws {
        _ = try await api.request(
            path: "/proactive/\(userId)/run",
            method: "POST",
            body: ["userId": userId]
        )
    }
}

struct BackendVersion: Decodable {
    let app: String?
    let packageVersion: String?
    let gitCommit: String?
    let gitBranch: String?
    let cloudRunRevision: String?
    let deployId: String?
    let buildTime: String?
    let environment: String?
}

struct ImageChatResponse: Codable {
    let text: String
    let actions: [ActionResult]?
    let audio: String?
    let audioMimeType: String?
    let ttsError: String?
}

private extension Encodable {
    var dictionary: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }
}
