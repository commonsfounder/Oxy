import Foundation
import HomeKit

// MARK: - HomeKit Integration
// Requires: NSHomeKitUsageDescription in Info.plist + com.apple.developer.homekit entitlement.
// Control flow: NativeIntegrationManager intercepts HomeKit commands locally (same pattern as music)
// before the server is called. Device list is included in syncNativeContext so the AI can reason
// about what accessories the user has.

extension NativeIntegrationManager: HMHomeManagerDelegate {
    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        // Homes ready; direct queries hit homeManager.homes
    }
}

extension NativeIntegrationManager {

    // MARK: - Setup

    func setupHomeKit() {
        homeManager.delegate = self
    }

    // MARK: - Detection

    func isHomeKitRequest(_ message: String) -> Bool {
        let lower = message.lowercased()
        let hasDeviceWord =
            lower.contains("light") || lower.contains("lamp") ||
            lower.contains("thermostat") || lower.contains("lock") ||
            lower.contains("plug") || lower.contains("fan") ||
            lower.contains("blind") || lower.contains("curtain") ||
            lower.contains("shutter") || lower.contains("garage") ||
            lower.contains("scene")
        let hasActionWord =
            lower.hasPrefix("turn ") || lower.hasPrefix("switch ") ||
            lower.hasPrefix("set ") || lower.hasPrefix("dim ") ||
            lower.hasPrefix("lock ") || lower.hasPrefix("unlock ") ||
            lower.hasPrefix("activate ") || lower.hasPrefix("run ") ||
            lower.range(of: #"\bbrightness\b"#, options: .regularExpression) != nil
        return hasDeviceWord && hasActionWord
    }

    // MARK: - Execution

    func executeHomeKitCommand(_ message: String) async -> NativeLocalActionResult? {
        guard let home = homeManager.primaryHome ?? homeManager.homes.first else { return nil }
        let lower = message.lowercased()

        // Scene: "activate good morning" / "run movie scene"
        if lower.hasPrefix("activate ") || (lower.hasPrefix("run ") && lower.contains("scene")) {
            let sceneName = lower
                .replacingOccurrences(of: #"^(activate|run)\s+(the\s+)?"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"\s*scene$"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let scene = home.actionSets.first(where: { matchesName($0.name, query: sceneName) }) {
                do {
                    try await home.executeActionSet(scene)
                    return NativeLocalActionResult(action: "control_homekit", text: "Scene \"\(scene.name)\" activated.",
                                                  cardText: scene.name, actionSummary: "Scene activated", deepLink: nil)
                } catch {
                    return homeKitError("Couldn't activate scene \"\(scene.name)\".", error: error)
                }
            }
        }

        // Brightness: "dim the lights to 50%" / "set brightness to 80%"
        if lower.contains("dim") || lower.range(of: #"\d+\s*%"#, options: .regularExpression) != nil {
            let brightness = brightnessValue(from: lower)
            let query = stripBrightnessWords(from: lower, brightness: brightness)
            if let service = firstService(matching: query, types: [HMServiceTypeLightbulb], in: home),
               let char = service.characteristics.first(where: { $0.characteristicType == HMCharacteristicTypeBrightness }) {
                do {
                    try await char.writeValue(brightness)
                    let name = service.accessory?.name ?? query
                    return NativeLocalActionResult(action: "control_homekit", text: "Set \(name) to \(brightness)%.",
                                                  cardText: "\(name) · \(brightness)%", actionSummary: "Brightness set", deepLink: nil)
                } catch {
                    return homeKitError("Couldn't set brightness.", error: error)
                }
            }
        }

        // Lock/unlock
        if lower.hasPrefix("lock ") || lower.hasPrefix("unlock ") {
            let isLocking = lower.hasPrefix("lock ")
            let query = lower
                .replacingOccurrences(of: #"^(lock|unlock)\s+(the\s+)?"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // ponytail: 0=unsecured, 1=secured per HMCharacteristicTypeLockMechanismTargetState
            let targetState: UInt8 = isLocking ? 1 : 0
            if let service = firstService(matching: query, types: [HMServiceTypeLockMechanism], in: home),
               let char = service.characteristics.first(where: { $0.characteristicType == HMCharacteristicTypeLockMechanismTargetState }) {
                do {
                    try await char.writeValue(targetState)
                    let name = service.accessory?.name ?? query
                    let verb = isLocking ? "Locked" : "Unlocked"
                    return NativeLocalActionResult(action: "control_homekit", text: "\(verb) \(name).",
                                                  cardText: "\(name) · \(verb)", actionSummary: "\(verb)", deepLink: nil)
                } catch {
                    return homeKitError("Couldn't \(isLocking ? "lock" : "unlock") \(query).", error: error)
                }
            }
        }

        // Turn on/off
        guard lower.contains("turn on") || lower.contains("turn off") ||
              lower.contains("switch on") || lower.contains("switch off") else { return nil }
        let powerOn = lower.contains("turn on") || lower.contains("switch on")
        let query = lower
            .replacingOccurrences(of: #"^(turn|switch)\s+(on|off)\s+(the\s+)?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(turn|switch)\s+(the\s+)?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+(on|off)$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let powerTypes = [HMServiceTypeLightbulb, HMServiceTypeSwitch, HMServiceTypeOutlet, HMServiceTypeFan]
        if let service = firstService(matching: query, types: powerTypes, in: home),
           let char = service.characteristics.first(where: { $0.characteristicType == HMCharacteristicTypePowerState }) {
            do {
                try await char.writeValue(powerOn)
                let name = service.accessory?.name ?? query
                return NativeLocalActionResult(action: "control_homekit",
                                              text: "\(powerOn ? "Turned on" : "Turned off") \(name).",
                                              cardText: "\(name) · \(powerOn ? "On" : "Off")",
                                              actionSummary: powerOn ? "Light on" : "Light off",
                                              deepLink: nil)
            } catch {
                return homeKitError("Couldn't \(powerOn ? "turn on" : "turn off") \(query).", error: error)
            }
        }
        return nil
    }

    // MARK: - Device list for AI context

    func homeKitDeviceList() -> [[String: String]] {
        guard let home = homeManager.primaryHome ?? homeManager.homes.first else { return [] }
        var seen = Set<String>()
        return home.accessories.compactMap { accessory in
            guard seen.insert(accessory.name).inserted else { return nil }
            let type = accessory.services.compactMap { homeKitServiceLabel($0.serviceType) }.first ?? "accessory"
            let room = home.room(for: accessory)?.name ?? ""
            return ["name": accessory.name, "type": type, "room": room]
        }
    }

    // MARK: - Helpers

    private func matchesName(_ name: String, query: String) -> Bool {
        let n = name.lowercased(); let q = query.lowercased()
        return n.contains(q) || q.contains(n)
    }

    private func firstService(matching query: String, types: [String], in home: HMHome) -> HMService? {
        let normalized = query.lowercased()
        let typeSet = Set(types)
        return home.accessories
            .filter { normalized.isEmpty || matchesName($0.name, query: normalized) }
            .flatMap { $0.services }
            .first { typeSet.contains($0.serviceType) }
    }

    private func brightnessValue(from text: String) -> Int {
        guard let match = text.range(of: #"(\d+)\s*%"#, options: .regularExpression),
              let numMatch = text[match].range(of: #"\d+"#, options: .regularExpression),
              let val = Int(text[numMatch]) else { return 50 }
        return min(max(val, 0), 100)
    }

    private func stripBrightnessWords(from text: String, brightness: Int) -> String {
        text
            .replacingOccurrences(of: #"\b(dim|set|the|to|brightness|\d+\s*%)\b"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func homeKitServiceLabel(_ serviceType: String) -> String? {
        switch serviceType {
        case HMServiceTypeLightbulb:        return "light"
        case HMServiceTypeSwitch:           return "switch"
        case HMServiceTypeOutlet:           return "outlet"
        case HMServiceTypeLockMechanism:    return "lock"
        case HMServiceTypeThermostat:       return "thermostat"
        case HMServiceTypeFan:              return "fan"
        case HMServiceTypeGarageDoorOpener: return "garage"
        case HMServiceTypeWindowCovering:   return "blinds"
        default:                            return nil
        }
    }

    private func homeKitError(_ message: String, error: Error) -> NativeLocalActionResult {
        NativeLocalActionResult(action: "control_homekit", text: message, cardText: message,
                                actionSummary: "HomeKit error", deepLink: nil,
                                success: false, error: error.localizedDescription)
    }
}
