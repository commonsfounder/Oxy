import Foundation

final class APIClient {
    static let shared = APIClient()

    /// Base URL of the Oxy backend. Set via the OXY_BASE_URL build setting or
    /// edit this default to point at your Cloud Run deployment.
    var baseURL: String {
        if let envURL = Bundle.main.infoDictionary?["OXY_BASE_URL"] as? String, !envURL.isEmpty {
            return envURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        #if DEBUG
        return "http://localhost:3000"
        #else
        return "https://your-oxy-service.a.run.app"
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
        if http.statusCode == 401 {
            throw APIError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            let errorBody = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw APIError.server(http.statusCode, errorBody?.error ?? "Request failed")
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
    case unauthorized
    case server(Int, String)
    case unknown

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .unauthorized:
            return "Session expired. Please log in again."
        case .server(let code, let message):
            return "Error \(code): \(message)"
        case .unknown:
            return "An unknown error occurred"
        }
    }
}

private struct ErrorBody: Codable {
    let error: String
}
