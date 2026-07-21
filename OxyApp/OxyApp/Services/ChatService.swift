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
        incognito: Bool = false
    ) -> AsyncStream<SSEEvent> {
        var body: [String: Any] = [
            "userId": userId,
            "message": message
        ]

        if incognito {
            body["incognito"] = true
        }

        if let chatStartedAt {
            body["chatStartedAt"] = chatStartedAt
        }

        if let settings {
            var settingsBody: [String: Any] = [
                "name": settings.name,
                "autonomy": settings.autonomy,
                "preferredMapsApp": settings.preferredMapsApp,
                "preferredTransportMode": settings.preferredTransportMode,
                "reviewBeforeOpeningApps": settings.reviewBeforeOpeningApps,
                "confirmSensitiveAppOpens": settings.confirmSensitiveAppOpens,
                "chatEffort": settings.chatEffort,
                "guardMode": settings.guardMode
            ]
            // Only present once a home address has been saved in Settings — the server
            // treats a missing pair as "no home on file" rather than (0, 0).
            if let lat = settings.homeLatitude, let lng = settings.homeLongitude {
                settingsBody["homeLatitude"] = lat
                settingsBody["homeLongitude"] = lng
            }
            body["settings"] = settingsBody
        }

        if let location {
            body["location"] = location
        }

        if let nativeHints, !nativeHints.isEmpty {
            body["nativeHints"] = nativeHints
        }

        let queryItems = [URLQueryItem(name: "stream", value: "true")]

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

    func loadHistoryAround(userId: String, createdAt: String? = nil, messageId: String? = nil) async throws -> [HistoryEntry] {
        var queryItems = [
            URLQueryItem(name: "before", value: "60"),
            URLQueryItem(name: "after", value: "60")
        ]
        if let createdAt {
            queryItems.append(URLQueryItem(name: "createdAt", value: createdAt))
        }
        if let messageId {
            queryItems.append(URLQueryItem(name: "messageId", value: messageId))
        }
        let data = try await api.request(
            path: "/history/\(userId)/around",
            queryItems: queryItems
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

    /// Polish a raw voice transcript through Gemini — removes filler words,
    /// fixes grammar, preserves intent.  Falls back to the original text on error.
    func polishTranscript(userId: String, transcript: String) async -> String {
        do {
            let body: [String: Any] = [
                "userId": userId,
                "transcript": transcript
            ]
            let data = try await api.request(
                path: "/polish-transcript",
                method: "POST",
                body: body
            )
            struct PolishResponse: Decodable { let polished: String }
            let decoded = try JSONDecoder().decode(PolishResponse.self, from: data)
            return decoded.polished.isEmpty ? transcript : decoded.polished
        } catch {
            print("[ChatService] Polish failed, using raw transcript: \(error.localizedDescription)")
            return transcript
        }
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

        let data = try await api.multipartRequest(
            path: "/chat-with-image",
            fields: fields,
            fileField: "image",
            fileName: fileName,
            mimeType: mimeType,
            fileData: imageData
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

    /// The "go handle it" path for an inbox card — a plain REST call, never a chat/agent
    /// turn, so the model never gets a chance to decide for itself whether to try
    /// browsing/logging into a bank site. See buildEmailActionPlan in api/index.js.
    func emailActionPlan(userId: String, provider: String?, messageId: String) async throws -> EmailActionPlan {
        var body: [String: Any] = ["userId": userId, "messageId": messageId]
        if let provider { body["provider"] = provider }
        let data = try await api.request(path: "/emails/action-plan", method: "POST", body: body)
        return try JSONDecoder().decode(EmailActionPlan.self, from: data)
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
