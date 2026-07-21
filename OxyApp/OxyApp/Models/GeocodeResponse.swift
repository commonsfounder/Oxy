import Foundation

/// Decodes POST /geocode, used by SettingsView's "Home address" field to resolve a typed
/// address to coordinates once, rather than re-geocoding on every ride/route request.
struct GeocodeResponse: Codable {
    let lat: Double
    let lng: Double
    let formattedAddress: String
}
