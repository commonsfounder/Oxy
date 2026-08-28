import Foundation

// MARK: - Agent Task Session (real-data native job flows)
//
// A multi-step job surface — working animation, real-data result, confirm — whose steps are
// appended as results arrive from the same backend pipeline chat uses, never scripted up front.
// Three job kinds share the shell: .shopping (browser primitives ending at transaction_authorize,
// the one gated step), .ride (a book_uber deep-link handoff with an estimated fare), and .task
// ("go handle this" from a Home inbox card). A .task with `emailAction` set calls
// /emails/action-plan directly and never touches the chat pipeline, since a bank site can't be
// safely driven by a bot; without it, it watches transaction_authorize like .shopping.

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

    /// Identifies the exact email /emails/action-plan should mine: the provider message id
    /// rather than BriefingEmail's from+subject identity, plus which connector it belongs to.
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

    /// Kicks off the job through the hidden pipeline, mutating `steps` as results arrive.
    /// Never hands off to chat: plain text back from the agent becomes an `.assistantAsk` step
    /// answered in this shell, and only the dock's "Tap to chat" leaves it.
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

    /// Continues the job with the user's answer to an `.assistantAsk` step. The server keys
    /// history by user, so this is what typing the reply in chat would do, without leaving here.
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

    /// "Review & confirm" sends the affirmative reply a person would type, so the agent calls
    /// transaction_authorize itself and every gate that action honours is unchanged. Anything
    /// else back from the agent becomes an `.assistantAsk` step, not a silent handoff.
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
                guard let result = results.first(where: { $0.action == "transaction_authorize" }) else { continue }
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

        let watchedAction = kind == .ride ? "book_uber" : "transaction_authorize"
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
            errorMessage = "Couldn't understand that. Try again."
        } else {
            appendStep(AgentStep(title: title, ui: .assistantAsk(trimmed), ctaLabel: ""))
        }
    }

    /// Calls /emails/action-plan directly — no browser, no chat pipeline — which mines the
    /// original email for real links and writes manual steps. Nothing to retry if it comes
    /// back empty, so that is surfaced as an inline error.
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
            errorMessage = "Couldn't prepare next steps."
        }
    }

    private func updateWorkingStatus(status: String, label: String) {
        guard case .workingHero = currentStep?.ui, !label.isEmpty else { return }
        currentStep?.ui = .workingHero(status: label)
    }

    private func handle(result: ActionResult, fallbackText: String) {
        captureLiveTaskId(result.taskId)
        if result.confirmation == "review_required" {
            let subject = result.subject
            let name = subject?.name ?? title
            title = name
            appendStep(AgentStep(
                title: name,
                ui: .subjectDetail(SubjectDetails(
                    name: name,
                    subtitle: result.text ?? "Ready for your approval",
                    amountText: subject?.amount,
                    imageUrls: subject?.imageUrls ?? [],
                    options: subject?.options ?? []
                )),
                ctaLabel: "Continue"
            ))
            // An amount only earns a payment card when there actually is one. A review pause
            // on a form submission or a cancellation is still a review pause.
            if let amount = subject?.amount {
                appendStep(AgentStep(
                    title: "Confirm",
                    ui: .paymentConfirm(PaymentDetails(
                        merchant: name,
                        amount: amount,
                        detail: result.text ?? "The amount is re-checked before anything is charged."
                    )),
                    ctaLabel: "Review & confirm"
                ))
            }
            return
        }
        if result.success, let subject = result.subject, !subject.isEmpty {
            let name = subject.name ?? title
            title = name
            appendStep(AgentStep(
                title: name,
                ui: .subjectDetail(SubjectDetails(
                    name: name,
                    subtitle: result.text ?? "",
                    amountText: subject.amount,
                    imageUrls: subject.imageUrls ?? []
                )),
                ctaLabel: "Done"
            ))
            return
        }
        // The watched action fired without a product/review card, most likely a clarifying
        // question on the action result. Treated like any reply: a step you can answer.
        finishWithAssistantText(result.text ?? fallbackText)
    }

    /// book_uber is a synchronous deep-link handoff: no review step, no second round trip.
    /// The fare and ETA are our own Routes-based estimate, which the view labels as one.
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

    /// Fetches the step trace for `liveTaskId` — a post-hoc transcript, never a live feed:
    /// the backend only attaches `taskId` to a turn's final action result. Retries up to 3
    /// times for trailing writes, then gives up silently; it is a UI nicety, not an error.
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
        case .paymentConfirm, .subjectDetail, .rideConfirm, .linkResult: return true
        }
    }
}

enum StepUI {
    case paymentConfirm(PaymentDetails)
    case subjectDetail(SubjectDetails)
    case rideConfirm(RideDetails)
    case linkResult(LinkResultDetails)
    /// The agent replied with plain text instead of a watched action, usually a clarifying
    /// question. Rendered with an inline reply field that continues the same conversation.
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
struct SubjectDetails: Equatable {
    let name: String
    let subtitle: String
    /// Money, when the work involves any. A submitted application has none.
    var amountText: String?
    var imageUrls: [String]
    /// Only ever populated when the backend genuinely observed distinct selectable options
    /// on the page (sizes, colours, time slots, delivery choices) — never a default set.
    var options: [String]

    init(name: String, subtitle: String, amountText: String? = nil, imageUrls: [String] = [], options: [String] = []) {
        self.name = name
        self.subtitle = subtitle
        self.amountText = amountText
        self.imageUrls = imageUrls
        self.options = options
    }
}
