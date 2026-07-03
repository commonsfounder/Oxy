import AppIntents
import Foundation

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
    static let title: LocalizedStringResource = "Ask Oxy"
    static let description = IntentDescription("Ask Oxy a question or give it a task by voice.")

    /// Bring the app to the foreground — the chat surface handles the request.
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Request", requestValueDialog: "What should I ask Oxy?")
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
    static let title: LocalizedStringResource = "Open Oxy"
    static let description = IntentDescription("Open Oxy and start a conversation.")
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
            shortTitle: "Ask Oxy",
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: OpenOxyIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Start a conversation with \(.applicationName)"
            ],
            shortTitle: "Open Oxy",
            systemImageName: "sparkles"
        )
    }
}
