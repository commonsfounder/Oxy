import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Shared shape of the pendant Live Activity. Lives in the main app so both the
/// app (which starts/updates/ends the activity) and a future Widget Extension
/// (which renders the Lock Screen / Dynamic Island UI) can reference the same
/// attributes.
///
/// NOTE: the visible Lock Screen / Dynamic Island surface requires adding a
/// Widget Extension target in Xcode that renders `PendantActivityAttributes`.
/// Until that target exists this manager is a safe no-op-on-failure: it requests
/// the activity (ignored if unsupported) and never crashes the app.
#if canImport(ActivityKit)
@available(iOS 16.1, *)
struct PendantActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Short status, e.g. "Listening", "Thinking", "Connected".
        var status: String
        /// Whether the pendant is actively capturing audio (drives the pulsing UI).
        var isListening: Bool
    }

    /// The pendant's display name — fixed for the life of the activity.
    var deviceName: String
}

/// Starts / updates / ends the pendant Live Activity, driven by the existing
/// `PendantBLEManager` connect/disconnect notifications so no other code needs
/// to change. Instantiate once at launch via `PendantLiveActivityManager.shared.begin()`.
@available(iOS 16.1, *)
@MainActor
final class PendantLiveActivityManager {
    static let shared = PendantLiveActivityManager()

    private var activity: Activity<PendantActivityAttributes>?
    private var observers: [NSObjectProtocol] = []
    private var started = false

    /// Begin observing pendant lifecycle notifications. Safe to call more than once.
    func begin() {
        guard !started else { return }
        started = true

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: PendantBLEManager.didConnect, object: nil, queue: .main) { _ in
            Task { @MainActor in self.start(status: "Connected", listening: false) }
        })
        observers.append(center.addObserver(forName: PendantBLEManager.didDisconnect, object: nil, queue: .main) { _ in
            Task { @MainActor in await self.end() }
        })
    }

    /// Reflect the pendant's listening state (call from the audio bridge when it flips).
    func setListening(_ listening: Bool) {
        Task { await update(status: listening ? "Listening" : "Connected", listening: listening) }
    }

    private func start(status: String, listening: Bool) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Reuse an existing activity if one is already live.
        if let existing = Activity<PendantActivityAttributes>.activities.first {
            activity = existing
            return
        }
        let attributes = PendantActivityAttributes(deviceName: "Oxy Pendant")
        let state = PendantActivityAttributes.ContentState(status: status, isListening: listening)
        do {
            activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil)
            )
        } catch {
            // Unsupported (no widget extension yet) or denied — ignore quietly.
            activity = nil
        }
    }

    private func update(status: String, listening: Bool) async {
        guard let activity else { return }
        let state = PendantActivityAttributes.ContentState(status: status, isListening: listening)
        await activity.update(.init(state: state, staleDate: nil))
    }

    private func end() async {
        guard let activity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        self.activity = nil
    }
}
#endif
