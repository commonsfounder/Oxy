import Foundation

// MARK: - Agent Task Session (Video B pattern)
//
// A generated multi-step "job" surface: plan board -> step 1/n -> step n/n -> done.
// v1 is a client-side plan generator from intent keywords (dinner->time+restaurant+
// invite+ride, ride->ride confirm, order->place+payment) so the UI can ship ahead of
// a structured backend agent-task API. Real connectors can replace the mock data in
// each step without touching the shell.

@Observable
final class AgentTaskSession: Identifiable {
    let id = UUID()
    var title: String
    let originalPrompt: String
    var steps: [AgentStep]
    var currentIndex: Int

    init(title: String, originalPrompt: String, steps: [AgentStep]) {
        self.title = title
        self.originalPrompt = originalPrompt
        self.steps = steps
        currentIndex = steps.firstIndex(where: { $0.status == .active }) ?? 0
    }

    var currentStep: AgentStep? {
        steps.indices.contains(currentIndex) ? steps[currentIndex] : nil
    }

    var isComplete: Bool {
        currentIndex >= steps.count
    }

    /// "k/n" against only the steps a user actually steps through — plan boards and
    /// working heroes are chrome, not counted progress.
    var progressText: String? {
        let countable = steps.enumerated().filter { $0.element.countsTowardProgress }
        guard countable.count > 1 else { return nil }
        let rank = countable.firstIndex { $0.offset == currentIndex }.map { $0 + 1 } ?? countable.count
        return "\(rank)/\(countable.count)"
    }

    func advance() {
        guard steps.indices.contains(currentIndex) else { return }
        steps[currentIndex].status = .done
        if let next = steps.indices.first(where: { $0 > currentIndex }) {
            steps[next].status = .active
            currentIndex = next
        } else {
            currentIndex = steps.count
        }
    }
}

@Observable
final class AgentStep: Identifiable {
    enum Status: Equatable { case pending, active, done }

    let id = UUID()
    let title: String
    var status: Status
    let ui: StepUI
    /// Contextual label for the primary CTA on this step ("To Invite Stephen" / "Confirm $42").
    let ctaLabel: String
    var selectedID: UUID?

    init(title: String, status: Status = .pending, ui: StepUI, ctaLabel: String) {
        self.title = title
        self.status = status
        self.ui = ui
        self.ctaLabel = ctaLabel
    }

    var countsTowardProgress: Bool {
        switch ui {
        case .planBoard, .workingHero: return false
        default: return true
        }
    }

    var canAdvance: Bool {
        switch ui {
        case .timePicker, .placePicker, .personPicker: return selectedID != nil
        case .workingHero: return false
        case .planBoard, .rideConfirm, .paymentConfirm, .productDetail: return true
        }
    }
}

enum StepUI {
    case planBoard(entries: [PlanEntry])
    case timePicker(slots: [TimeSlotOption])
    case placePicker(subtitle: String, results: [PlaceOption])
    case personPicker(people: [PersonOption], draftMessage: String)
    case rideConfirm(RideDetails)
    case paymentConfirm(PaymentDetails)
    case productDetail(ProductDetails)
    case workingHero(status: String)
}

struct PlanEntry: Identifiable {
    let id = UUID()
    let title: String
    var status: AgentStep.Status
}

struct TimeSlotOption: Identifiable, Equatable {
    let id = UUID()
    let time: String
    let label: String
}

struct PlaceOption: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let rating: String
    let tag: String
    let blurb: String
}

struct PersonOption: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let relation: String
}

struct RideDetails: Equatable {
    let pickup: String
    let dropoff: String
    let eta: String
    let price: String?
}

struct PaymentDetails: Equatable {
    let merchant: String
    let amount: String
    let detail: String
}

/// A product surfaced for a "buy X" job. Everything except `name` is optional so
/// the step renders honestly before a real product-lookup connector fills it in —
/// no fabricated prices or specs attached to a real product.
struct ProductDetails: Equatable {
    let name: String
    let subtitle: String
    var priceText: String?
    var specs: [String]
    var swatches: [ProductSwatch]

