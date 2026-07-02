import CoreLocation
import Observation

@Observable
@MainActor
final class LocationManager: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let shared = LocationManager()

    /// Posted when the device moves meaningfully (significant-change monitoring), so the
    /// proactive layer can refresh the server's idea of where the user is.
    static let didChangeLocation = Notification.Name("OxyDidChangeLocation")

    var lastLocation: CLLocation?
    var authorizationStatus: CLAuthorizationStatus = .notDetermined
    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var monitoringSignificantChanges = false
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

    /// Wakes the app on meaningful moves (~500m) so the server's location stays current even
    /// between foreground sessions. Always-authorization only; no-op otherwise.
    func startMonitoringSignificantChanges() {
        guard authorizationStatus == .authorizedAlways, !monitoringSignificantChanges,
              CLLocationManager.significantLocationChangeMonitoringAvailable() else { return }
        monitoringSignificantChanges = true
        manager.startMonitoringSignificantLocationChanges()
    }

    /// Reverse-geocodes the last fix into a human place label (street/area/city/POI name) so the
    /// brain reasons about "near Aldi", not raw coordinates. nil if unavailable.
    func placeLabel() async -> [String: String]? {
        guard let loc = lastLocation else { return nil }
        let placemarks: [CLPlacemark] = await withCheckedContinuation { continuation in
            geocoder.reverseGeocodeLocation(loc) { marks, _ in continuation.resume(returning: marks ?? []) }
        }
        guard let placemark = placemarks.first else { return nil }
        var place: [String: String] = [:]
        if let name = placemark.name { place["name"] = name }
        if let street = placemark.thoroughfare { place["street"] = street }
        if let area = placemark.subLocality { place["area"] = area }
        if let city = placemark.locality { place["city"] = city }
        return place.isEmpty ? nil : place
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lastLocation = locations.last
        resolvePendingLocationContinuations(with: locationDict)
        NotificationCenter.default.post(name: Self.didChangeLocation, object: nil)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        resolvePendingLocationContinuations(with: nil)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationStatus = manager.authorizationStatus
        if isAuthorized {
            manager.requestLocation()
            startMonitoringSignificantChanges()
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
