import Foundation

struct ChatService {
    private let api = APIClient.shared

    /// Sends a chat message via SSE streaming and yields events as they arrive.
    func sendMessage(
        userId: String,
        message: String,
        voice: String? = nil,
        tts: Bool = false
    ) -> AsyncStream<SSEEvent> {
        var body: [String: Any] = [
            "userId": userId,
            "message": message
        ]
        if let voice {
            body["settings"] = ["voice": voice]
        }

        var queryItems = [URLQueryItem(name: "stream", value: "true")]
        if tts {
            queryItems.append(URLQueryItem(name: "tts", value: "true"))
        }

        return api.sseStream(
            path: "/chat",
            method: "POST",
            body: body,
            queryItems: queryItems
        )
    }

    /// Loads conversation history from the server.
    func loadHistory(userId: String, limit: Int = 50) async throws -> [HistoryEntry] {
        let data = try await api.request(
            path: "/history/\(userId)",
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
        return try JSONDecoder().decode([HistoryEntry].self, from: data)
    }
}
