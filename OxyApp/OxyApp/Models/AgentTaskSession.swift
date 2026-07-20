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
//  - .task: a "go handle this" job kicked off from somewhere other than typed
//    text — e.g. tapping a Home inbox card's judged action ("Pay it", "Sort
//    it") — so the concierge acts on context it already has instead of
//    re-opening chat and re-prompting for the same email. When constructed
//    with `emailAction` set (every inbox-card call site does this), `start()`
//    NEVER touches run_browser_task/the hidden chat pipeline at all — a bank
//    or card-issuer site can't be safely logged into by a bot (2FA, aggressive
//    anti-automation), so that path is deliberately not even attempted. Instead
//    it calls /emails/action-plan directly, which mines the ORIGINAL email for
//    real links the provider already sent and writes manual steps — see
//    buildEmailActionPlan in api/index.js. Without `emailAction` (not used by
//    any call site today, kept for a future non-email "go handle this" job) it
//    falls back to the same run_browser_task watch .shopping uses.
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
    /// `taskId` captured off the watched action's result, once the browser-automation
    /// turn that produced it has already finished (see `fetchLiveSteps` for why this
    /// can never be a genuinely live, in-progress feed).
    var liveTaskId: String?
    /// The step trace fetched for `liveTaskId` — a historical "how I got there"
    /// transcript, not a real-time progress meter.
    var liveSteps: [TaskStep] = []

    private let userId: String
    private let chatService: ChatService
    private let location: [String: Double]?
    private let emailAction: EmailActionContext?

    /// Identifies the exact email /emails/action-plan should mine — the provider message
    /// id, not the from+subject identity BriefingEmail.id uses (fragile/ambiguous across
    /// similar subjects), plus which connector to route to since Gmail/Outlook use
    /// different message ids and different backend actions.
    struct EmailActionContext {
        let provider: String?
        let messageId: String
    }

    init(
        title: String,
        originalPrompt: String,
        kind: AgentJobKind,
        userId: String,
        chatService: ChatService = ChatService(),
        location: [String: Double]? = nil,
        emailAction: EmailActionContext? = nil
    ) {
        self.title = title
        self.originalPrompt = originalPrompt
        self.kind = kind
        self.userId = userId
        self.chatService = chatService
        self.location = location
        self.emailAction = emailAction
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
    /// genuine backend results arrive. Never hands off to chat — when the agent
    /// replies with plain text instead of a watched action (a clarifying question,
    /// most often), that text becomes an `.assistantAsk` step with a reply field
    /// right in this shell; `sendReply` continues the same conversation. The only
    /// remaining honest escape hatch is the dock's explicit "Tap to chat" button,
    /// a deliberate user choice, not an automatic redirect.
    @MainActor
    func start() async {
        guard isWorking == false else { return }
        if let emailAction {
            isWorking = true
            defer { isWorking = false }
            await runEmailAction(emailAction)
            return
        }
        await runTurn(message: originalPrompt)
    }

    /// Continues the job with the user's answer to an `.assistantAsk` step — same
    /// hidden pipeline, same conversation (the server keys history by user, not by
    /// a job-specific session id), so this is exactly what typing the reply in real
    /// chat would do, just without leaving this shell.
    @MainActor
    func sendReply(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isWorking == false, !trimmed.isEmpty else { return }
        appendStep(AgentStep(title: title, status: .active, ui: .workingHero(status: "Thinking…"), ctaLabel: ""))
        await runTurn(message: trimmed)
    }

    /// Re-runs the original ask after a network/backend error — the only case still
    /// shown as an inline error (with its own Retry), never a chat handoff, since
    /// nothing conversational actually happened yet to continue from.
    @MainActor
    func retry() async {
        guard isWorking == false else { return }
        errorMessage = nil
        if let emailAction {
            isWorking = true
            defer { isWorking = false }
            await runEmailAction(emailAction)
            return
        }
        await runTurn(message: originalPrompt)
    }

    /// "Review & confirm" — sends the same affirmative reply a person would type in
    /// chat through the same hidden pipeline, letting the agent call the existing
    /// confirm_browser_payment action itself. No new payment code path; every
    /// safety gate that action already honours (spend cap, card note) is unchanged.
    /// If the agent comes back with something other than that action (rare — e.g. it
    /// wants to double-check a detail first), that's the same conversational case as
    /// everywhere else: an `.assistantAsk` step, not a silent handoff.
    @MainActor
    func confirmPayment() async {
        guard isWorking == false else { return }
        isWorking = true
        defer { isWorking = false }

        let stream = chatService.sendMessage(
            userId: userId,
            message: "Yes, go ahead and confirm the payment.",
            location: location
        )
        var assistantText = ""
        for await event in stream {
            switch event {
            case .text(let chunk):
                assistantText += chunk
            case .replace(let replacement):
                assistantText = replacement
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
                finishWithAssistantText(assistantText)
                return
            default:
                break
            }
        }
        finishWithAssistantText(assistantText)
    }

    private func runTurn(message: String) async {
        isWorking = true
        defer { isWorking = false }

        let watchedAction = kind == .ride ? "book_uber" : "run_browser_task"
        let stream = chatService.sendMessage(userId: userId, message: message, location: location)
        var sawWatchedAction = false
        var assistantText = ""
        for await event in stream {
            switch event {
            case .status(let status, let label):
                updateWorkingStatus(status: status, label: label)
            case .text(let chunk):
                assistantText += chunk
            case .replace(let replacement):
                assistantText = replacement
            case .actions(let results):
                guard let result = results.first(where: { $0.action == watchedAction }) else { continue }
                sawWatchedAction = true
                if kind == .ride {
                    handleRide(result: result)
                } else {
                    handle(result: result, fallbackText: assistantText)
                }
            case .error(let message):
                errorMessage = message
                return
            case .done:
                if !sawWatchedAction { finishWithAssistantText(assistantText) }
                return
            default:
                break
            }
        }
        if !sawWatchedAction { finishWithAssistantText(assistantText) }
    }

    /// The honest terminus for a turn that never called the watched action: if the
    /// model said something, show it as a step you can reply to; if it genuinely
    /// said nothing, that's a real (rare) failure, not silent — surface it inline.
    private func finishWithAssistantText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            errorMessage = "Didn't get a clear answer back — try again or rephrase."
        } else {
            appendStep(AgentStep(title: title, ui: .assistantAsk(trimmed), ctaLabel: ""))
        }
    }

    /// Never touches run_browser_task or the hidden chat pipeline — calls
    /// /emails/action-plan directly, which mines the ORIGINAL email for real links the
    /// provider already sent and writes manual steps. It doesn't attempt to log into
    /// anything, so there's nothing to retry conversationally if it comes back empty —
    /// that's a real dead end, surfaced as an inline error.
    private func runEmailAction(_ context: EmailActionContext) async {
        do {
            let plan = try await chatService.emailActionPlan(
                userId: userId,
                provider: context.provider,
                messageId: context.messageId
            )
            let steps = plan.steps ?? []
            let links = plan.links ?? []
            guard plan.success, !steps.isEmpty || !links.isEmpty else {
                errorMessage = plan.error ?? "Couldn't find anything actionable in that email."
                return
            }
            appendStep(AgentStep(
                title: title,
                ui: .linkResult(LinkResultDetails(steps: steps, links: links)),
                ctaLabel: "Done"
            ))
        } catch {
            errorMessage = "Couldn't put together next steps for that email."
        }
    }

    private func updateWorkingStatus(status: String, label: String) {
        guard case .workingHero = currentStep?.ui, !label.isEmpty else { return }
        currentStep?.ui = .workingHero(status: label)
    }

    private func handle(result: ActionResult, fallbackText: String) {
        captureLiveTaskId(result.taskId)
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
        // The watched action fired but didn't come back as a product/review card —
        // most likely a clarifying question attached to the action result itself
        // rather than the plain stream text. Same honest treatment as any other
        // conversational reply: a step you can answer, not a silent redirect.
        finishWithAssistantText(result.text ?? fallbackText)
    }

    /// book_uber is a synchronous deep-link handoff (executionMode: 'direct',
    /// confirmation: 'none') — no review step, no second network round trip.
    /// `cardText`'s fare/ETA is Oxy's own estimate (Google Routes based), not a
    /// live Uber quote, so RideConfirmStepView labels it honestly as an estimate.
    private func handleRide(result: ActionResult) {
        captureLiveTaskId(result.taskId)
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

    /// Records the finished task's id and kicks off a best-effort fetch of its step
    /// trace. Only set once per session (the id is stable for the run that produced it).
    private func captureLiveTaskId(_ taskId: String?) {
        guard let taskId, !taskId.isEmpty, taskId != liveTaskId else { return }
        liveTaskId = taskId
        Task { await fetchLiveSteps() }
    }

    /// Fetches the recorded step trace for `liveTaskId` — always a POST-HOC transcript
    /// of a browser-automation run that has already finished by the time this session
    /// learns its id (the backend only attaches `taskId` to the FINAL action result of
    /// a chat turn). This is never a live, in-progress feed; a true live feed would
    /// require restructuring the SSE pipeline to stream step events mid-turn, which is
    /// out of scope here. A short bounded retry (up to 3 attempts, a second apart)
    /// covers any trailing async writes still landing right after the turn ends — it
    /// does not poll indefinitely, since there is nothing further to observe once the
    /// task is done. Failures are swallowed: this is a best-effort UI nicety, never
    /// something worth surfacing as a user-facing error.
    @MainActor
    func fetchLiveSteps() async {
        guard let taskId = liveTaskId else { return }
        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            guard let steps = try? await TaskStepsService.fetchSteps(taskId: taskId) else { continue }
            if !steps.isEmpty {
                liveSteps = steps
                return
            }
        }
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
        case .workingHero, .assistantAsk: return false
        case .paymentConfirm, .productDetail, .rideConfirm, .linkResult: return true
        }
    }
}

enum StepUI {
    case paymentConfirm(PaymentDetails)
    case productDetail(ProductDetails)
    case rideConfirm(RideDetails)
    case linkResult(LinkResultDetails)
    /// The agent replied with plain text instead of calling a watched action — most
    /// often a clarifying question. Rendered with an inline reply field; answering
    /// calls `AgentTaskSession.sendReply` to continue the same conversation, never a
    /// handoff to chat.
    case assistantAsk(String)
    case workingHero(status: String)
}

/// Real steps + real links mined from an email by /emails/action-plan — never a
/// fabricated URL; every link's exact URL came from the email itself (see
/// buildEmailActionPlan's server-side check), the model only selects and labels.
struct LinkResultDetails: Equatable {
    let steps: [String]
    let links: [EmailActionLink]
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
