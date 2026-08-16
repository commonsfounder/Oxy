import AppIntents
import Foundation

/// The small, version-one command vocabulary the pendant can emit. These are
/// control frames, never user text or audio, and they all remain local until a
/// normal chat/approval path decides whether an external action may run.
enum PendantCommand: Equatable, Sendable {
    case openChat
    case startRecording
    case stopRecording
    case toggleRecording
    case sendMessage
    case confirm
    case cancel
    case connected
    case pong

    static func parse(_ data: Data) -> PendantCommand? {
        // Raw PCM is arbitrary binary. Only small, clean UTF-8 frames are
        // eligible as commands, so microphone audio cannot become a control.
        guard data.count <= 32,
              let text = String(data: data, encoding: .utf8) else { return nil }
        switch text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
        case "OPEN_CHAT", "CHAT": return .openChat
        case "SOUND_WAKE", "START_RECORDING", "START": return .startRecording
        case "STOP_RECORDING", "STOP": return .stopRecording
        case "TOGGLE_RECORDING", "TOGGLE": return .toggleRecording
        case "SEND_MESSAGE", "SEND": return .sendMessage
        case "CONFIRM", "YES", "OK": return .confirm
        case "CANCEL", "NO", "REJECT": return .cancel
        case "CONNECTED": return .connected
        case "PONG": return .pong
        default: return nil
        }
    }

    var wireValue: String {
        switch self {
        case .openChat: return "OPEN_CHAT"
        case .startRecording: return "START_RECORDING"
        case .stopRecording: return "STOP_RECORDING"
        case .toggleRecording: return "TOGGLE_RECORDING"
        case .sendMessage: return "SEND_MESSAGE"
        case .confirm: return "CONFIRM"
        case .cancel: return "CANCEL"
        case .connected: return "CONNECTED"
        case .pong: return "PONG"
        }
    }

    var needsChat: Bool {
        switch self {
        case .connected, .pong: return false
        default: return true
        }
    }
}

/// Retains the most recent pendant command while ChatHome opens. BLE callbacks
/// can arrive before SwiftUI has installed the chat receiver, especially after
/// a button press from the Home screen.
final class PendantCommandBus: @unchecked Sendable {
    static let shared = PendantCommandBus()
    private let lock = NSLock()
    private var pendingCommand: PendantCommand?

    func deliver(_ command: PendantCommand) {
        guard command.needsChat else { return }
        lock.lock()
        pendingCommand = command
        lock.unlock()
        NotificationCenter.default.post(
            name: .oxyPendantCommand,
            object: nil,
            userInfo: ["command": command.wireValue]
        )
        NotificationCenter.default.post(name: .oxyJumpToChat, object: nil)
    }

    func take() -> PendantCommand? {
        lock.lock()
        defer { lock.unlock() }
        let command = pendingCommand
        pendingCommand = nil
        return command
    }
}

/// A tiny hand-off bus between an App Intent (which may run before any view is
/// alive) and `ChatHomeView`. The intent drops a query here and posts a
/// notification; the chat surface drains it on appear and on notification, so a
/// cold-launch-from-Siri never loses the request.
final class SiriRequestBus: @unchecked Sendable {
    static let shared = SiriRequestBus()
    private let lock = NSLock()
    private var _pendingQuery: String?

    var pendingQuery: String? {
        get { lock.lock(); defer { lock.unlock() }; return _pendingQuery }
        set { lock.lock(); _pendingQuery = newValue; lock.unlock() }
    }

    /// Pops the pending query (returns it once, then clears it).
    func take() -> String? {
        lock.lock(); defer { lock.unlock() }
        let q = _pendingQuery
        _pendingQuery = nil
        return q
    }
}

/// "Ask Oxy …" — the primary Siri / Shortcuts / Action Button entry point. Opens
/// the app to a fresh chat and sends the spoken query straight through the
/// normal chat pipeline (so streaming, TTS, actions and review all still apply).
struct AskOxyIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Milgrain"
    static let description = IntentDescription("Ask Milgrain a question or give it a task by voice.")

    /// Bring the app to the foreground — the chat surface handles the request.
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Request", requestValueDialog: "What should I ask Milgrain?")
    var query: String

    @MainActor
    func perform() async throws -> some IntentResult {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            // Bus is the cold-launch fallback (drained in ChatView.task); the
            // notification handles the warm case where a ChatView is already alive.
            SiriRequestBus.shared.pendingQuery = trimmed
            NotificationCenter.default.post(name: .oxyJumpToChat, object: nil)
            NotificationCenter.default.post(name: .oxyVoiceMessage, object: nil, userInfo: ["text": trimmed])
        }
        return .result()
    }
}

/// "Open Oxy" — just launches the app to the chat tab. Lightweight counterpart
/// for the Action Button / a simple Shortcut.
struct OpenOxyIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Milgrain"
    static let description = IntentDescription("Open Milgrain and start a conversation.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .oxyJumpToChat, object: nil)
        return .result()
    }
}

/// Surfaces the intents to Siri, Spotlight and the Shortcuts app with spoken
/// trigger phrases. `\(.applicationName)` resolves to the app's display name.
struct OxyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskOxyIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Talk to \(.applicationName)"
            ],
            shortTitle: "Ask Milgrain",
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: OpenOxyIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Start a conversation with \(.applicationName)"
            ],
            shortTitle: "Open Milgrain",
            systemImageName: "sparkles"
        )
    }
}
