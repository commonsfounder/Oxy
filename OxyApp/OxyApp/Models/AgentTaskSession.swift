import Foundation

// MARK: - Agent Task Session (real-data native job flows)
//
// A generated multi-step "job" surface: working/searching animation -> a
// real-data result step -> confirm. Steps are appended as real data arrives
// from the exact same backend pipeline chat already uses
// (ChatService.sendMessage -> SSE -> agentic loop -> run_browser_task /
// book_uber), not scripted up front — see
// docs/superpowers/specs/2026-07-18-real-buy-flow-design.md.
//
// Three job kinds share this shell today:
//  - .shopping: "buy X" and "order food" both drive run_browser_task (the
//    same Playwright-driven checkout pipeline — food delivery just lands on
//    an Uber Eats/Deliveroo-style DELIVERY recipe instead of a retailer one).
//  - .ride: "get me an uber" drives the real book_uber action — a deep-link
//    handoff into the Uber app with a best-effort fare estimate, not an
//    in-app booking.
//  - .task: a generic "go handle this" job kicked off from somewhere other than
//    typed text — e.g. tapping a Home inbox card's judged action ("Pay it",
//    "Sort it") — so the concierge acts on context it already has instead of
//    re-opening chat and re-prompting for the same email. Same run_browser_task
//    watch as .shopping (the `start()` ternary below already defaults any
//    non-.ride kind to it); kept as a separate case only so call sites and
//    session titles read honestly for what actually triggered them. This is
//    genuinely unproven for anything outside e-commerce checkout (a bank bill-pay
//    page has no Shopify/DELIVERY-style recipe and no login/2FA handling) — the
//    same honest "ask"/no-product-data → hand off to chat fallback `handle()`
//    already has is what carries it when the automation can't actually finish.
// Restaurant reservations ("book a table") have no real backend yet, so that
// intent isn't matched here at all — it falls through to real chat.

enum AgentJobKind: Equatable {
    case shopping
    case ride
    case task
}

@Observable
final class AgentTaskSession: Identifiable {
    let id = UUID()
    var title: String
    let originalPrompt: String
    let kind: AgentJobKind
    var steps: [AgentStep]
    var currentIndex: Int
    var errorMessage: String?
    var isWorking = false

    private let userId: String
    private let chatService: ChatService
    private let location: [String: Double]?

    init(
        title: String,
        originalPrompt: String,
        kind: AgentJobKind,
        userId: String,
        chatService: ChatService = ChatService(),
        location: [String: Double]? = nil
    ) {
        self.title = title
        self.originalPrompt = originalPrompt
        self.kind = kind
        self.userId = userId
        self.chatService = chatService
        self.location = location
        self.steps = [AgentStep(title: title, status: .active, ui: .workingHero(status: "Getting started…"), ctaLabel: "")]
        self.currentIndex = 0
    }

    var currentStep: AgentStep? {
        steps.indices.contains(currentIndex) ? steps[currentIndex] : nil
    }

    var isComplete: Bool {
        currentIndex >= steps.count
    }

    /// "k/n" against only the steps a user actually steps through — the working
    /// hero is chrome, not counted progress.
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

    private func appendStep(_ step: AgentStep) {
        if steps.indices.contains(currentIndex) { steps[currentIndex].status = .done }
        steps.append(step)
        currentIndex = steps.count - 1
        steps[currentIndex].status = .active
    }

