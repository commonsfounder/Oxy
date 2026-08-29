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
    static var pastelBlob: some View {
        ZStack {
            Color.appBackground
            Circle()
                .fill(Color.appAccent.opacity(0.10))
                .frame(width: 310, height: 310)
                .blur(radius: 58)
                .offset(x: 138, y: -250)
                .allowsHitTesting(false)
            Circle()
                .fill(Color(red: 0.72, green: 0.66, blue: 0.86).opacity(0.08))
                .frame(width: 270, height: 270)
                .blur(radius: 72)
                .offset(x: -150, y: 110)
                .allowsHitTesting(false)
            AppGrain(intensity: 0.035)
        }
    }
}

// MARK: - Top chrome chips (weather + dual orbs + profile)

struct GlebTopChrome: View {
    var weather: OxyWeatherService.OxyWeatherSnapshot?
    var onProfile: () -> Void

    @State private var weatherExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                BrandWordmark(height: 14, color: Color.appMuted)
                Spacer(minLength: 0)
                weatherPill
                profileButton
            }

            if weatherExpanded, let weather {
                weatherDetail(weather)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: - Weather (tap to expand rain/UV/humidity/wind/high-low, same data the
    // app already fetches but used to throw away above the fold)

    @ViewBuilder
    private var weatherPill: some View {
        if let weather {
            Button {
            HapticManager.shared.impact(.light)
            withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) { weatherExpanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                AppIcon(AppGlyph.weather(weather.symbolName), size: 15)
                    .foregroundStyle(Color.appAccent)
                Text("\(Int(weather.temperatureC.rounded()))°")
                    .font(.appBody(AppText.body, weight: .semibold))
                    // The reading is the content of this pill, not a caption on it.
                    .foregroundStyle(Color.appInk)
                    .contentTransition(.numericText())
                    .animation(.appStandard, value: weather.temperatureC)
                AppIcon("chevron-down", size: AppGlyphSize.small)
                    .foregroundStyle(Color.appMuted)
                    .rotationEffect(.degrees(weatherExpanded ? 180 : 0))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.appSurface, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.appAccent.opacity(0.20), lineWidth: AppBorder.hairline))
        }
        .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func weatherDetail(_ w: OxyWeatherService.OxyWeatherSnapshot) -> some View {
        let cells: [(String, String)] = [
            w.precipProbability.map { ("Rain", "\($0)%") },
            w.uvBand.map { ("UV", $0) },
            w.humidity.map { ("Humidity", "\($0)%") },
            w.windSpeed.map { ("Wind", "\(Int($0.rounded())) km/h") },
            w.highC.map { ("High", "\(Int($0.rounded()))°") },
            w.lowC.map { ("Low", "\(Int($0.rounded()))°") }
        ].compactMap { $0 }

        VStack(alignment: .leading, spacing: 14) {
            Text(w.conditionDescription)
                .font(.appBody(AppText.footnote, weight: .medium))
                .foregroundStyle(Color.appMuted)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
                ForEach(cells, id: \.0) { cell in
                    VStack(spacing: 4) {
                        Text(cell.0)
                            .appEyebrow()
                        Text(cell.1)
                            .font(.appBody(AppText.body, weight: .medium))
                            .foregroundStyle(Color.appInk)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(16)
        .background { MissionGlassPlate() }
    }

    private var profileButton: some View {
        AppIconButton("person", label: "Account", style: .surface, action: onProfile)
    }
}
