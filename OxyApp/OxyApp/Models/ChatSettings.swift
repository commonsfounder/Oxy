import Foundation

/// Server-side mirror of the chat_settings table (api/services/chat-settings.js) — decodes
/// GET /chat-settings so SettingsView can hydrate OxySettings.chatEffort/guardMode from the
/// server on appear (UserDefaults alone survives a relaunch but not a reinstall/new device).
struct ChatSettingsResponse: Codable {
    let effort: String
    let guardMode: Bool
}