    /// Kicks off the job through the real hidden pipeline, mutating `steps` as
    /// genuine backend results arrive. `onHandoff` fires (with a prompt to
    /// auto-send, or nil to just open the chat surface) whenever the outcome can't
    /// honestly be shown as a fixed native step — a clarifying question, a
    /// still-in-progress multi-turn task, or a network/backend error — real chat is
    /// the honest fallback there, not a fabricated step.
    @MainActor
    func start(onHandoff: @escaping (String?) -> Void) async {
        guard isWorking == false else { return }
        isWorking = true
        defer { isWorking = false }

        let watchedAction = kind == .ride ? "book_uber" : "run_browser_task"
        let stream = chatService.sendMessage(userId: userId, message: originalPrompt, location: location)
        var sawWatchedAction = false
        for await event in stream {
            switch event {
            case .status(let status, let label):
                updateWorkingStatus(status: status, label: label)
            case .actions(let results):
                guard let result = results.first(where: { $0.action == watchedAction }) else { continue }
                sawWatchedAction = true
                if kind == .ride {
                    handleRide(result: result, onHandoff: onHandoff)
                } else {
                    handle(result: result, onHandoff: onHandoff)
                }
            case .error(let message):
                errorMessage = message
                return
            case .done:
                if !sawWatchedAction { onHandoff(nil) }
                return
            default:
                break
            }
        }
        if !sawWatchedAction { onHandoff(nil) }
    }

    /// "Review & confirm" — sends the same affirmative reply a person would type in
    /// chat through the same hidden pipeline, letting the agent call the existing
    /// confirm_browser_payment action itself. No new payment code path; every
    /// safety gate that action already honours (spend cap, card note) is unchanged.
    @MainActor
    func confirmPayment(onHandoff: @escaping (String?) -> Void) async {
        guard isWorking == false else { return }
        isWorking = true
        defer { isWorking = false }

        let stream = chatService.sendMessage(
            userId: userId,
            message: "Yes, go ahead and confirm the payment.",
            location: location
        )
        for await event in stream {
            switch event {
            case .actions(let results):
                guard let result = results.first(where: { $0.action == "confirm_browser_payment" }) else { continue }
                if result.success {
                    complete()
                } else {
                    errorMessage = result.error ?? result.text ?? "The payment didn't go through."
                }
                return
            case .error(let message):
                errorMessage = message
                return
            case .done:
                onHandoff(nil)
                return
            default:
                break
            }
        }
        // No clean confirm_browser_payment result came back — don't guess at
        // success or failure on ambiguous data; let the user verify in real chat.
        onHandoff(nil)
    }

    private func updateWorkingStatus(status: String, label: String) {
        guard case .workingHero = currentStep?.ui, !label.isEmpty else { return }
        currentStep?.ui = .workingHero(status: label)
    }

    private func handle(result: ActionResult, onHandoff: (String?) -> Void) {
        if result.confirmation == "review_required" {
            let name = result.productName ?? title
            title = name
            appendStep(AgentStep(
                title: name,
                ui: .productDetail(ProductDetails(
                    name: name,
                    subtitle: result.text ?? "Ready to check out",
                    priceText: result.total,
                    imageUrls: result.imageUrls ?? [],
                    colorOptions: result.colorOptions ?? []
                )),
                ctaLabel: "Continue to checkout"
            ))
            appendStep(AgentStep(
                title: "Confirm",
                ui: .paymentConfirm(PaymentDetails(
                    merchant: name,
                    amount: result.total ?? "At checkout",
                    detail: result.text ?? "Final price is confirmed before anything is charged."
                )),
                ctaLabel: "Review & confirm"
            ))
            return
        }
        if result.success, result.productName != nil || result.imageUrls?.isEmpty == false {
            let name = result.productName ?? title
            title = name
            appendStep(AgentStep(
                title: name,
                ui: .productDetail(ProductDetails(
                    name: name,
                    subtitle: result.text ?? "",
                    priceText: result.price,
                    imageUrls: result.imageUrls ?? []
                )),
                ctaLabel: "Done"
            ))
            return
        }
        // Plain text with no product data attached — most likely a clarifying
        // question or an answer with nothing to show as a product card. Neither has
        // an honest fixed native shape, so hand off to real chat.
        onHandoff(nil)
    }

    /// book_uber is a synchronous deep-link handoff (executionMode: 'direct',
    /// confirmation: 'none') — no review step, no second network round trip.
    /// `cardText`'s fare/ETA is Oxy's own estimate (Google Routes based), not a
    /// live Uber quote, so RideConfirmStepView labels it honestly as an estimate.
    private func handleRide(result: ActionResult, onHandoff: (String?) -> Void) {
        guard result.success else {
            errorMessage = result.error ?? result.text ?? "Couldn't get an Uber ready."
            return
        }
        appendStep(AgentStep(
            title: "Ride ready",
            ui: .rideConfirm(RideDetails(
                summary: result.text ?? "Ride ready.",
                estimate: result.cardText,
                deepLink: result.deepLink,
                webLink: result.webLink
            )),
            ctaLabel: "Open Uber"
        ))
    }

