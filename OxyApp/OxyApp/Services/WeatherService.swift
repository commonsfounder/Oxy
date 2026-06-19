import Foundation
import CoreLocation

/// Real local weather for the Today dashboard via Open-Meteo — a free, key-less,
/// entitlement-free API. (We deliberately do NOT use WeatherKit: it needs a paid
/// Apple Developer account + the `com.apple.developer.weatherkit` entitlement,
/// neither of which this app has, so it would always return nil on-device.)
/// Named `OxyWeatherService` for backwards-compat with existing call sites.
@MainActor
final class OxyWeatherService {
    static let shared = OxyWeatherService()

    private var cached: (snapshot: OxyWeatherSnapshot, at: Date)?
    private let cacheTTL: TimeInterval = 30 * 60

    /// A lightweight, view-ready summary of current conditions.
    struct OxyWeatherSnapshot: Equatable {
        let temperatureC: Double
        let apparentC: Double
        let conditionDescription: String
        let symbolName: String
        let highC: Double?
        let lowC: Double?
        let humidity: Int?            // %
        let windSpeed: Double?        // km/h
        let uvIndex: Double?
        let precipProbability: Int?   // %

        /// e.g. "12° · Partly Cloudy" — rounded, unit-light for the briefing rail.
        var shortLine: String {
            "\(Int(temperatureC.rounded()))° · \(conditionDescription)"
        }

        /// Human UV band for the detail grid.
        var uvBand: String? {
            guard let uv = uvIndex else { return nil }
            switch uv {
            case ..<3: return "Low"
            case ..<6: return "Moderate"
            case ..<8: return "High"
            case ..<11: return "Very High"
            default: return "Extreme"
            }
        }
    }

    /// Current snapshot for the device location, or `nil` if location/network is unavailable.
    /// Cached for 30 minutes to avoid hammering the API.
    func currentWeather() async -> OxyWeatherSnapshot? {
        if let cached, Date().timeIntervalSince(cached.at) < cacheTTL {
            return cached.snapshot
        }
        guard let location = await resolveLocation() else { return nil }

        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")
        components?.queryItems = [
            URLQueryItem(name: "latitude", value: String(location.coordinate.latitude)),
            URLQueryItem(name: "longitude", value: String(location.coordinate.longitude)),
            URLQueryItem(name: "current", value: "temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m"),
            URLQueryItem(name: "daily", value: "temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max"),
            URLQueryItem(name: "timezone", value: "auto")
        ]
        guard let url = components?.url else { return nil }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let response = try JSONDecoder().decode(OpenMeteoResponse.self, from: data)
            let code = response.current.weather_code
            let snapshot = OxyWeatherSnapshot(
                temperatureC: response.current.temperature_2m,
                apparentC: response.current.apparent_temperature,
                conditionDescription: Self.condition(for: code),
                symbolName: Self.symbol(for: code),
                highC: response.daily.temperature_2m_max.first,
                lowC: response.daily.temperature_2m_min.first,
                humidity: response.current.relative_humidity_2m,
                windSpeed: response.current.wind_speed_10m,
                uvIndex: response.daily.uv_index_max.first ?? nil,
                precipProbability: response.daily.precipitation_probability_max.first ?? nil
            )
            cached = (snapshot, Date())
            return snapshot
        } catch {
            return nil
        }
    }

    private func resolveLocation() async -> CLLocation? {
        let manager = LocationManager.shared
        if let last = manager.lastLocation,
           abs(last.timestamp.timeIntervalSinceNow) < 30 * 60 {
            return last
        }
        guard manager.isAuthorized else { return nil }
        manager.requestLocation()
        // Give the one-shot fix up to 4 s to land.
        for _ in 0..<20 {
            try? await Task.sleep(for: .milliseconds(200))
            if let last = manager.lastLocation { return last }
        }
        return manager.lastLocation
    }

    // MARK: - WMO weather code mapping

    /// WMO weather interpretation codes → human condition text.
    private static func condition(for code: Int) -> String {
        switch code {
        case 0: return "Clear"
        case 1: return "Mainly Clear"
        case 2: return "Partly Cloudy"
        case 3: return "Overcast"
        case 45, 48: return "Fog"
        case 51, 53, 55: return "Drizzle"
        case 56, 57: return "Freezing Drizzle"
        case 61, 63, 65: return "Rain"
        case 66, 67: return "Freezing Rain"
        case 71, 73, 75, 77: return "Snow"
        case 80, 81, 82: return "Rain Showers"
        case 85, 86: return "Snow Showers"
        case 95: return "Thunderstorm"
        case 96, 99: return "Thunderstorm, Hail"
        default: return "—"
        }
    }

    /// WMO weather interpretation codes → SF Symbol name.
    private static func symbol(for code: Int) -> String {
        switch code {
        case 0, 1: return "sun.max"
        case 2: return "cloud.sun"
        case 3: return "cloud"
        case 45, 48: return "cloud.fog"
        case 51, 53, 55, 56, 57: return "cloud.drizzle"
        case 61, 63, 65, 66, 67, 80, 81, 82: return "cloud.rain"
        case 71, 73, 75, 77, 85, 86: return "cloud.snow"
        case 95, 96, 99: return "cloud.bolt.rain"
        default: return "cloud"
        }
    }
}

// MARK: - Open-Meteo response

private struct OpenMeteoResponse: Decodable {
    let current: Current
    let daily: Daily

    struct Current: Decodable {
        let temperature_2m: Double
        let apparent_temperature: Double
        let weather_code: Int
        let relative_humidity_2m: Int?
        let wind_speed_10m: Double?
    }

    struct Daily: Decodable {
        let temperature_2m_max: [Double]
        let temperature_2m_min: [Double]
        let uv_index_max: [Double?]
        let precipitation_probability_max: [Int?]
    }
}