    init(name: String, subtitle: String, priceText: String? = nil, specs: [String] = [], swatches: [ProductSwatch] = []) {
        self.name = name
        self.subtitle = subtitle
        self.priceText = priceText
        self.specs = specs
        self.swatches = swatches
    }
}

struct ProductSwatch: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let red: Double
    let green: Double
    let blue: Double
}

// MARK: - Plan generator (keyword scaffold, replace with real intent parsing later)

enum AgentPlanGenerator {
    static func generate(for prompt: String) -> AgentTaskSession? {
        let lower = prompt.lowercased()

        if lower.contains("dinner") || lower.contains("book a table") || lower.contains("book us a table") {
            return dinnerSession(prompt: prompt)
        }
        if containsOrderKeyword(lower) {
            return orderSession(prompt: prompt)
        }
        if containsRideKeyword(lower) {
            return rideSession(prompt: prompt)
        }
        if containsBuyKeyword(lower) {
            return buySession(prompt: prompt)
        }
        return nil
    }

    private static func containsRideKeyword(_ lower: String) -> Bool {
        ["uber", "taxi", "cab", "ride home", "book a ride", "book me a ride"].contains { lower.contains($0) }
    }

    private static func containsOrderKeyword(_ lower: String) -> Bool {
        (lower.contains("order") && (lower.contains("food") || lower.contains("takeout") || lower.contains("delivery")))
    }

    /// Word-anchored so "card", "care", "scary", "cargo" don't trigger a buy job
    /// (an earlier substring match on "car"/"buy a" hijacked unrelated intents).
    private static func containsBuyKeyword(_ lower: String) -> Bool {
        let words = Set(lower.split { !$0.isLetter }.map(String.init))
        if words.contains("buy") || words.contains("buying") || words.contains("purchase") { return true }
        return lower.contains("order me a") || lower.contains("i want to buy")
    }

    private static func personName(in prompt: String) -> String {
        if let range = prompt.range(of: "with ", options: .caseInsensitive) {
            let rest = prompt[range.upperBound...]
            let word = rest.split(separator: " ").first.map(String.init) ?? "them"
            return word.trimmingCharacters(in: .punctuationCharacters)
        }
        return "them"
    }

    private static func dinnerSession(prompt: String) -> AgentTaskSession {
        let name = personName(in: prompt)
        let planEntries = [
            PlanEntry(title: "Choosing a time", status: .active),
            PlanEntry(title: "Choose and book a restaurant", status: .pending),
            PlanEntry(title: "Invite \(name)", status: .pending),
            PlanEntry(title: "Book a ride home", status: .pending)
        ]
        let steps = [
            AgentStep(title: "Plan", status: .active, ui: .planBoard(entries: planEntries), ctaLabel: "Start"),
            AgentStep(title: "Choose a time", ui: .timePicker(slots: [
                TimeSlotOption(time: "6:30 PM", label: "Free time"),
                TimeSlotOption(time: "7:00 PM", label: "Free time"),
                TimeSlotOption(time: "8:15 PM", label: "After gym")
            ]), ctaLabel: "Next"),
            AgentStep(title: "Book a restaurant", ui: .placePicker(subtitle: "Near you", results: [
                PlaceOption(name: "Scramble Place", rating: "4.7", tag: "American", blurb: "Bright, casual, great for groups."),
                PlaceOption(name: "Lilac & Vine", rating: "4.5", tag: "Wine bar", blurb: "Small plates, quiet corners."),
                PlaceOption(name: "Kōji", rating: "4.8", tag: "Japanese", blurb: "Tasting menu, book ahead.")
            ]), ctaLabel: "To Invite \(name)"),
            AgentStep(title: "Invite \(name)", ui: .personPicker(
                people: [PersonOption(name: name, relation: "Friend")],
                draftMessage: "Do you want to come to dinner with me?"
            ), ctaLabel: "Send invite"),
            AgentStep(title: "Book a ride", ui: .rideConfirm(RideDetails(
                pickup: "Home", dropoff: "Restaurant", eta: "8 min", price: "~$14"
            )), ctaLabel: "Book Uber")
        ]
        return AgentTaskSession(title: "Dinner with \(name)", originalPrompt: prompt, steps: steps)
    }

