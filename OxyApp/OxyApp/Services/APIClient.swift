import Foundation

final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    /// Base URL of the Oxy backend. Set via the OXY_BASE_URL build setting or
    /// edit this default to point at your Cloud Run deployment.
    var baseURL: String {
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
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
        AsyncStream { continuation in
            Task {
                do {
                    guard var components = URLComponents(string: "\(baseURL)\(path)") else {
                        continuation.yield(.error("Invalid URL"))
                        continuation.finish()
                        return
                    }
                    if let queryItems {
                        components.queryItems = (components.queryItems ?? []) + queryItems
                    }
                    guard let url = components.url else {
                        continuation.yield(.error("Invalid URL"))
                        continuation.finish()
                        return
                    }

                    var req = URLRequest(url: url)
                    req.httpMethod = method
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    if !token.isEmpty {
                        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    if let body {
                        req.httpBody = try JSONSerialization.data(withJSONObject: body)
                    }
                    req.timeoutInterval = 120

                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse,
                          (200...299).contains(http.statusCode) else {
                        continuation.yield(.error("Server error"))
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
