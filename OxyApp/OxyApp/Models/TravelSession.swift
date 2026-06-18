import Foundation

// MARK: - Trip (travel session stored in Supabase travel_sessions)

struct TravelSession: Codable, Identifiable, Equatable {
    let id: String
    var title: String?
    var status: TripStatus
    var requirements: TravelRequirements?
    var itinerary: TripItinerary?
    var budget: TripBudget?
    let createdAt: String?
    var updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, status, requirements, itinerary, budget
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    static func == (lhs: TravelSession, rhs: TravelSession) -> Bool { lhs.id == rhs.id }
}

enum TripStatus: String, Codable {
    case planning, confirmed, inProgress = "in_progress", completed
    var label: String {
        switch self {
        case .planning:   return "PLANNING"
        case .confirmed:  return "CONFIRMED"
        case .inProgress: return "IN PROGRESS"
        case .completed:  return "COMPLETED"
        }
    }
}

// MARK: - Requirements (extracted from travel concierge conversation)

struct TravelRequirements: Codable {
    var origin: String?
    var destination: String?
    var date: String?
    var endDate: String?
    var duration: String?
    var partySize: String?
    var budget: String?
    var budgetTier: String?
    var transportMode: String?
    var accommodationPreference: String?
    var activityPreferences: [String]?
    var dietaryRequirements: [String]?
    var travelStyle: String?
    var tripGoals: String?
    var constraints: [String]?
    var tripType: String?
}

// MARK: - Itinerary

struct TripItinerary: Codable {
    var title: String?
    var destination: String?
    var startDate: String?
    var endDate: String?
    var totalDays: Int?
    var estimatedBudget: TripBudgetSummary?
    var days: [ItineraryDay]?
    var generalTips: [String]?
    var packingHighlights: [String]?
    var lastModification: ItineraryModification?
}

struct TripBudgetSummary: Codable {
    var total: Double?
    var currency: String?
    var breakdown: BudgetBreakdown?
    var note: String?
}

struct BudgetBreakdown: Codable {
    var accommodation: Double?
    var activities: Double?
    var food: Double?
    var transport: Double?
}

struct ItineraryDay: Codable, Identifiable {
    var day: Int
    var date: String?
    var area: String?
    var theme: String?
    var morning: DaySlot?
    var afternoon: DaySlot?
    var evening: DaySlot?
    var meals: DayMeals?
    var travelTips: String?
    var alternatives: [String]?

    var id: Int { day }
}

struct DaySlot: Codable {
    var activity: String?
    var duration: String?
    var estimatedCost: Double?
    var why: String?
}

struct DayMeals: Codable {
    var breakfast: String?
    var lunch: String?
    var dinner: String?
}

struct ItineraryModification: Codable {
    var instruction: String?
    var summary: String?
    var modifiedAt: String?
}

// MARK: - Budget

struct TripBudget: Codable {
    var estimated: Double?
    var actual: Double?
    var currency: String?
}

// MARK: - Create request

struct CreateTripRequest: Codable {
    let userId: String
    let destination: String
    var title: String?
    var requirements: TravelRequirements?

    enum CodingKeys: String, CodingKey {
        case userId = "userId"
        case destination, title, requirements
    }
}
