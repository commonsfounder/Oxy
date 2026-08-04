import Foundation

struct ModelRoutingSnapshot: Codable, Equatable {
    let selected: ModelRouteSelection
    let active: ModelRouteSelection
    let providers: [ModelProvider]
}

struct ModelRouteSelection: Codable, Equatable {
    let provider: String
    let model: String
    let configured: Bool
    let source: String?
}

struct ModelProvider: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let defaultModel: String
    let configured: Bool
    let capabilities: [String]
}
