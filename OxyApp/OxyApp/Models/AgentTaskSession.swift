import Foundation

// MARK: - Agent Task Session (real-data native buy flow)
//
// A generated multi-step "job" surface for shopping intents: working/searching
// animation -> item detail -> payment confirm. Steps are appended as real data
// arrives from the exact same backend pipeline chat already uses
// (ChatService.sendMessage -> SSE -> agentic loop -> run_browser_task), not
// scripted up front — see docs/superpowers/specs/2026-07-18-real-buy-flow-design.md.

@Observable
final class AgentTaskSession: Identifiable {
    let id = UUID()
    var title: String
    let originalPrompt: String
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
        userId: String,
        chatService: ChatService = ChatService(),
        location: [String: Double]? = nil
    ) {
        self.title = title
        self.originalPrompt = originalPrompt
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

    /// Kicks off the buy job through the real hidden pipeline, mutating `steps` as
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

        let stream = chatService.sendMessage(userId: userId, message: originalPrompt, location: location)
        var sawBrowserAction = false
        for await event in stream {
            switch event {
            case .status(let status, let label):
                updateWorkingStatus(status: status, label: label)
            case .actions(let results):
                guard let result = results.first(where: { $0.action == "run_browser_task" }) else { continue }
                sawBrowserAction = true
                handle(result: result, onHandoff: onHandoff)
            case .error(let message):
                errorMessage = message
                return
            case .done:
                if !sawBrowserAction { onHandoff(nil) }
                return
            default:
                break
            }
        }
        if !sawBrowserAction { onHandoff(nil) }
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
        case .paymentConfirm, .productDetail: return true
        }
    }
}

enum StepUI {
    case paymentConfirm(PaymentDetails)
    case productDetail(ProductDetails)
    case workingHero(status: String)
}

struct PaymentDetails: Equatable {
    let merchant: String
    let amount: String
    let detail: String
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

// MARK: - Intent match (keyword scaffold — only decides whether this is a buy job;
// all data for the job itself comes from the real backend, never from here)

enum AgentPlanGenerator {
    /// Word-anchored so "card", "care", "scary", "cargo" don't trigger a buy job
    /// (an earlier substring match on "car"/"buy a" hijacked unrelated intents).
    static func matchesBuy(_ prompt: String) -> Bool {
        let lower = prompt.lowercased()
        let words = Set(lower.split { !$0.isLetter }.map(String.init))
        if words.contains("buy") || words.contains("buying") || words.contains("purchase") { return true }
        return lower.contains("order me a") || lower.contains("i want to buy")
    }
}
