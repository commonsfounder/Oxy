import Foundation
import UIKit

/// Changes to the app's own settings that Adam makes when you ask in chat ("make it dark", "stop the daily check-ins").
@MainActor
enum ClientEffects {
    static func applyAll(_ results: [ActionResult], userId: String) {
        for effect in results.compactMap(\.clientEffect) {
            Task {
                if needsApproval(effect), await !approved(effect) { return }
                await apply(effect, userId: userId)
            }
        }
    }

    /// Anything that gives Adam more freedom or access is confirmed on the phone, so text in an email or web page cannot quietly switch it on.
    private static func needsApproval(_ effect: ClientEffect) -> Bool {
        switch (effect.setting, effect.value) {
        case ("ask_before_acting", "off"), ("ask_before_private_apps", "off"),
             ("how_proactive", "proactive"), ("how_proactive", "autonomous"),
             ("learn_from_photos", "on"), ("listen_for_sounds", "on"):
            return true
        default:
            return false
        }
    }

    private static func approved(_ effect: ClientEffect) async -> Bool {
        let question: String
        switch (effect.setting, effect.value) {
        case ("ask_before_acting", _): question = "Stop asking before I act?"
        case ("ask_before_private_apps", _): question = "Open private apps without asking?"
        case ("how_proactive", _): question = "Let me do more on my own?"
        case ("learn_from_photos", _): question = "Look through your photos?"
        default: question = "Listen for alarms and doorbells?"
        }
        guard let top = topController() else { return false }
        return await withCheckedContinuation { cont in
            let alert = UIAlertController(title: question, message: "You asked me to in chat. Only say yes if that was you.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in cont.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "Yes", style: .default) { _ in cont.resume(returning: true) })
            top.present(alert, animated: true)
        }
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    static func apply(_ effect: ClientEffect, userId: String) async {
        let value = effect.value
        let on = value == "on"
        var settings = SettingsStore.load()
        switch effect.setting {
        case "appearance":
            UserDefaults.standard.set(value, forKey: ThreadBackground.storageKey)
        case "maps_app":
            settings.preferredMapsApp = value
            SettingsStore.save(settings, userId: userId)
        case "how_proactive":
            settings.autonomy = value.capitalized
            SettingsStore.save(settings, userId: userId)
        case "ask_before_acting":
            settings.guardMode = on
            SettingsStore.save(settings, userId: userId)
        case "ask_before_private_apps":
            settings.confirmSensitiveAppOpens = on
            SettingsStore.save(settings, userId: userId)
        case "alert_arriving_leaving":
            settings.locationReminders = on
            SettingsStore.save(settings, userId: userId)
        case "daily_check_in":
            settings.proactiveBriefings = on
            SettingsStore.save(settings, userId: userId)
        case "listen_for_sounds":
            UserDefaults.standard.set(on, forKey: HouseholdSoundMonitor.preferenceKey)
            await HouseholdSoundMonitor.shared.setEnabled(on, userId: userId)
        case "learn_from_photos":
            if value == "off" {
                UserDefaults.standard.set(false, forKey: PhotoLearner.enabledKey)
                return
            }
            guard await PhotoLearner.shared.requestAccess() else {
                UserDefaults.standard.set(false, forKey: PhotoLearner.enabledKey)
                return
            }
            UserDefaults.standard.set(true, forKey: PhotoLearner.enabledKey)
            await PhotoLearner.shared.run()
        default:
            break
        }
    }
}
