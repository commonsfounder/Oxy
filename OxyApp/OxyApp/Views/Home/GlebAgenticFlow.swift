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

// MARK: - Gleb visual chrome (shared)
//
// Visual language after the Gleb Kuznetsov concept: soft pastel mesh wash, glass,
// muted ink. These are the reusable pieces that skin the real agentic surfaces
// (AgenticHomeView + AgentTaskSessionView). There is deliberately no scripted flow
// here — the multi-step UI is generated from the user's own intent by
// AgentPlanGenerator → AgentTaskSession.

enum GlebChrome {
    static let ink = Color(red: 0.18, green: 0.19, blue: 0.22)
    static let muted = Color(red: 0.45, green: 0.47, blue: 0.52)

    static var pastelBlob: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: false)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            ZStack {
                Color(red: 0.97, green: 0.97, blue: 0.98)
                if #available(iOS 18.0, *) {
                    MeshGradient(
                        width: 3,
                        height: 3,
                        points: [
                            [0, 0], [0.5 + Float(sin(t * 0.2) * 0.03), 0], [1, 0],
                            [0, 0.5], [0.5 + Float(cos(t * 0.18) * 0.04), 0.45 + Float(sin(t * 0.15) * 0.03)], [1, 0.55],
                            [0, 1], [0.5, 1], [1, 1]
                        ],
                        colors: [
                            .white,
                            Color(red: 0.95, green: 0.93, blue: 0.99),
                            Color(red: 0.92, green: 0.96, blue: 0.99),
                            Color(red: 0.99, green: 0.93, blue: 0.90),
                            Color(red: 0.98, green: 0.94, blue: 0.86),
                            Color(red: 0.90, green: 0.94, blue: 0.99),
                            Color(red: 0.96, green: 0.95, blue: 0.99),
                            .white,
                            Color(red: 0.94, green: 0.97, blue: 0.99)
                        ]
                    )
                } else {
                    LinearGradient(
                        colors: [
                            Color(red: 0.95, green: 0.93, blue: 0.99),
                            Color(red: 0.99, green: 0.94, blue: 0.88),
                            Color(red: 0.90, green: 0.95, blue: 0.99)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                }
            }
        }
    }
}

// MARK: - Top chrome chips (weather + dual orbs + profile)

struct GlebTopChrome: View {
    var temperatureC: Double?
    var weatherSymbol: String
    var onProfile: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            // Weather pill
            HStack(spacing: 6) {
                AppIcon(AppGlyph.weather(weatherSymbol), size: 15)
                    .foregroundStyle(Color.orange.opacity(0.9))
                if let temperatureC {
                    Text("\(Int(temperatureC.rounded()))°")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GlebChrome.ink.opacity(0.8))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.7), lineWidth: 0.5))

            // Dual agent orbs
            HStack(spacing: 6) {
                Circle()
                    .fill(
                        AngularGradient(
                            colors: [
                                Color(red: 0.85, green: 0.85, blue: 0.9),
                                Color(red: 0.7, green: 0.75, blue: 0.85),
                                Color(red: 0.9, green: 0.9, blue: 0.95)
                            ],
                            center: .center
                        )
                    )
                    .frame(width: 34, height: 34)
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.8), lineWidth: 0.6))
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 2)

                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color(red: 0.55, green: 0.4, blue: 0.95), Color(red: 0.15, green: 0.1, blue: 0.25)],
                                center: .center,
                                startRadius: 2,
                                endRadius: 18
                            )
                        )
                        .frame(width: 34, height: 34)
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color.white.opacity(0.9), Color(red: 0.6, green: 0.5, blue: 1.0).opacity(0.3), .clear],
                                center: UnitPoint(x: 0.35, y: 0.35),
                                startRadius: 0,
                                endRadius: 14
                            )
                        )
                        .frame(width: 34, height: 34)
                }
                .overlay(Circle().strokeBorder(Color.white.opacity(0.5), lineWidth: 0.5))
                .shadow(color: Color.purple.opacity(0.35), radius: 8, y: 2)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.65), lineWidth: 0.5))

            Spacer()

            Button(action: onProfile) {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color(red: 0.95, green: 0.75, blue: 0.7), Color(red: 0.55, green: 0.4, blue: 0.45)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: 38, height: 38)
                    .overlay(
                        AppIcon("person", size: 18)
                            .foregroundStyle(.white.opacity(0.9))
                    )
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.85), lineWidth: 1.5))
                    .shadow(color: .black.opacity(0.1), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
        }
    }
}
