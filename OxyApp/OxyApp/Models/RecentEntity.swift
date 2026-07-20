import Foundation

/// A named entity (product, candidate, listing) the agent touched while running a task
/// (see `task_entities` / `recordTaskEntity` in api/services/task-entities.js). Powers the
/// "recently touched" strip on Home and the chat-pipeline's vague-reference resolution.
struct RecentEntity: Codable, Identifiable, Equatable {
    let id: String
    let entityName: String
    let site: String
    /// Raw server timestamp string — kept as `String` (not `Date`), same convention as
    /// `TaskStep.createdAt`. Use `createdAtDate` when a parsed `Date` is needed.
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case entityName = "entity_name"
        case site
        case createdAt = "created_at"
    }

    var createdAtDate: Date? { Date.oxyParse(createdAt) }
}

struct RecentEntitiesResponse: Codable {
    let entities: [RecentEntity]
}
