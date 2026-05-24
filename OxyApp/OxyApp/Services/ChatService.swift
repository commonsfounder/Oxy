import Foundation

struct ChatService {
    private let api = APIClient.shared

    func sendMessage(
        userId: String,
        message: String,
        settings: OxySettings? = nil,
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
                "autonomy": settings.autonomy
            ]
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
        return try JSONDecoder().decode([HistoryEntry].self, from: data)
    }
}
