import Foundation

@MainActor
final class TravelService: ObservableObject {
    static let shared = TravelService()
    private let api = APIClient.shared

    private init() {}

    // MARK: - Trips CRUD

    func listTrips(userId: String) async throws -> [TravelSession] {
        let data = try await api.request(path: "/trips/\(userId)")
        let decoded = try JSONDecoder().decode(TripsListResponse.self, from: data)
        return decoded.trips
    }

    func getTrip(userId: String, tripId: String) async throws -> TravelSession {
        let data = try await api.request(path: "/trips/\(userId)/\(tripId)")
        return try JSONDecoder().decode(TravelSession.self, from: data)
    }

    func createTrip(userId: String, destination: String, title: String? = nil, requirements: TravelRequirements? = nil) async throws -> TravelSession {
        var body: [String: Any] = ["userId": userId, "destination": destination]
        if let title { body["title"] = title }
        if let req = requirements, let encoded = try? JSONEncoder().encode(req),
           let dict = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
            body["requirements"] = dict
        }
        let data = try await api.request(path: "/trips", method: "POST", body: body)
        return try JSONDecoder().decode(TravelSession.self, from: data)
    }

    func deleteTrip(userId: String, tripId: String) async throws {
        _ = try await api.request(path: "/trips/\(userId)/\(tripId)", method: "DELETE")
    }

    // MARK: - Itinerary

    func generateItinerary(userId: String, tripId: String) async throws -> ItineraryResponse {
        let data = try await api.request(path: "/trips/\(userId)/\(tripId)/generate-itinerary", method: "POST")
        return try JSONDecoder().decode(ItineraryResponse.self, from: data)
    }

    func modifyItinerary(userId: String, tripId: String, instruction: String) async throws -> ModifyResponse {
        let data = try await api.request(path: "/trips/\(userId)/\(tripId)/modify", method: "POST",
                                         body: ["instruction": instruction])
        return try JSONDecoder().decode(ModifyResponse.self, from: data)
    }

    // MARK: - Travel Profile

    func getTravelProfile(userId: String) async throws -> [String: Any] {
        let data = try await api.request(path: "/travel-profile/\(userId)")
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: - Response types

    struct TripsListResponse: Codable {
        let trips: [TravelSession]
    }

    struct ItineraryResponse: Codable {
        let itinerary: TripItinerary
        let text: String?
    }

    struct ModifyResponse: Codable {
        let itinerary: TripItinerary
        let summary: String?
    }
}
