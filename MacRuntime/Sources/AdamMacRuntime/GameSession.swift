import Foundation

public enum GameSessionType: String, Sendable, Equatable {
    case singlePlayer = "single_player"
    case privateMultiplayer = "private_multiplayer"
    case publicCompetitive = "public_competitive"
}

public enum GamePlayMode: String, Sendable, Equatable {
    case assist
    case control
}

public enum GameSessionPhase: String, Sendable, Equatable {
    case disconnected
    case observing
    case ready
    case verifying
    case paused
}

public enum GameSessionOutcome: String, Sendable, Equatable {
    case verified
    case noVerifiedChange = "no_verified_change"
}

/// Bounded metadata for replay and evaluation. It deliberately excludes captured pixels.
public enum GameTraceEvent: Sendable, Equatable {
    case connected
    case observed(frameID: String, fingerprint: String)
    case proposed(intent: String, eventCount: Int)
    case authorized
    case issued(intent: String)
    case verified(intent: String, changed: Bool)
    case paused
    case resumed
    case stopped
}

public struct GameTrace: Sendable, Equatable {
    public static let maxEvents = 64

    public let events: [GameTraceEvent]

    public init(events: [GameTraceEvent] = []) {
        self.events = Array(events.suffix(Self.maxEvents))
    }

    fileprivate func appending(_ event: GameTraceEvent) -> GameTrace {
        GameTrace(events: events + [event])
    }
}

public enum GameInputEvent: Sendable, Equatable {
    case key(code: UInt16, down: Bool)
    case click(x: Double, y: Double)
}

public struct GameInput: Sendable, Equatable {
    public let events: [GameInputEvent]

    public init(events: [GameInputEvent]) {
        self.events = events
    }
}

public struct GameFrame: Sendable, Equatable {
    public let id: String
    public let fingerprint: String
    public let imageData: Data?
    public let capturedAt: Date

    public init(
        id: String,
        fingerprint: String,
        imageData: Data? = nil,
        capturedAt: Date = Date()
    ) {
        self.id = id
        self.fingerprint = fingerprint
        self.imageData = imageData
        self.capturedAt = capturedAt
    }
}

public protocol GameAdapter {
    var name: String { get }
    func observe() async throws -> GameFrame
    func send(_ input: GameInput) async throws
}

public enum GameRuntimeError: Error, Equatable {
    case alreadyConnected
    case notConnected
    case sessionPaused
    case noObservation
    case noProposedInput
    case controlNotAuthorized
    case controlNotAllowedForPublicPlay
    case verificationNotReady
    case emptyInput
}

public struct GameSessionSnapshot: Sendable, Equatable {
    public let adapterName: String
    public let phase: GameSessionPhase
    public let mode: GamePlayMode
    public let sessionType: GameSessionType
    public let lastFrameID: String?
    public let lastOutcome: GameSessionOutcome?
    public let actionsIssued: Int
    public let trace: GameTrace

    public init(
        adapterName: String,
        phase: GameSessionPhase,
        mode: GamePlayMode,
        sessionType: GameSessionType,
        lastFrameID: String?,
        lastOutcome: GameSessionOutcome?,
        actionsIssued: Int,
        trace: GameTrace = GameTrace()
    ) {
        self.adapterName = adapterName
        self.phase = phase
        self.mode = mode
        self.sessionType = sessionType
        self.lastFrameID = lastFrameID
        self.lastOutcome = lastOutcome
        self.actionsIssued = actionsIssued
        self.trace = trace
    }
}

public actor GameSession {
    private struct ProposedInput {
        let input: GameInput
        let intent: String
    }

    private let adapter: any GameAdapter
    private let sessionType: GameSessionType
    private var phase: GameSessionPhase = .disconnected
    private var mode: GamePlayMode = .assist
    private var lastFrame: GameFrame?
    private var proposedInput: ProposedInput?
    private var lastOutcome: GameSessionOutcome?
    private var actionsIssued = 0
    private var trace = GameTrace()

    public init(adapter: any GameAdapter, sessionType: GameSessionType = .singlePlayer) {
        self.adapter = adapter
        self.sessionType = sessionType
    }

    public func connect() throws {
        guard phase == .disconnected else { throw GameRuntimeError.alreadyConnected }
        phase = .observing
        lastOutcome = nil
        trace = trace.appending(.connected)
    }

    @discardableResult
    public func observe() async throws -> GameFrame {
        try requireActive()
        let frame = try await adapter.observe()
        lastFrame = frame
        proposedInput = nil
        phase = .observing
        trace = trace.appending(.observed(frameID: frame.id, fingerprint: frame.fingerprint))
        return frame
    }

    public func propose(_ input: GameInput, intent: String) throws {
        try requireActive()
        guard lastFrame != nil else { throw GameRuntimeError.noObservation }
        guard !input.events.isEmpty else { throw GameRuntimeError.emptyInput }

        proposedInput = ProposedInput(input: input, intent: String(intent.prefix(200)))
        lastOutcome = nil
        phase = .ready
        trace = trace.appending(.proposed(intent: String(intent.prefix(200)), eventCount: input.events.count))
    }

    public func authorizeControl() throws {
        try requireActive()
        guard sessionType != .publicCompetitive else {
            throw GameRuntimeError.controlNotAllowedForPublicPlay
        }
        mode = .control
        trace = trace.appending(.authorized)
    }

    public func issueProposedInput() async throws {
        try requireActive()
        guard mode == .control else { throw GameRuntimeError.controlNotAuthorized }
        guard phase == .ready, let proposedInput else {
            throw GameRuntimeError.noProposedInput
        }

        try await adapter.send(proposedInput.input)
        phase = .verifying
        actionsIssued += 1
        lastOutcome = nil
        trace = trace.appending(.issued(intent: proposedInput.intent))
    }

    @discardableResult
    public func verify() async throws -> Bool {
        guard phase == .verifying, let before = lastFrame else {
            throw GameRuntimeError.verificationNotReady
        }

        let after = try await adapter.observe()
        lastFrame = after
        proposedInput = nil
        phase = .observing
        let changed = before.fingerprint != after.fingerprint
        lastOutcome = changed ? .verified : .noVerifiedChange
        if case let .issued(intent: intent) = trace.events.last {
            trace = trace.appending(.verified(intent: intent, changed: changed))
        }
        return changed
    }

    public func pause() {
        guard phase != .disconnected, phase != .paused else { return }
        phase = .paused
        proposedInput = nil
        trace = trace.appending(.paused)
    }

    public func resume() throws {
        guard phase == .paused else { throw GameRuntimeError.sessionPaused }
        phase = .observing
        trace = trace.appending(.resumed)
    }

    public func stop() {
        phase = .disconnected
        lastFrame = nil
        proposedInput = nil
        lastOutcome = nil
        mode = .assist
        trace = trace.appending(.stopped)
    }

    public func snapshot() -> GameSessionSnapshot {
        GameSessionSnapshot(
            adapterName: adapter.name,
            phase: phase,
            mode: mode,
            sessionType: sessionType,
            lastFrameID: lastFrame?.id,
            lastOutcome: lastOutcome,
            actionsIssued: actionsIssued,
            trace: trace
        )
    }

    private func requireActive() throws {
        if phase == .disconnected { throw GameRuntimeError.notConnected }
        if phase == .paused { throw GameRuntimeError.sessionPaused }
    }
}
