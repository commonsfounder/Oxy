import Foundation

public struct GameMoveProposal: Sendable, Equatable {
    public let input: GameInput
    public let intent: String

    public init(input: GameInput, intent: String) {
        self.input = input
        self.intent = String(intent.prefix(200))
    }
}

public struct GameMoveResult: Sendable, Equatable {
    public let intent: String
    public let verified: Bool

    public init(intent: String, verified: Bool) {
        self.intent = intent
        self.verified = verified
    }
}

public enum GameMovePipelineError: Error, Equatable {
    case noProposedMove
}

public protocol GameMovePlanner: Sendable {
    func proposeMove(from frame: GameFrame) async throws -> GameMoveProposal
}

/// The reasoning edge of a game session. Planners decide what one move means;
/// GameSession remains the only authority that can issue and verify it.
public actor GameMovePipeline {
    private let session: GameSession
    private let planner: any GameMovePlanner
    private var pendingProposal: GameMoveProposal?

    public init(session: GameSession, planner: any GameMovePlanner) {
        self.session = session
        self.planner = planner
    }

    public func proposeNextMove() async throws -> GameMoveProposal {
        let frame = try await session.observe()
        let proposal = try await planner.proposeMove(from: frame)
        try await session.propose(proposal.input, intent: proposal.intent)
        pendingProposal = proposal
        return proposal
    }

    public func issueNextMoveAndVerify() async throws -> GameMoveResult {
        guard let proposal = pendingProposal else {
            throw GameMovePipelineError.noProposedMove
        }

        try await session.issueProposedInput()
        let verified = try await session.verify()
        pendingProposal = nil
        return GameMoveResult(intent: proposal.intent, verified: verified)
    }
}
