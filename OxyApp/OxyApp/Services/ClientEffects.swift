import Foundation

/// Changes to the app's own settings that Adam makes when you ask in chat ("make it dark", "stop the daily check-ins").
@MainActor
enum ClientEffects {
    static func applyAll(_ results: [ActionResult], userId: String) {
        for effect in results.compactMap(\.clientEffect) {
            Task { await apply(effect, userId: userId) }
        }
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
