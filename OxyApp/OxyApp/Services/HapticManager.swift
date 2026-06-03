import UIKit
import Foundation

/// Centralised haptic feedback. Generators are pre-prepared so the taptic
/// engine fires with minimal latency. All calls are no-ops when the user has
/// disabled haptics (UserDefaults key `oxy_haptics`, defaults to on) and on
/// devices without a Taptic Engine (the generators simply do nothing).
@MainActor
final class HapticManager {
    static let shared = HapticManager()

    enum Impact { case light, medium, heavy, soft, rigid }

    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let notifier = UINotificationFeedbackGenerator()
    private let selector = UISelectionFeedbackGenerator()

    private var observers: [NSObjectProtocol] = []

    private var enabled: Bool {
        UserDefaults.standard.object(forKey: "oxy_haptics") as? Bool ?? true
    }

    private init() {
        prepare()

        // Pendant lifecycle feedback, fired from anywhere in the app.
        observers.append(NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in HapticManager.shared.success() }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didDisconnect, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in HapticManager.shared.impact(.rigid) }
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    /// Warm up the taptic engine. Safe to call repeatedly (e.g. on app launch).
    func prepare() {
        light.prepare(); medium.prepare(); heavy.prepare()
        soft.prepare(); rigid.prepare()
        notifier.prepare(); selector.prepare()
    }

    func impact(_ style: Impact = .light) {
        guard enabled else { return }
        let generator: UIImpactFeedbackGenerator
        switch style {
        case .light: generator = light
        case .medium: generator = medium
        case .heavy: generator = heavy
        case .soft: generator = soft
        case .rigid: generator = rigid
        }
        generator.impactOccurred()
        generator.prepare()
    }

    func success() {
        guard enabled else { return }
        notifier.notificationOccurred(.success)
        notifier.prepare()
    }

    func warning() {
        guard enabled else { return }
        notifier.notificationOccurred(.warning)
        notifier.prepare()
    }

    func error() {
        guard enabled else { return }
        notifier.notificationOccurred(.error)
        notifier.prepare()
    }

    /// Light tick for discrete selection changes (tab switches, pickers).
    func select() {
        guard enabled else { return }
        selector.selectionChanged()
        selector.prepare()
    }
}