    private static func rideSession(prompt: String) -> AgentTaskSession {
        let steps = [
            AgentStep(title: "Book a ride", status: .active, ui: .rideConfirm(RideDetails(
                pickup: "Current location", dropoff: "Home", eta: "6 min", price: "~$11"
            )), ctaLabel: "Book Uber")
        ]
        return AgentTaskSession(title: "Ride home", originalPrompt: prompt, steps: steps)
    }

    /// Pulls the product the user actually named out of their phrasing. No product
    /// data is invented — the detail step shows the parsed name and stays honest
    /// about price/specs until a real product-lookup connector fills them in.
    private static func productName(from prompt: String) -> String {
        var s = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let leads = [
            "i want to buy a", "i want to buy", "i'd like to buy a", "i'd like to buy",
            "i want to purchase a", "i want to purchase", "buy me a", "buy me", "buy a",
            "purchase a", "purchase", "order me a", "order me", "get me a", "buy"
        ]
        let lower = s.lowercased()
        for lead in leads where lower.hasPrefix(lead + " ") {
            s = String(s.dropFirst(lead.count + 1)).trimmingCharacters(in: .whitespaces)
            break
        }
        let cleaned = s.trimmingCharacters(in: CharacterSet(charactersIn: " .?!"))
        return cleaned.isEmpty ? "your item" : cleaned.capitalized
    }

    private static func buySession(prompt: String) -> AgentTaskSession {
        let name = productName(from: prompt)
        let steps = [
            AgentStep(
                title: "Finding \(name)",
                status: .active,
                ui: .workingHero(status: "Searching options in the background"),
                ctaLabel: "Next"
            ),
            AgentStep(
                title: name,
                ui: .productDetail(ProductDetails(
                    name: name,
                    subtitle: "Best match for your request",
                    // Finish options are universal enough to show pre-backend; price and
                    // specs stay empty until a real product-lookup connector fills them.
                    swatches: [
                        ProductSwatch(name: "Silver", red: 0.80, green: 0.80, blue: 0.82),
                        ProductSwatch(name: "Graphite", red: 0.22, green: 0.22, blue: 0.24),
                        ProductSwatch(name: "Slate", red: 0.42, green: 0.45, blue: 0.50),
                        ProductSwatch(name: "Chalk", red: 0.95, green: 0.94, blue: 0.91),
                        ProductSwatch(name: "Sand", red: 0.84, green: 0.80, blue: 0.70)
                    ]
                )),
                ctaLabel: "Continue to checkout"
            ),
            AgentStep(
                title: "Confirm",
                ui: .paymentConfirm(PaymentDetails(
                    merchant: name,
                    amount: "At checkout",
                    detail: "Final price is confirmed before anything is charged."
                )),
                ctaLabel: "Review & confirm"
            )
        ]
        return AgentTaskSession(title: "Buy \(name)", originalPrompt: prompt, steps: steps)
    }

    private static func orderSession(prompt: String) -> AgentTaskSession {
        let steps = [
            AgentStep(title: "Order food", status: .active, ui: .placePicker(subtitle: "Delivers to you", results: [
                PlaceOption(name: "Green Bowl", rating: "4.6", tag: "Healthy", blurb: "Salads, grain bowls."),
                PlaceOption(name: "Pasta Bar", rating: "4.4", tag: "Italian", blurb: "Fresh pasta, 25 min."),
                PlaceOption(name: "Sushi Go", rating: "4.7", tag: "Japanese", blurb: "Rolls, bento, fast.")
            ]), ctaLabel: "Confirm order"),
            AgentStep(title: "Confirm payment", ui: .paymentConfirm(PaymentDetails(
                merchant: "Order", amount: "$28.40", detail: "Charged to your linked card"
            )), ctaLabel: "Pay $28.40")
        ]
        return AgentTaskSession(title: "Order food", originalPrompt: prompt, steps: steps)
    }
}
