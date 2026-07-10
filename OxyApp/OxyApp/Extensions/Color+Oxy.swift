import SwiftUI
import UIKit

extension Color {
    // Legacy aliases — forward to the rebuilt app* tokens so old call sites pick
    // up the new surfaces instead of pure black.
    static var oxyBg: Color { .appBackground }
    static var oxySurface1: Color { .appSurface }
    static var oxySurface2: Color { .appSurface }
    static var oxySurface3: Color { .appSurface2 }
    static var oxySurface4: Color { .appSurface2 }
    static var oxyLine: Color { .appHairline }
    static var oxyLine2: Color { .appHairline }
    static var oxyText: Color {
        dynamicColor(light: UIColor(red: 22/255, green: 22/255, blue: 21/255, alpha: 1),
                     dark: UIColor(red: 242/255, green: 242/255, blue: 242/255, alpha: 1))
    }
    static var oxySub: Color { .appMuted }
    static var oxyDim: Color { Color.appAdaptive(dark: .white, light: .black).opacity(0.55) }
    static var oxyOnAccent: Color { .appOnAccent }
    static let oxyDefaultStone = Color(red: 242/255, green: 242/255, blue: 242/255)
    static var oxyStone: Color { .appAccent }
    static var oxyAccent: Color { .appAccent }
    static func dynamicColor(light: UIColor, dark: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
    /// Green — #4CAF82
    static let oxyGreen = Color(red: 76/255, green: 175/255, blue: 130/255)
    /// Red — #C0503E
    static let oxyRed = Color(red: 192/255, green: 80/255, blue: 62/255)
}
