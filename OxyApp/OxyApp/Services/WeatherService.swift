import Foundation
import CoreLocation
import WeatherKit

/// Real local weather via Apple's WeatherKit, for the Today briefing. Named
/// `OxyWeatherService` to avoid colliding with WeatherKit's own `WeatherService`.
///
/// Requires the `com.apple.developer.weatherkit` entitlement (added in
/// OxyApp.entitlements). On simulators or when location/entitlement is missing
/// it simply returns `nil`, and the Today view falls back to its existing copy.
@MainActor
final class OxyWeatherService {
    static let shared = OxyWeatherService()

    private let service = WeatherKit.WeatherService.shared
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

        /// e.g. "12° · Partly Cloudy" — rounded, unit-light for the briefing rail.
        var shortLine: String {
            "\(Int(temperatureC.rounded()))° · \(conditionDescription)"
        }
    }

    /// Returns the current snapshot for the device location, or `nil` if it
    /// can't be resolved (no location permission, simulator, network/entitlement
    /// failure). Cached for 30 minutes to avoid hammering WeatherKit.
    func currentWeather() async -> OxyWeatherSnapshot? {
        if let cached, Date().timeIntervalSince(cached.at) < cacheTTL {
            return cached.snapshot
        }
        guard let location = await resolveLocation() else { return nil }

        do {
            let weather = try await service.weather(for: location)
            let current = weather.currentWeather
            let today = weather.dailyForecast.forecast.first
            let snapshot = OxyWeatherSnapshot(
                temperatureC: current.temperature.converted(to: .celsius).value,
                apparentC: current.apparentTemperature.converted(to: .celsius).value,
                conditionDescription: current.condition.description,
                symbolName: current.symbolName,
                highC: today?.highTemperature.converted(to: .celsius).value,
                lowC: today?.lowTemperature.converted(to: .celsius).value
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
        // Give the one-shot fix a brief window to land.
        for _ in 0..<10 {
            try? await Task.sleep(for: .milliseconds(200))
            if let last = manager.lastLocation { return last }
        }
        return manager.lastLocation
    }
}
