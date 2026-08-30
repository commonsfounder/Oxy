import XCTest
@testable import AdamMacRuntime

final class GameSessionTests: XCTestCase {
    func testSinglePlayerSessionCanObserveAuthorizeControlIssueAndVerify() async throws {
        let adapter = FakeGameAdapter(frames: [
            GameFrame(id: "frame-1", fingerprint: "menu"),
            GameFrame(id: "frame-2", fingerprint: "game-started")
        ])
        let session = GameSession(adapter: adapter, sessionType: .singlePlayer)

        try await session.connect()
        let frame = try await session.observe()
        XCTAssertEqual(frame.id, "frame-1")

        try await session.propose(
            GameInput(events: [.key(code: 49, down: true), .key(code: 49, down: false)]),
            intent: "start the game"
        )
        try await session.authorizeControl()
        try await session.issueProposedInput()

        let verified = try await session.verify()
        XCTAssertTrue(verified)
        XCTAssertEqual(adapter.sentInputs.count, 1)
        XCTAssertEqual(adapter.sentInputs.first?.events.count, 2)

        let snapshot = await session.snapshot()
        XCTAssertEqual(snapshot.phase, .observing)
        XCTAssertEqual(snapshot.lastOutcome, .verified)
        XCTAssertEqual(snapshot.actionsIssued, 1)
    }

    func testPublicCompetitiveSessionNeverAuthorizesControl() async throws {
        let adapter = FakeGameAdapter(frames: [
            GameFrame(id: "frame-1", fingerprint: "live-match")
        ])
        let session = GameSession(adapter: adapter, sessionType: .publicCompetitive)

        try await session.connect()
        _ = try await session.observe()
        try await session.propose(
            GameInput(events: [.key(code: 49, down: true)]),
            intent: "move the character"
        )

        do {
            try await session.authorizeControl()
            XCTFail("Public competitive play must stay assist-only")
        } catch let error as GameRuntimeError {
            XCTAssertEqual(error, .controlNotAllowedForPublicPlay)
        }

        XCTAssertTrue(adapter.sentInputs.isEmpty)
        let snapshot = await session.snapshot()
        XCTAssertEqual(snapshot.mode, .assist)
        XCTAssertEqual(snapshot.sessionType, .publicCompetitive)
    }

    func testPauseCancelsPendingInputAndStopDisconnectsTheSession() async throws {
        let adapter = FakeGameAdapter(frames: [
            GameFrame(id: "frame-1", fingerprint: "ready")
        ])
        let session = GameSession(adapter: adapter)

        try await session.connect()
        _ = try await session.observe()
        try await session.propose(
            GameInput(events: [.key(code: 49, down: true)]),
            intent: "take the next move"
        )
        try await session.authorizeControl()

        await session.pause()
        do {
            try await session.issueProposedInput()
            XCTFail("Paused sessions must not send input")
        } catch let error as GameRuntimeError {
            XCTAssertEqual(error, .sessionPaused)
        }
        XCTAssertTrue(adapter.sentInputs.isEmpty)

        try await session.resume()
        var snapshot = await session.snapshot()
        XCTAssertEqual(snapshot.phase, .observing)

        await session.stop()
        snapshot = await session.snapshot()
        XCTAssertEqual(snapshot.phase, .disconnected)
        XCTAssertEqual(snapshot.mode, .assist)
    }

    func testMovePipelineUsesPlannerThenIssuesAndVerifiesOneMove() async throws {
        let adapter = FakeGameAdapter(frames: [
            GameFrame(id: "frame-1", fingerprint: "before"),
            GameFrame(id: "frame-2", fingerprint: "after")
        ])
        let session = GameSession(adapter: adapter)
        let pipeline = GameMovePipeline(
            session: session,
            planner: FixedMovePlanner(
                proposal: GameMoveProposal(
                    input: GameInput(events: [.key(code: 49, down: true), .key(code: 49, down: false)]),
                    intent: "advance the game"
                )
            )
        )

        try await session.connect()
        let proposal = try await pipeline.proposeNextMove()
        XCTAssertEqual(proposal.intent, "advance the game")

        try await session.authorizeControl()
        let result = try await pipeline.issueNextMoveAndVerify()

        XCTAssertTrue(result.verified)
        XCTAssertEqual(result.intent, "advance the game")
        XCTAssertEqual(adapter.sentInputs, [proposal.input])
    }

    func testSessionSnapshotKeepsBoundedTraceForOneAttempt() async throws {
        let adapter = FakeGameAdapter(frames: [
            GameFrame(id: "frame-1", fingerprint: "before"),
            GameFrame(id: "frame-2", fingerprint: "after")
        ])
        let session = GameSession(adapter: adapter)

        try await session.connect()
        _ = try await session.observe()
        try await session.propose(
            GameInput(events: [.key(code: 49, down: true)]),
            intent: "take one practice action"
        )
        try await session.authorizeControl()
        try await session.issueProposedInput()
        _ = try await session.verify()

        let trace = (await session.snapshot()).trace.events
        XCTAssertEqual(trace, [
            .connected,
            .observed(frameID: "frame-1", fingerprint: "before"),
            .proposed(intent: "take one practice action", eventCount: 1),
            .authorized,
            .issued(intent: "take one practice action"),
            .verified(intent: "take one practice action", changed: true)
        ])
    }

    func testTraceRetainsOnlyMostRecentBoundedEvents() {
        let events = (0..<GameTrace.maxEvents + 3).map { _ in GameTraceEvent.connected }
        let trace = GameTrace(events: events)

        XCTAssertEqual(trace.events.count, GameTrace.maxEvents)
    }

    func testMoveCommandPlannerBuildsBoundedKeyboardAndMouseInput() async throws {
        let planner = try GameMoveCommandPlanner(command: "press enter then click 120 240")
        let proposal = try await planner.proposeMove(
            from: GameFrame(id: "frame-1", fingerprint: "menu")
        )

        XCTAssertEqual(proposal.intent, "press enter then click 120 240")
        XCTAssertEqual(proposal.input.events, [
            .key(code: 36, down: true),
            .key(code: 36, down: false),
            .click(x: 120, y: 240)
        ])
    }

    func testMoveCommandPlannerRejectsUnboundedOrUnknownInput() {
        XCTAssertThrowsError(try GameMoveCommandPlanner(command: "press banana")) { error in
            XCTAssertEqual(error as? GameMoveCommandError, .unsupportedKey)
        }
        XCTAssertThrowsError(try GameMoveCommandPlanner(command: "click 1 2 then click 3 4 then click 5 6 then click 7 8 then click 9 10")) { error in
            XCTAssertEqual(error as? GameMoveCommandError, .tooManyEvents)
        }
    }
}

private struct FixedMovePlanner: GameMovePlanner {
    let proposal: GameMoveProposal

    func proposeMove(from _: GameFrame) async throws -> GameMoveProposal {
        proposal
    }
}

private final class FakeGameAdapter: GameAdapter, @unchecked Sendable {
    let name = "Fake game"
    private var frames: [GameFrame]
    private(set) var sentInputs: [GameInput] = []

    init(frames: [GameFrame]) {
        self.frames = frames
    }

    func observe() async throws -> GameFrame {
        guard !frames.isEmpty else { throw FakeAdapterError.noFrame }
        return frames.removeFirst()
    }

    func send(_ input: GameInput) async throws {
        sentInputs.append(input)
    }
}

private enum FakeAdapterError: Error {
    case noFrame
}
