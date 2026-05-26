import SwiftUI

extension Color {
    /// Background — #0C0C0C
    static var oxyBg: Color {
        oxyTheme == "softDark"
            ? Color(red: 17/255, green: 18/255, blue: 20/255)
            : Color(red: 12/255, green: 12/255, blue: 12/255)
    }
    /// Surface 1 — #151515
    static var oxySurface1: Color {
        oxyTheme == "softDark"
            ? Color(red: 25/255, green: 27/255, blue: 30/255)
            : Color(red: 21/255, green: 21/255, blue: 21/255)
    }
    /// Surface 2 — #1E1E1E
    static var oxySurface2: Color {
        oxyTheme == "softDark"
            ? Color(red: 34/255, green: 37/255, blue: 41/255)
            : Color(red: 30/255, green: 30/255, blue: 30/255)
    }
    /// Surface 3 — #282828
    static var oxySurface3: Color {
        oxyTheme == "softDark"
            ? Color(red: 45/255, green: 49/255, blue: 54/255)
            : Color(red: 40/255, green: 40/255, blue: 40/255)
    }
    /// Surface 4 — #333333
    static var oxySurface4: Color {
        oxyTheme == "softDark"
            ? Color(red: 57/255, green: 62/255, blue: 68/255)
            : Color(red: 51/255, green: 51/255, blue: 51/255)
    }
    /// Line — rgba(255,255,255,0.06)
    static let oxyLine = Color.white.opacity(0.06)
    /// Line 2 — rgba(255,255,255,0.10)
    static let oxyLine2 = Color.white.opacity(0.10)
    /// Primary text — #F2F2F2
    static let oxyText = Color(red: 242/255, green: 242/255, blue: 242/255)
    /// Subtitle — #888888
    static let oxySub = Color(red: 136/255, green: 136/255, blue: 136/255)
    /// Dim — #505050
    static let oxyDim = Color(red: 80/255, green: 80/255, blue: 80/255)
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
        case "mono": return Color(red: 242/255, green: 242/255, blue: 242/255)
        default: return oxyDefaultStone
        }
    }
    private static var oxyTheme: String {
        (oxySettingsObject?["appTheme"] as? String) ?? "trueBlack"
    }
    private static var oxySettingsObject: [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings") else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    /// Green — #4CAF82
    static let oxyGreen = Color(red: 76/255, green: 175/255, blue: 130/255)
    /// Red — #C0503E
    static let oxyRed = Color(red: 192/255, green: 80/255, blue: 62/255)
}
