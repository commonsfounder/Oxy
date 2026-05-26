import Foundation

struct ChatService {
    private let api = APIClient.shared

    func sendMessage(
        userId: String,
        message: String,
        settings: OxySettings? = nil,
        location: [String: Double]? = nil,
        nativeHints: [String: Any]? = nil,
        tts: Bool = false
    ) -> AsyncStream<SSEEvent> {
        var body: [String: Any] = [
            "userId": userId,
            "message": message
        ]

        if let settings {
            body["settings"] = [
                "name": settings.name,
                "voice": settings.voice,
                "voiceOn": settings.voiceOn,
                "voiceEngine": settings.voiceEngine,
                "autonomy": settings.autonomy,
                "preferredMapsApp": settings.preferredMapsApp,
                "preferredTransportMode": settings.preferredTransportMode,
                "reviewBeforeOpeningApps": settings.reviewBeforeOpeningApps
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

    func loadHistory(userId: String, limit: Int = 50) async throws -> [HistoryEntry] {
        let data = try await api.request(
            path: "/history/\(userId)",
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
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

    func logNativeLocalAction(userId: String, message: String, result: ActionResult) async {
        _ = try? await api.request(
            path: "/native/local-action",
            method: "POST",
            body: [
                "userId": userId,
                "message": message,
                "result": result.dictionary
            ]
        )
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

private extension Encodable {
    var dictionary: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }
}
