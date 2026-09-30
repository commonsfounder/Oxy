import SwiftUI

// MARK: - App icons (SF Symbols are banned — real bundled assets only)
//
// Every glyph is a template-rendered vector asset under Assets.xcassets/ic-*.
// Tint with `.foregroundStyle`. Never use Image(systemName:) anywhere.

struct AppIcon: View {
    let name: String
    var size: CGFloat
    var weight: Font.Weight

    init(_ name: String, size: CGFloat = 16, weight: Font.Weight = .regular) {
        self.name = name
        self.size = size
        self.weight = weight
    }

    /// Convenience for migrating `Image(systemName:)` call sites — pass the old SF
    /// name and it resolves to the bundled asset. No SF Symbol is ever rendered.
    init(sf: String, size: CGFloat = 16, weight: Font.Weight = .regular) {
        self.init(AppGlyph.map(sf), size: size, weight: weight)
    }

    var body: some View {
        Image("ic-\(name)")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

enum AppGlyph {
    /// Dynamic WeatherKit condition symbols → bundled weather icons.
    static func weather(_ sfName: String) -> String {
        let n = sfName.lowercased()
        if n.contains("rain") || n.contains("drizzle") || n.contains("storm") { return "cloud-rain" }
        if n.contains("snow") || n.contains("sleet") || n.contains("hail") { return "cloud-rain" }
        if n.contains("cloud") || n.contains("fog") || n.contains("haze") { return "cloud" }
        if n.contains("moon") || n.contains("night") || n.contains("stars") { return "moon" }
        return "sun"
    }

    /// Briefing/mission symbols (set as strings by HomeMissionBuilder) → icon keys.
    static func mission(_ sfName: String) -> String {
        switch sfName {
        case "bolt.fill": return "bolt"
        case "checkmark.circle.fill": return "check-circle"
        case "sparkles": return "sparkles"
        case "shippingbox.fill": return "box"
        case "calendar": return "calendar"
        case "envelope.fill": return "envelope"
        case "circle.dotted": return "dotted"
        default: return "sparkles"
        }
    }

    /// Full SF-name → bundled asset key map for migrating call sites. Strip the
    /// `.fill` variants to the same asset. Unknown names fall through to `mission`.
    static func map(_ sf: String) -> String {
        switch sf {
        case "chevron.right": return "chevron-right"
        case "chevron.left": return "chevron-left"
        case "chevron.down": return "chevron-down"
        case "chevron.up": return "chevron-up"
        case "chevron.up.chevron.down": return "chevron-updown"
        case "xmark": return "xmark"
        case "xmark.circle.fill", "xmark.circle": return "xmark-circle"
        case "plus": return "plus"
        case "checkmark": return "check"
        case "checkmark.circle.fill", "checkmark.circle": return "check-circle"
        case "exclamationmark": return "alert"
        case "exclamationmark.circle", "exclamationmark.circle.fill", "exclamationmark.triangle", "exclamationmark.triangle.fill": return "alert-circle"
        case "arrow.up.right": return "arrow-up-right"
        case "arrow.right", "arrow.right.circle.fill": return "arrow-right"
        case "arrow.up": return "arrow-up"
        case "arrow.clockwise", "arrow.triangle.2.circlepath": return "refresh"
        case "clock", "clock.fill": return "clock"
        case "clock.arrow.circlepath": return "history"
        case "square.and.pencil", "pencil": return "edit"
        case "magnifyingglass": return "search"
        case "wifi.slash": return "wifi-off"
        case "wifi.exclamationmark": return "wifi-alert"
        case "waveform": return "waveform"
        case "person.fill", "person", "person.crop.circle", "person.crop.circle.fill": return "person"
        case "person.crop.circle.badge.checkmark": return "person-check"
        case "line.3.horizontal", "line.horizontal.3": return "menu"
        case "car", "car.fill": return "car"
        case "list.bullet", "list.bullet.rectangle": return "list"
        case "map", "map.fill": return "map"
        case "ticket", "ticket.fill": return "ticket"
        case "trash", "trash.fill": return "trash"
        case "calendar": return "calendar"
        case "envelope", "envelope.fill": return "envelope"
        case "bubble.left", "bubble.left.fill", "message", "message.fill": return "chat"
        case "mic", "mic.fill": return "mic"
        case "location", "location.circle.fill", "location.fill": return "location"
        case "mappin", "mappin.circle.fill": return "pin"
        case "creditcard", "creditcard.fill": return "card"
        case "shippingbox", "shippingbox.fill": return "box"
        case "bolt", "bolt.fill": return "bolt"
        case "sparkles": return "sparkles"
        case "sun.max", "sun.max.fill": return "sun"
        case "cloud", "cloud.fill": return "cloud"
        case "photo", "photo.fill": return "photo"
        case "doc", "doc.fill", "doc.text", "doc.text.fill": return "doc"
        case "stop.fill", "stop": return "stop"
        default: return mission(sf)
        }
    }
}

// MARK: - Shared visual chrome

enum GlebChrome {
    static let ink = Color.appInk
    static let muted = Color.appMuted

    static var pastelBlob: some View {
        Color.appBackground
    }
}

// MARK: - Top chrome chips (weather + dual orbs + profile)
