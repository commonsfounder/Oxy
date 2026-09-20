import Foundation

public struct SharedWorkActivity: Codable, Equatable, Sendable {
    public let id: String
    public let summary: String
    public let success: Bool
    public let pending: Bool
}

public struct SharedWorkTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let goal: String
    public let status: String
    public let awaitingApproval: Bool
    public let results: [SharedWorkActivity]
    public let lastError: String?
    public let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, goal, status, results
        case awaitingApproval = "awaiting_approval"
        case lastError = "last_error"
        case updatedAt = "updated_at"
    }

    public var statusText: String {
        if awaitingApproval { return "Review on your phone" }
        switch status {
        case "running": return "Working"
        case "completed": return "Finished"
        case "failed": return "Could not finish"
        case "paused": return "Paused"
        case "cancelled": return "Cancelled"
        default: return "Not started"
        }
    }

    public var spokenUpdate: String? {
        if awaitingApproval { return "This request needs your approval. Open Work on your phone to review it." }
        if status == "failed" { return lastError ?? "I could not finish this request. Open Work for the details." }
        if status == "completed" {
            let receipts = results.filter { $0.success && !$0.pending }.map(\.summary)
            return receipts.isEmpty
                ? "The task has ended, but there is no completion receipt to read."
                : receipts.joined(separator: " ")
        }
        if status == "cancelled" { return "The request was cancelled." }
        return nil
    }

    public var announcementID: String { id + ":" + status + ":" + (spokenUpdate ?? "") }
}

public struct SharedWorkSession: Codable, Sendable {
    public let token: String
    public let userId: String
}

public enum SharedWorkError: Error, LocalizedError {
    case insecureServer
    case response(Int)
    public var errorDescription: String? {
        switch self {
        case .insecureServer: return "Use an HTTPS server, or localhost for development."
        case .response(401): return "Your session expired. Sign in again."
        case .response(409): return "This request has changed. Refresh its status."
        case .response(let status): return "The server could not complete the request (\(status))."
        }
    }
}

public final class SharedWorkClient: @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let token: String

    public init(baseURL: URL, token: String = "", session: URLSession? = nil) throws {
        guard baseURL.scheme == "https" || (baseURL.scheme == "http"
            && ["localhost", "127.0.0.1", "::1"].contains(baseURL.host ?? "")),
            baseURL.user == nil, baseURL.password == nil,
            baseURL.query == nil, baseURL.fragment == nil else { throw SharedWorkError.insecureServer }
        self.baseURL = baseURL
        self.token = token
        self.session = session ?? URLSession(configuration: .ephemeral, delegate: WorkRedirectBoundary(origin: baseURL), delegateQueue: nil)
    }

    public func signIn(identifier: String, password: String) async throws -> SharedWorkSession {
        let key = identifier.contains("@") ? "email" : "userId"
        return try await request("auth/login", method: "POST", body: [key: identifier, "password": password])
    }

    public func tasks() async throws -> [SharedWorkTask] {
        struct Envelope: Decodable { let tasks: [SharedWorkTask] }
        let envelope: Envelope = try await request("agent/tasks")
        return envelope.tasks
    }

    public func task(id: String) async throws -> SharedWorkTask {
        struct Envelope: Decodable { let task: SharedWorkTask }
        let envelope: Envelope = try await request("agent/tasks/" + pathID(id))
        return envelope.task
    }

    public func create(goal: String) async throws -> SharedWorkTask {
        struct Envelope: Decodable { let task: SharedWorkTask }
        let envelope: Envelope = try await request("agent/tasks", method: "POST", body: [
            "goal": goal, "autonomy": "Balanced", "guardMode": true
        ])
        return envelope.task
    }

    public func start(id: String) async throws {
        let _: EmptyResponse = try await request("agent/tasks/" + pathID(id) + "/run", method: "POST",
            body: ["deviceType": "mac_companion"])
    }

    private func pathID(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }

    private struct EmptyResponse: Decodable {}

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("mac/0.1", forHTTPHeaderField: "X-Client-Version")
        if !token.isEmpty { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SharedWorkError.response(0) }
        guard (200...299).contains(http.statusCode) else { throw SharedWorkError.response(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private final class WorkRedirectBoundary: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let origin: URL
    init(origin: URL) { self.origin = origin }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        let target = request.url
        let sameOrigin = target?.scheme == origin.scheme && target?.host == origin.host && target?.port == origin.port
        completionHandler(sameOrigin ? request : nil)
    }
}

public struct SpokenDelivery: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public private(set) var deliveredUTF16: Int
    public private(set) var finished: Bool

    public init(id: String, text: String) {
        self.id = id
        self.text = text
        deliveredUTF16 = 0
        finished = false
    }

    public var remaining: String { (text as NSString).substring(from: deliveredUTF16) }

    public mutating func markDelivered(before offset: Int) {
        deliveredUTF16 = max(deliveredUTF16, min(max(0, offset), (text as NSString).length))
    }

    public mutating func complete() {
        deliveredUTF16 = (text as NSString).length
        finished = true
    }
}
