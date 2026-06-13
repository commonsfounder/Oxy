import Foundation

extension Notification.Name {
    static let oxySessionExpired = Notification.Name("oxy.sessionExpired")
    static let oxyJumpToChat = Notification.Name("oxy.jumpToChat")
    static let oxyJumpToMore = Notification.Name("oxy.jumpToMore")
    /// Carries a spoken message (from the pendant or the "Ask Oxy" Siri intent)
    /// into the *currently visible* ChatView — userInfo["text"]. This replaces
    /// presenting a second ChatView, which caused a duplicate-screen overlay.
    static let oxyVoiceMessage = Notification.Name("oxy.voiceMessage")
}

final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    /// Base URL of the Oxy backend.
    /// Priority: UserDefaults override > OXY_BASE_URL build setting > hardcoded default.
    /// Users can set a custom URL via Settings → Diagnostics or the `oxy_custom_backend_url` UserDefaults key.
    var baseURL: String {
        if let custom = UserDefaults.standard.string(forKey: "oxy_custom_backend_url"), !custom.isEmpty {
            return custom.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        if let envURL = Bundle.main.infoDictionary?["OXY_BASE_URL"] as? String, !envURL.isEmpty {
            return envURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        #if DEBUG
        return "https://oxy-151340634966.europe-west2.run.app"
        #else
        return "https://oxy-151340634966.europe-west2.run.app"
        #endif
    }

    private init() {}

    // MARK: - Token

    private var token: String {
        KeychainHelper.shared.read(key: "session_token") ?? ""
    }

    // Sent on every request so the backend can attribute SSE/version issues to a build.
    private static let clientVersion = "ios/" + ((Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?")

    // MARK: - Requests

    func request(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        queryItems: [URLQueryItem]? = nil
    ) async throws -> Data {
        guard var components = URLComponents(string: "\(baseURL)\(path)") else {
            throw APIError.invalidURL
        }
        if let queryItems {
            components.queryItems = (components.queryItems ?? []) + queryItems
            // URLComponents leaves "+" unescaped in query values, and many servers
            // decode it as a space — which corrupts ISO timestamps like
            // "...789+00:00" into "...789 00:00" and 400s. Force it to %2B so
            // values (e.g. session createdAt anchors) round-trip intact.
            components.percentEncodedQuery = components.percentEncodedQuery?
                .replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.clientVersion, forHTTPHeaderField: "X-Client-Version")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        req.timeoutInterval = 60

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown
        }
        guard (200...299).contains(http.statusCode) else {
            let errorBody = try? JSONDecoder().decode(ErrorBody.self, from: data)
            let message = errorBody?.error ?? "Request failed"
            if http.statusCode == 401 {
                handleUnauthorized()
                throw APIError.server(401, message)
            }
            throw APIError.server(http.statusCode, message)
        }
        return data
    }

    func exportUserData(userId: String) async throws -> Data {
        try await request(path: "/user/\(userId)/export")
    }

    func deleteAccount(userId: String) async throws {
        _ = try await request(path: "/user/\(userId)", method: "DELETE")
    }

    func multipartRequest(
        path: String,
        method: String = "POST",
        fields: [String: String],
        fileField: String,
        fileName: String,
        mimeType: String,
        fileData: Data,
        queryItems: [URLQueryItem]? = nil
    ) async throws -> Data {
        guard var components = URLComponents(string: "\(baseURL)\(path)") else {
            throw APIError.invalidURL
        }
        if let queryItems {
            components.queryItems = (components.queryItems ?? []) + queryItems
            // URLComponents leaves "+" unescaped in query values, and many servers
            // decode it as a space — which corrupts ISO timestamps like
            // "...789+00:00" into "...789 00:00" and 400s. Force it to %2B so
            // values (e.g. session createdAt anchors) round-trip intact.
            components.percentEncodedQuery = components.percentEncodedQuery?
                .replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        for (key, value) in fields {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(fileName)\"\r\n")
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n")

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.clientVersion, forHTTPHeaderField: "X-Client-Version")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = body
        req.timeoutInterval = 120

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown
        }
        guard (200...299).contains(http.statusCode) else {
            let errorBody = try? JSONDecoder().decode(ErrorBody.self, from: data)
            let message = errorBody?.error ?? "Upload failed"
            if http.statusCode == 401 {
                handleUnauthorized()
                throw APIError.server(401, message)
            }
            throw APIError.server(http.statusCode, message)
        }
        return data
    }

    /// Opens an SSE stream and yields parsed events via an AsyncStream.
    func sseStream(
        path: String,
        method: String = "POST",
        body: [String: Any]? = nil,
        queryItems: [URLQueryItem]? = nil
    ) -> AsyncStream<SSEEvent> {
        let baseURL = self.baseURL
        let token = self.token
        let bodyDataResult: Result<Data?, Error> = Result {
            try body.map { try JSONSerialization.data(withJSONObject: $0) }
        }
        return AsyncStream<SSEEvent> { continuation in
            Task {
                do {
                    guard var components = URLComponents(string: "\(baseURL)\(path)") else {
                        continuation.yield(.error("Invalid URL"))
                        continuation.finish()
                        return
                    }
                    if let queryItems {
                        components.queryItems = (components.queryItems ?? []) + queryItems
                        components.percentEncodedQuery = components.percentEncodedQuery?
                            .replacingOccurrences(of: "+", with: "%2B")
                    }
                    guard let url = components.url else {
                        continuation.yield(.error("Invalid URL"))
                        continuation.finish()
                        return
                    }

                    var req = URLRequest(url: url)
                    req.httpMethod = method
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue(Self.clientVersion, forHTTPHeaderField: "X-Client-Version")
                    if !token.isEmpty {
                        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    switch bodyDataResult {
                    case .success(let bodyData):
                        req.httpBody = bodyData
                    case .failure(let error):
                        continuation.yield(.error(error.localizedDescription))
                        continuation.finish()
                        return
                    }
                    req.timeoutInterval = 120

                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else {
                        continuation.yield(.error("Server error"))
                        continuation.finish()
                        return
                    }
                    guard (200...299).contains(http.statusCode) else {
                        if http.statusCode == 401 {
                            self.handleUnauthorized()
                            continuation.yield(.error("Session expired. Please sign in again."))
                        } else {
                            continuation.yield(.error("Server error"))
                        }
                        continuation.finish()
                        return
                    }

                    var buffer = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("data: ") {
                            let jsonStr = String(line.dropFirst(6))
                            buffer = ""
                            if let data = jsonStr.data(using: .utf8) {
                                let event = SSEEvent.parse(data)
                                continuation.yield(event)
                                if case .done = event { break }
                            }
                        } else if line.isEmpty {
                            buffer = ""
                        } else {
                            buffer += line
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.yield(.error(error.localizedDescription))
                    continuation.finish()
                }
            }
        }
    }

    private func handleUnauthorized() {
        KeychainHelper.shared.delete(key: "session_token")
        KeychainHelper.shared.delete(key: "user_id")
        NotificationCenter.default.post(name: .oxySessionExpired, object: nil)
    }
}

private extension Data {
    mutating func append(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}

// MARK: - SSE Event Types

enum SSEEvent {
    case text(String)
    case replace(String)
    case actions([ActionResult])
    case status(String, String)
    case audio(String, String)
    case transcription(String)
    case transcriptionError(String)
    case ttsError(String)
    case sources([MessageSource])
    case done
    case error(String)

    static func parse(_ data: Data) -> SSEEvent {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return .error("Invalid event data")
        }
        switch type {
        case "text":
            return .text(json["chunk"] as? String ?? "")
        case "replace":
            return .replace(json["text"] as? String ?? "")
        case "actions":
            if let resultsData = try? JSONSerialization.data(withJSONObject: json["results"] ?? []),
               let results = try? JSONDecoder().decode([ActionResult].self, from: resultsData) {
                return .actions(results)
            }
            return .actions([])
        case "status":
            return .status(
                json["status"] as? String ?? "",
                json["label"] as? String ?? ""
            )
        case "audio":
            return .audio(
                json["data"] as? String ?? "",
                json["mimeType"] as? String ?? "audio/wav"
            )
        case "transcription":
            return .transcription(json["text"] as? String ?? "")
        case "transcription-error":
            return .transcriptionError(json["error"] as? String ?? "Transcription failed")
        case "tts-error":
            return .ttsError(json["error"] as? String ?? "TTS failed")
        case "sources":
            if let itemsData = try? JSONSerialization.data(withJSONObject: json["items"] ?? []),
               let items = try? JSONDecoder().decode([MessageSource].self, from: itemsData) {
                return .sources(items)
            }
            return .sources([])
        case "done":
            return .done
        case "error":
            return .error(json["error"] as? String ?? "Unknown error")
        default:
            return .error("Unknown event type: \(type)")
        }
    }
}

// MARK: - Error Types

enum APIError: LocalizedError {
    case invalidURL
    case server(Int, String)
    case unknown

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .server(_, let message):
            return message
        case .unknown:
            return "An unknown error occurred"
        }
    }

    var isUnauthorized: Bool {
        if case .server(401, _) = self { return true }
        return false
    }
}

private struct ErrorBody: Codable {
    let error: String
}
