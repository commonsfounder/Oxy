import Foundation
import XCTest
@testable import AdamMacRuntime

final class SharedWorkTests: XCTestCase {
    func task(status: String, awaiting: Bool = false, results: [[String: Any]] = []) throws -> SharedWorkTask {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "task-1", "goal": "A real request", "status": status,
            "awaiting_approval": awaiting, "results": results
        ])
        return try JSONDecoder().decode(SharedWorkTask.self, from: data)
    }

    func testPendingApprovalNeverSoundsComplete() throws {
        let waiting = try task(status: "paused", awaiting: true)
        XCTAssertEqual(waiting.statusText, "Review on your phone")
        XCTAssertTrue(waiting.spokenUpdate!.contains("approval"))
        XCTAssertNil(try task(status: "running").spokenUpdate)
    }

    func testCompletionUsesOnlySuccessfulReceipts() throws {
        let completed = try task(status: "completed", results: [
            ["id": "1", "summary": "Waiting to send", "success": false, "pending": true],
            ["id": "2", "summary": "Saved event 123", "success": true, "pending": false]
        ])
        XCTAssertEqual(completed.spokenUpdate, "Saved event 123")
        XCTAssertTrue(try task(status: "completed").spokenUpdate!.contains("no completion receipt"))
    }

    func testInterruptedSpeechRoundTripsWithoutMarkingUnspokenWordsDelivered() throws {
        var receipt = SpokenDelivery(id: "update-1", text: "Hello world, the request is ready.")
        receipt.markDelivered(before: 6)
        let restored = try JSONDecoder().decode(SpokenDelivery.self, from: JSONEncoder().encode(receipt))
        XCTAssertEqual(restored.remaining, "world, the request is ready.")
        XCTAssertFalse(restored.finished)
        receipt.markDelivered(before: 0)
        XCTAssertEqual(receipt.deliveredUTF16, 6)
        receipt.complete()
        XCTAssertTrue(receipt.finished)
        XCTAssertEqual(receipt.remaining, "")
    }

    func testRemoteHTTPAndEmbeddedCredentialsAreRejected() {
        for url in ["http://example.com", "https://name:password@example.com", "https://example.com?token=x"] {
            XCTAssertThrowsError(try SharedWorkClient(baseURL: URL(string: url)!))
        }
        XCTAssertNoThrow(try SharedWorkClient(baseURL: URL(string: "http://127.0.0.1:8080")!))
    }

    func testClientCreatesThenStartsSameTaskAndReadsPhoneVisibleState() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [WorkProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = try SharedWorkClient(baseURL: URL(string: "https://work.example")!, token: "test-token", session: session)
        let created = try await client.create(goal: "Prepare a request")
        XCTAssertEqual(created.id, "task-1")
        try await client.start(id: created.id)
        let observed = try await client.task(id: created.id)
        XCTAssertTrue(observed.awaitingApproval)
        XCTAssertEqual(observed.id, created.id)
    }
}

private final class WorkProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        let path = request.url!.path
        var json = "{}"
        if path == "/agent/tasks" {
            XCTAssertEqual(request.httpMethod, "POST")
            json = #"{"task":{"id":"task-1","goal":"Prepare a request","status":"pending","awaiting_approval":false,"results":[]}}"#
        } else if path == "/agent/tasks/task%2D1/run" || path == "/agent/tasks/task-1/run" {
            XCTAssertEqual(request.httpMethod, "POST")
        } else if path == "/agent/tasks/task%2D1" || path == "/agent/tasks/task-1" {
            XCTAssertEqual(request.httpMethod, "GET")
            json = #"{"task":{"id":"task-1","goal":"Prepare a request","status":"paused","awaiting_approval":true,"results":[]}}"#
        } else { XCTFail("Unexpected path: \(path)") }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
