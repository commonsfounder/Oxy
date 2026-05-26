import CoreLocation
import Observation

@Observable
@MainActor
final class LocationManager: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let shared = LocationManager()

    var lastLocation: CLLocation?
    var authorizationStatus: CLAuthorizationStatus = .notDetermined
    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    private let manager = CLLocationManager()
    private var pendingLocationContinuations: [CheckedContinuation<[String: Double]?, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 25
        authorizationStatus = manager.authorizationStatus
    }

    func requestPermission() {
        manager.requestWhenInUseAuthorization()
    }

    func requestAlwaysPermission() {
        if authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        } else {
            manager.requestWhenInUseAuthorization()
        }
    }

    func requestLocation() {
        if isAuthorized {
            manager.requestLocation()
        } else {
            requestPermission()
        }
    }

    func currentLocationForLocalRequest(timeoutNanoseconds: UInt64 = 900_000_000) async -> [String: Double]? {
        if let lastLocation, abs(lastLocation.timestamp.timeIntervalSinceNow) < 180 {
            return locationDict
        }
        if !isAuthorized {
            requestPermission()
            return nil
        }

        manager.requestLocation()
        return await withCheckedContinuation { continuation in
            pendingLocationContinuations.append(continuation)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                self?.resolvePendingLocationContinuations(with: self?.locationDict)
            }
        }
    }

    var locationDict: [String: Double]? {
        guard let loc = lastLocation else { return nil }
        return [
            "latitude": loc.coordinate.latitude,
            "longitude": loc.coordinate.longitude
        ]
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lastLocation = locations.last
        resolvePendingLocationContinuations(with: locationDict)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        resolvePendingLocationContinuations(with: nil)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        if isAuthorized {
            manager.requestLocation()
        } else {
            resolvePendingLocationContinuations(with: nil)
        }
    }

    private func resolvePendingLocationContinuations(with location: [String: Double]?) {
        guard !pendingLocationContinuations.isEmpty else { return }
        let continuations = pendingLocationContinuations
        pendingLocationContinuations.removeAll()
        continuations.forEach { $0.resume(returning: location) }
    }
}
