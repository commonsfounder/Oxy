import Foundation

public enum GameMoveCommandError: Error, Equatable {
    case emptyCommand
    case malformedCommand
    case unsupportedKey
    case invalidCoordinates
    case tooManyEvents
}

/// Small deterministic planner used by the Mac host until a visual game planner is connected.
/// It accepts only bounded keyboard and mouse commands; it never executes anything itself.
public struct GameMoveCommandPlanner: GameMovePlanner {
    private static let maxCommands = 4
    private static let keyCodes: [String: UInt16] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6, "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "space": 49,
        "enter": 36, "return": 36, "escape": 53, "esc": 53, "tab": 48,
        "up": 126, "down": 125, "left": 123, "right": 124
    ]

    public let command: String
    private let input: GameInput

    public init(command: String) throws {
        let normalized = command.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !normalized.isEmpty else { throw GameMoveCommandError.emptyCommand }

        let rawCommands = Self.splitCommands(normalized)
        guard !rawCommands.isEmpty else { throw GameMoveCommandError.malformedCommand }
        guard rawCommands.count <= Self.maxCommands else { throw GameMoveCommandError.tooManyEvents }

        var events: [GameInputEvent] = []
        for rawCommand in rawCommands {
            let parts = rawCommand.split(separator: " ").map(String.init)
            guard let verb = parts.first?.lowercased() else {
                throw GameMoveCommandError.malformedCommand
            }
            switch verb {
            case "press":
                guard parts.count == 2, let code = Self.keyCodes[parts[1].lowercased()] else {
                    throw parts.count == 2 ? GameMoveCommandError.unsupportedKey : .malformedCommand
                }
                events.append(.key(code: code, down: true))
                events.append(.key(code: code, down: false))
            case "click":
                guard parts.count == 3,
                      let x = Double(parts[1]),
                      let y = Double(parts[2]),
                      x.isFinite,
                      y.isFinite,
                      x >= 0,
                      y >= 0,
                      x <= 10_000,
                      y <= 10_000 else {
                    throw GameMoveCommandError.invalidCoordinates
                }
                events.append(.click(x: x, y: y))
            default:
                throw GameMoveCommandError.malformedCommand
            }
        }

        guard !events.isEmpty, events.count <= 8 else { throw GameMoveCommandError.tooManyEvents }
        self.command = normalized
        self.input = GameInput(events: events)
    }

    public func proposeMove(from _: GameFrame) async throws -> GameMoveProposal {
        GameMoveProposal(input: input, intent: command)
    }

    private static func splitCommands(_ command: String) -> [String] {
        command
            .replacingOccurrences(of: " then ", with: "|", options: .caseInsensitive)
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
}
