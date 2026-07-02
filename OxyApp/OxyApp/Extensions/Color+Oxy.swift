import SwiftUI
import UIKit

extension Color {
    /// Background. Dark stays true black; Light/System adapt to the user's appearance.
    static var oxyBg: Color {
        dynamicColor(light: UIColor(red: 247/255, green: 247/255, blue: 244/255, alpha: 1),
                     dark: UIColor(red: 12/255, green: 12/255, blue: 12/255, alpha: 1))
    }
    /// Surface 1.
    static var oxySurface1: Color {
        dynamicColor(light: UIColor(red: 255/255, green: 255/255, blue: 252/255, alpha: 1),
                     dark: UIColor(red: 21/255, green: 21/255, blue: 21/255, alpha: 1))
    }
    /// Surface 2.
    static var oxySurface2: Color {
        dynamicColor(light: UIColor(red: 239/255, green: 239/255, blue: 235/255, alpha: 1),
                     dark: UIColor(red: 30/255, green: 30/255, blue: 30/255, alpha: 1))
    }
    /// Surface 3.
    static var oxySurface3: Color {
        dynamicColor(light: UIColor(red: 226/255, green: 226/255, blue: 221/255, alpha: 1),
                     dark: UIColor(red: 40/255, green: 40/255, blue: 40/255, alpha: 1))
    }
    /// Surface 4.
    static var oxySurface4: Color {
        dynamicColor(light: UIColor(red: 211/255, green: 211/255, blue: 205/255, alpha: 1),
                     dark: UIColor(red: 51/255, green: 51/255, blue: 51/255, alpha: 1))
    }
    static var oxyLine: Color {
        dynamicColor(light: UIColor.black.withAlphaComponent(0.08),
                     dark: UIColor.white.withAlphaComponent(0.06))
    }
    static var oxyLine2: Color {
        dynamicColor(light: UIColor.black.withAlphaComponent(0.12),
                     dark: UIColor.white.withAlphaComponent(0.10))
    }
    static var oxyText: Color {
        dynamicColor(light: UIColor(red: 22/255, green: 22/255, blue: 21/255, alpha: 1),
                     dark: UIColor(red: 242/255, green: 242/255, blue: 242/255, alpha: 1))
    }
    static var oxySub: Color {
        dynamicColor(light: UIColor(red: 99/255, green: 99/255, blue: 94/255, alpha: 1),
                     dark: UIColor(red: 136/255, green: 136/255, blue: 136/255, alpha: 1))
    }
    static var oxyDim: Color {
        dynamicColor(light: UIColor(red: 145/255, green: 145/255, blue: 138/255, alpha: 1),
                     dark: UIColor(red: 80/255, green: 80/255, blue: 80/255, alpha: 1))
    }
    static var oxyOnAccent: Color {
        Color(red: 12/255, green: 12/255, blue: 12/255)
    }
    /// Stone accent — #C8B89A
    static let oxyDefaultStone = Color(red: 200/255, green: 184/255, blue: 154/255)
    static var oxyStone: Color { oxyAccent }
    static var oxyAccent: Color {
        guard let object = oxySettingsObject,
              let accent = object["accentColor"] as? String else {
            return oxyDefaultStone
        }
        switch accent {
        case "mint": return Color(red: 76/255, green: 175/255, blue: 130/255)
        case "blue": return Color(red: 92/255, green: 154/255, blue: 245/255)
        case "rose": return Color(red: 230/255, green: 124/255, blue: 154/255)
        case "violet": return Color(red: 162/255, green: 132/255, blue: 245/255)
        case "cyan": return Color(red: 48/255, green: 184/255, blue: 210/255)
        case "amber": return Color(red: 236/255, green: 168/255, blue: 65/255)
        case "coral": return Color(red: 238/255, green: 112/255, blue: 92/255)
        case "indigo": return Color(red: 105/255, green: 126/255, blue: 235/255)
        default: return oxyDefaultStone
        }
    }
    private static var oxySettingsObject: [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings") else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    // App is dark-only — no light/system appearance. The `light:` arm is kept so
    // callers don't have to change, but it's never used.
    static func dynamicColor(light: UIColor, dark: UIColor) -> Color {
        _ = light
        return Color(dark)
    }
    /// Green — #4CAF82
    static let oxyGreen = Color(red: 76/255, green: 175/255, blue: 130/255)
    /// Red — #C0503E
    static let oxyRed = Color(red: 192/255, green: 80/255, blue: 62/255)
}
