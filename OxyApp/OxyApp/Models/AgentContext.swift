import Foundation

struct AgentContextSnapshot: Codable, Equatable {
    let agent: AgentIdentity
    let profile: AgentProfile
    let preferences: [String: String]
    let memories: [String]
    let goals: [AgentContextGoal]
    let connectedApps: [String]
    let generatedAt: String?
}

struct AgentIdentity: Codable, Equatable {
    let name: String
    let role: String
    let continuity: String
}

struct AgentProfile: Codable, Equatable {
    let text: String
    let sections: [String: [String]]

    var identity: [String] { sections["identity"] ?? [] }
    var work: [String] { sections["work"] ?? [] }
    var relationships: [String] { sections["relationships"] ?? [] }
    var goals: [String] { sections["goals"] ?? [] }
    var context: [String] { sections["context"] ?? [] }

    var isEmpty: Bool {
        text.isEmpty && sections.values.allSatisfy(\.isEmpty)
    }
}

struct AgentContextGoal: Codable, Identifiable, Equatable {
    let id: String
    let goal: String
    let status: String
    let autonomy: String
    let guardMode: Bool
    let currentStep: Int
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, goal, status, autonomy
        case guardMode
        case currentStep
        case updatedAt
    }
}