    private func complete() {
        if steps.indices.contains(currentIndex) { steps[currentIndex].status = .done }
        currentIndex = steps.count
    }
}

@Observable
final class AgentStep: Identifiable {
    enum Status: Equatable { case pending, active, done }

    let id = UUID()
    let title: String
    var status: Status
    var ui: StepUI
    /// Contextual label for the primary CTA on this step ("Continue to checkout" / "Review & confirm").
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
        case .workingHero: return false
        default: return true
        }
    }

    var canAdvance: Bool {
        switch ui {
        case .workingHero: return false
        case .paymentConfirm, .productDetail, .rideConfirm: return true
        }
    }
}

enum StepUI {
    case paymentConfirm(PaymentDetails)
    case productDetail(ProductDetails)
    case rideConfirm(RideDetails)
    case workingHero(status: String)
}

struct PaymentDetails: Equatable {
    let merchant: String
    let amount: String
    let detail: String
}

/// Real book_uber result data. `estimate` (from the action's cardText) is Oxy's
/// own fare/ETA estimate, not a live Uber quote — the step view says so.
struct RideDetails: Equatable {
    let summary: String
    let estimate: String?
    let deepLink: String?
    let webLink: String?
}

/// A product surfaced for a "buy X" job. Everything except `name` is real backend
/// data or absent — no fabricated prices, photos, or color options attached to a
/// real product.
struct ProductDetails: Equatable {
    let name: String
    let subtitle: String
    var priceText: String?
    var imageUrls: [String]
    /// Only ever populated when the backend genuinely observed distinct selectable
    /// color/size options on the page — never a fallback/default set.
    var colorOptions: [String]

    init(name: String, subtitle: String, priceText: String? = nil, imageUrls: [String] = [], colorOptions: [String] = []) {
        self.name = name
        self.subtitle = subtitle
        self.priceText = priceText
        self.imageUrls = imageUrls
        self.colorOptions = colorOptions
    }
}

// MARK: - Intent match (keyword scaffold — only decides which real pipeline a
// prompt should drive, and as which job kind; all data for the job itself comes
// from the real backend, never from here)

enum AgentPlanGenerator {
    /// Which native job, if any, this prompt should open. Order matters: food
    /// delivery and ride keywords are checked before the broader buy check, since
    /// "order me a" alone would otherwise also satisfy matchesBuy. Restaurant
    /// reservations ("book a table", "dinner") aren't matched at all — there's no
    /// real backend for that yet, so those fall through to real chat same as any
    /// unmatched message.
    static func jobKind(for prompt: String) -> AgentJobKind? {
        let lower = prompt.lowercased()
        if containsFoodKeyword(lower) { return .shopping }
        if containsRideKeyword(lower) { return .ride }
        if matchesBuy(prompt) { return .shopping }
        return nil
    }

    private static func containsRideKeyword(_ lower: String) -> Bool {
        ["uber", "taxi", "cab", "ride home", "book a ride", "book me a ride"].contains { lower.contains($0) }
    }

    private static func containsFoodKeyword(_ lower: String) -> Bool {
        lower.contains("order") && (lower.contains("food") || lower.contains("takeout") || lower.contains("delivery"))
    }

    /// Word-anchored so "card", "care", "scary", "cargo" don't trigger a buy job
    /// (an earlier substring match on "car"/"buy a" hijacked unrelated intents).
    private static func matchesBuy(_ prompt: String) -> Bool {
        let lower = prompt.lowercased()
        let words = Set(lower.split { !$0.isLetter }.map(String.init))
        if words.contains("buy") || words.contains("buying") || words.contains("purchase") { return true }
        return lower.contains("order me a") || lower.contains("i want to buy")
    }
}
