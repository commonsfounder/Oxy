import Foundation
import Observation
import UIKit

private final class NativeActionTimeoutBox: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    func resume(_ continuation: CheckedContinuation<NativeLocalActionResult?, Never>, with result: NativeLocalActionResult?) {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return }
        didResume = true
        continuation.resume(returning: result)
    }
}

enum ActivityStepState: String, Equatable {
    case pending
    case active
    case complete
    case failed
}

struct ActivityStep: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var state: ActivityStepState
}

private struct QueuedTurn {
    let text: String
    let messageID: UUID
    let userId: String
}

@Observable
@MainActor
final class ChatViewModel {
    var messages: [Message] = []
    var inputText = ""
    var isSending = false
    var statusLabel: String?
    var activeTurnUserMessageID: UUID?
    var activitySteps: [ActivityStep] = []
    var scrollTargetMessageID: UUID?
    var isViewingHistorySnapshot = false
    var historySnapshotLabel: String?
    var networkError: String?
    /// When true, this turn is not persisted server-side (shadow / incognito chat).
    var incognito = false

    /// Called on the main actor when a silent pendant execution finishes.
    var onSilentExecComplete: (() -> Void)?

    @ObservationIgnored private var currentSendTask: Task<Void, Never>?
    @ObservationIgnored private var sendWatchdogTask: Task<Void, Never>?
    @ObservationIgnored private var activeChatStartedAt: String?
    @ObservationIgnored private var pendingLocalAction: ActionResult?
    @ObservationIgnored private var lastFailedText: String?
    @ObservationIgnored private var lastFailedUserMessageID: UUID?
    @ObservationIgnored private var lastFailedAssistantMessageID: UUID?
    @ObservationIgnored private var queuedTurns: [QueuedTurn] = []

    // Sent instead of typed text to silently keep an in-progress browser/ordering task
    // moving — never shown as a chat bubble, must match BROWSER_TASK_CONTINUE in api/index.js.
    private static let browserTaskContinueSentinel = "__oxy_continue_browser_task__"
    // Pure client-side safety net. Sits just above the server's runaway backstop (40, in
    // browser-task.js) so the server's graceful "keep trying?" check-in is what surfaces;
    // this only trips if the server somehow keeps saying "still working" past that.
    private static let maxBrowserAutoContinues = 45

    private let chatService = ChatService()
    private let locationManager = LocationManager.shared
    private let nativeManager = NativeIntegrationManager.shared

    private var currentSettings: OxySettings {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            return saved
        }
        return OxySettings()
    }

    private static let autoOpenActions: Set<String> = [
        "book_uber",
        "make_call", "add_to_music_playlist", "open_app"
    ]

    private static let localRequestTerms = [
        "uber", "ride", "taxi", "nearest", "closest", "near me", "nearby",
        "place", "maps", "mcdonald", "john lewis", "gym", "restaurant", "cafe", "coffee",
        "shop", "supermarket", "store", "pharmacy", "station", "cinema",
        "bank", "atm", "directions", "navigate", "route", "bus", "buses", "transit",
        "public transport", "walk", "walking", "drive", "driving",
        // Rail journeys are route planning too — they need an origin, so the activity
        // must fetch location. Dropped during the "Improve chat activity" pass, which
        // broke the DEBUG runChatUXRuleCheck contract (train query → one location step).
        "train", "rail"
    ]

    func prepareChat(userId: String) async {
        #if DEBUG
        Self.runSessionRuleCheck()
        Self.runChatUXRuleCheck()
        #endif
        activeChatStartedAt = chatStartedAt(for: userId)
        await loadHistory(userId: userId)
    }

    func loadHistory(userId: String) async {
        do {
            let entries = try await chatService.loadHistory(userId: userId, since: activeChatStartedAt)
            let loaded = messages(from: entries)
            await MainActor.run {
                messages = loaded
                scrollTargetMessageID = nil
                isViewingHistorySnapshot = false
                historySnapshotLabel = nil
            }
        } catch {
            print("[ChatVM] History load failed: \(error.localizedDescription)")
        }
    }

    func loadHistoryAround(userId: String, createdAt: String, messageId: String? = nil) async {
        do {
            let entries = try await chatService.loadHistoryAround(userId: userId, createdAt: createdAt, messageId: messageId)
            let loaded = messages(from: entries)
            let targetID = closestMessageID(in: loaded, to: createdAt, messageId: messageId)
            let label = historyLabel(for: createdAt)
            await MainActor.run {
                messages = loaded
                statusLabel = nil
                isViewingHistorySnapshot = true
                historySnapshotLabel = label
                scrollTargetMessageID = targetID
            }
        } catch {
            print("[ChatVM] History-around load failed: \(error.localizedDescription)")
        }
    }

    func returnToCurrentChat(userId: String) async {
        activeChatStartedAt = chatStartedAt(for: userId)
        await loadHistory(userId: userId)
    }

    func startNewChat(userId: String) {
        clearChat()
        let startedAt = Date().oxyISO8601String
        activeChatStartedAt = startedAt
        UserDefaults.standard.set(startedAt, forKey: chatStartedAtKey(userId))
        UserDefaults.standard.set(startedAt, forKey: lastActivityKey(userId))
        isViewingHistorySnapshot = false
        historySnapshotLabel = nil
        nativeManager.resetConversationContext()
        // Abandon any in-progress browser/ordering session server-side so this fresh
        // chat isn't hijacked by a still-running order's input latch. Best-effort.
        Task {
            _ = try? await APIClient.shared.request(
                path: "/browser-session/\(userId)/close",
                method: "POST"
            )
        }
    }

    func sendMessage(userId: String) {
        sendMessage(userId: userId, retryingUserMessageID: nil)
    }

    private func sendMessage(userId: String, retryingUserMessageID: UUID?) {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if isSending, retryingUserMessageID == nil {
            enqueueTurn(text, userId: userId)
            return
        }
        if isViewingHistorySnapshot {
            startNewChat(userId: userId)
        }
        if activeChatStartedAt == nil {
            activeChatStartedAt = chatStartedAt(for: userId)
        }
        markChatActivity(for: userId)
        let pendingDecision = localActionDecision(for: text)
        devTiming("user_message_received", [
            "messageLength": text.count,
            "isRetry": retryingUserMessageID != nil
        ])

        inputText = ""
        isSending = true
        statusLabel = nil
        networkError = nil
        activitySteps = Self.activityTemplate(for: text)

        let userMessageID: UUID
        if let retryingUserMessageID,
           messages.contains(where: { $0.id == retryingUserMessageID && $0.role == .user }) {
            userMessageID = retryingUserMessageID
        } else {
            let userMessage = Message(role: .user, content: text)
            messages.append(userMessage)
            userMessageID = userMessage.id
        }
        activeTurnUserMessageID = userMessageID
        // Only drop the previous partial-failure bubble when this send is actually
        // retrying that same turn — an unrelated new message shouldn't erase a
        // still-visible (if incomplete) reply from an earlier failed turn.
        if retryingUserMessageID != nil, let lastFailedAssistantMessageID {
            removeMessage(id: lastFailedAssistantMessageID)
            self.lastFailedAssistantMessageID = nil
        }

        let assistantMessage = Message(role: .assistant, content: "", isStreaming: true)
        messages.append(assistantMessage)
        let assistantID = assistantMessage.id

        let settings = currentSettings
        let needsFreshLocation = shouldFetchLocation(for: text)
        startSendWatchdog(assistantID: assistantID)

        currentSendTask = Task {
            defer {
                Task { @MainActor in
                    sendWatchdogTask?.cancel()
                    sendWatchdogTask = nil
                }
            }

            if let pendingAction = pendingLocalAction, let pendingDecision {
                await MainActor.run {
                    pendingLocalAction = nil
                    _ = updateAssistantMessage(id: assistantID) {
                        if pendingDecision {
                            $0.content = "Opening \(pendingAction.cardText ?? "that app")."
                            $0.actions = [pendingAction]
                            openActionLink(pendingAction)
                        } else {
                            $0.content = "Cancelled."
                            $0.actions = []
                        }
                        $0.isStreaming = false
                    }
                    statusLabel = nil
                    isSending = false
                    currentSendTask = nil
                    finishActivity()
                    drainQueuedTurns()
                }
                if pendingDecision {
                    await chatService.logNativeLocalAction(
                        userId: userId,
                        message: text,
                        result: pendingAction,
                        chatStartedAt: activeChatStartedAt
                    )
                }
                return
            } else if pendingDecision == nil {
                await MainActor.run {
                    pendingLocalAction = nil
                }
            }

            var location = locationManager.locationDict
            if needsFreshLocation {
                await MainActor.run {
                    statusLabel = "Checking location"
                    setActivity("Getting your location", state: .active)
                    devTiming("location_lookup_start", ["hadCachedLocation": location != nil])
                }
                location = await locationManager.currentLocationForLocalRequest() ?? location
                await MainActor.run {
                    setActivity("Getting your location", state: location == nil ? .failed : .complete)
                    devTiming("location_lookup_end", ["success": location != nil])
                }
            }

            if let localResult = await executeLocalRequestWithTimeout(text) {
                let actionResult = ActionResult(native: localResult)
                let holdForConfirmation = shouldHoldForLocalConfirmation(actionResult, settings: settings)
                await MainActor.run {
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.content = holdForConfirmation ? confirmationPrompt(for: actionResult) : localResult.text
                        $0.actions = [actionResult]
                        $0.isStreaming = false
                    }
                    statusLabel = nil
                    isSending = false
                    currentSendTask = nil
                    finishActivity()
                    if holdForConfirmation {
                        pendingLocalAction = actionResult
                    } else if shouldAutoOpen(actionResult, settings: settings) {
                        openActionLink(actionResult)
                    }
                    drainQueuedTurns()
                }
                await chatService.logNativeLocalAction(
                    userId: userId,
                    message: text,
                    result: actionResult,
                    chatStartedAt: activeChatStartedAt
                )
                return
            }

            let nativeHints = await nativeManager.localContextHints(for: text)

            let stream = chatService.sendMessage(
                userId: userId,
                message: text,
                chatStartedAt: activeChatStartedAt,
                settings: settings,
                location: location,
                nativeHints: nativeHints,
                incognito: incognito
            )
            await MainActor.run { HapticManager.shared.impact(.light) }
            var fullText = ""
            var textEventCount = 0
            var needsBrowserContinue = false

            for await event in stream {
                if Task.isCancelled { break }
                switch event {
                case .text(let chunk):
                    fullText += chunk
                    textEventCount += 1
                    await MainActor.run {
                        print("[ChatStream] text_event=\(textEventCount) chunk_chars=\(chunk.count) total_chars=\(fullText.count)")
                        guard updateAssistantMessage(id: assistantID, { $0.content = fullText }) else { return }
                        setActivity("Preparing result", state: .active)
                        statusLabel = nil
                    }
                    await Task.yield()

                case .replace(let replacement):
                    await MainActor.run {
                        print("[ChatStream] replace chars=\(replacement.count) after_text_events=\(textEventCount)")
                        fullText = replacement
                        guard updateAssistantMessage(id: assistantID, { $0.content = fullText }) else { return }
                        setActivity("Preparing result", state: .active)
                    }

                case .actions(let results):
                    await MainActor.run {
                        guard updateAssistantMessage(id: assistantID, { $0.actions.merging(results) }) else { return }
                        markActionsComplete(results)
                        openDeepLinks(results)
                        if results.contains(where: { $0.success }) {
                            HapticManager.shared.success()
                        } else if results.contains(where: { !$0.success }) {
                            HapticManager.shared.warning()
                        }
                        // "Browser task paused" just means the ordering loop is still
                        // working and hit its per-turn time budget — not a real question.
                        // Keep it moving ourselves instead of making the user say "keep going".
                        if results.contains(where: { $0.actionSummary == "Browser task paused" || $0.recoveryAction?.autoContinue == true }) {
                            needsBrowserContinue = true
                        }
                        Task {
                            await playBackendMusicActions(results, assistantID: assistantID, userId: userId, originalMessage: text)
                        }
                    }

                case .status(let status, let label):
                    await MainActor.run {
                        setStatus(status, label)
                        updateActivity(status: status, label: label)
                    }

                case .transcription:
                    break

                case .transcriptionError(let error):
                    await MainActor.run {
                        guard updateAssistantMessage(id: assistantID, { $0.content = error }) else { return }
                        failActiveActivity()
                        statusLabel = nil
                    }

                case .sources(let sources):
                    await MainActor.run {
                        guard updateAssistantMessage(id: assistantID, { $0.sources = sources }) else { return }
                    }

                case .done:
                    await MainActor.run {
                        if textEventCount > 0 {
                            _ = updateAssistantMessage(id: assistantID, { $0.content = fullText })
                        }
                        print("[ChatStream] done text_events=\(textEventCount) total_chars=\(fullText.count)")
                        _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                        statusLabel = nil
                        networkError = nil
                        lastFailedText = nil
                        lastFailedUserMessageID = nil
                        lastFailedAssistantMessageID = nil
                        isSending = false
                        currentSendTask = nil
                        finishActivity()
                        HapticManager.shared.impact(.soft)
                    }

                case .error(let error):
                    await MainActor.run {
                        lastFailedText = text
                        lastFailedUserMessageID = userMessageID
                        HapticManager.shared.error()
                        let friendly = friendlyNetworkError(error)
                        _ = updateAssistantMessage(id: assistantID) {
                            $0.isStreaming = false
                            $0.turnError = friendly
                        }
                        lastFailedAssistantMessageID = assistantID
                        networkError = nil
                        statusLabel = nil
                        isSending = false
                        currentSendTask = nil
                        failActiveActivity()
                    }
                }
            }

            if needsBrowserContinue, !Task.isCancelled {
                await continueBrowserTask(userId: userId, assistantID: assistantID)
            }

            await MainActor.run {
                _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                isSending = false
                statusLabel = nil
                currentSendTask = nil
                finishActivity()
                drainQueuedTurns()
            }
        }
    }

    func sendCommand(_ command: String, userId: String) {
        inputText = command
        sendMessage(userId: userId)
    }

    /// Execute a voice command silently — runs through local actions + API
    /// but does NOT add user/assistant message bubbles to the chat.
    func executeSilently(_ command: String, userId: String) {
        let rawText = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty, !isSending else { return }
        print("[ChatVM] Silent exec (raw): \(rawText)")

        if activeChatStartedAt == nil {
            activeChatStartedAt = chatStartedAt(for: userId)
        }

        isSending = true
        let settings = currentSettings

        Task {
            defer {
                Task { @MainActor in
                    self.isSending = false
                    self.onSilentExecComplete?()
                }
            }

            // Polish the raw transcript — removes filler words, fixes grammar
            let text = await chatService.polishTranscript(userId: userId, transcript: rawText)
            if text != rawText {
                print("[ChatVM] Polished: \(text)")
            }

            // Try local actions first (music, reminders, etc.)
            if let localResult = await executeLocalRequestWithTimeout(text) {
                let actionResult = ActionResult(native: localResult)
                print("[ChatVM] Silent local result: \(localResult.text)")
                await MainActor.run {
                    let hasLink = actionResult.deepLink != nil || actionResult.webLink != nil
                    if actionResult.success && hasLink && !shouldHoldForLocalConfirmation(actionResult, settings: settings) {
                        openActionLink(actionResult)
                    }
                }
                await chatService.logNativeLocalAction(
                    userId: userId,
                    message: text,
                    result: actionResult,
                    chatStartedAt: activeChatStartedAt
                )
                return
            }

            // Fall back to API
            let nativeHints = await nativeManager.localContextHints(for: text)
            let location = locationManager.locationDict

            let stream = chatService.sendMessage(
                userId: userId,
                message: text,
                chatStartedAt: activeChatStartedAt,
                settings: settings,
                location: location,
                nativeHints: nativeHints,
                incognito: incognito
            )

            for await event in stream {
                if Task.isCancelled { break }
                await MainActor.run {
                    switch event {
                    case .actions(let results):
                        // In silent pendant mode, open any successful action with a link —
                        // the user spoke the command so no whitelist gating needed.
                        for result in results where result.success {
                            let hasLink = result.deepLink != nil || result.webLink != nil
                            if hasLink && !self.shouldHoldForLocalConfirmation(result, settings: settings) {
                                self.openActionLink(result)
                            }
                        }
                        // Resolve music play actions natively for gapless playback
                        for result in results where result.action == "play_music" && result.success {
                            let query = (result.cardText ?? result.text ?? "")
                                .replacingOccurrences(of: #"(?i)^playing\s+"#, with: "", options: .regularExpression)
                                .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
                            if !query.isEmpty {
                                Task {
                                    _ = await self.executeNativeMusicWithTimeout(query: query)
                                }
                            }
                        }
                    case .done, .error:
                        break
                    default:
                        break
                    }
                }
            }
        }
    }

    /// Silently keeps an "awaiting_more" browser/ordering task moving — no new chat
    /// bubble, no typing required. Updates the same assistant message in place and
    /// loops itself as long as the loop keeps reporting "still working", stopping the
    /// moment it needs a real answer, payment confirmation, or hits done/error.
    private func continueBrowserTask(userId: String, assistantID: UUID, attempt: Int = 1) async {
        // Runaway backstop. Don't freeze silently on the spinner — the server keeps the
        // session resumable, so tell the user it's still going and how to nudge it.
        guard attempt <= Self.maxBrowserAutoContinues else {
            await MainActor.run {
                _ = updateAssistantMessage(id: assistantID, {
                    $0.content = "This order's taking a lot of steps — I've paused so it doesn't run away. Say \"keep going\" and I'll pick up where I left off."
                    $0.isStreaming = false
                })
                isSending = false
                statusLabel = nil
                activeTurnUserMessageID = nil
                activitySteps = []
            }
            return
        }

        await MainActor.run {
            isSending = true
            statusLabel = "Still working on your order…"
            // Each turn gets its own 45s budget, same as a fresh send — the chain as a
            // whole can run for minutes, but any single round trip is still watchdogged.
            startSendWatchdog(assistantID: assistantID)
        }

        let stream = chatService.sendMessage(
            userId: userId,
            message: Self.browserTaskContinueSentinel,
            chatStartedAt: activeChatStartedAt,
            settings: currentSettings,
            location: locationManager.locationDict,
            incognito: incognito
        )

        var turnText = ""
        var needsMore = false

        for await event in stream {
            if Task.isCancelled { break }
            await MainActor.run {
                switch event {
                case .text(let chunk):
                    turnText += chunk
                case .replace(let replacement):
                    turnText = replacement
                case .actions(let results):
                    if results.contains(where: { $0.actionSummary == "Browser task paused" || $0.recoveryAction?.autoContinue == true }) {
                        // Pure "still working" signal — keep continuing, but don't paint a
                        // "Paused" card on the live bubble. Only terminal turns get a card.
                        needsMore = true
                    } else {
                        _ = updateAssistantMessage(id: assistantID, { $0.actions.merging(results) })
                        openDeepLinks(results)
                    }
                case .status(let status, let label):
                    setStatus(status, label)
                case .error(let error):
                    networkError = friendlyNetworkError(error)
                default:
                    break
                }
            }
        }

        if !turnText.isEmpty {
            await MainActor.run {
                _ = updateAssistantMessage(id: assistantID, { $0.content = turnText })
            }
        }

        if needsMore {
            await continueBrowserTask(userId: userId, assistantID: assistantID, attempt: attempt + 1)
        }
    }

    func retryLastFailedMessage(userId: String) {
        guard let lastFailedText, let lastFailedUserMessageID, !isSending else { return }
        networkError = nil
        inputText = lastFailedText
        sendMessage(userId: userId, retryingUserMessageID: lastFailedUserMessageID)
    }

    func sendImageMessage(userId: String, imageData: Data, fileName: String, mimeType: String, isImage: Bool = true) {
        let typed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = typed.isEmpty
            ? (isImage ? "Look at this image and tell me what you see." : "Read this file and tell me what's in it.")
            : typed
        guard !isSending else { return }
        if isViewingHistorySnapshot {
            startNewChat(userId: userId)
        }
        if activeChatStartedAt == nil {
            activeChatStartedAt = chatStartedAt(for: userId)
        }

        inputText = ""
        isSending = true
        statusLabel = isImage ? "Looking at image" : "Reading file"
        activitySteps = [
            ActivityStep(title: isImage ? "Looking at image" : "Reading file", state: .active),
            ActivityStep(title: "Preparing result", state: .pending)
        ]
        networkError = nil

        let attachmentTag = isImage ? "[Image attached]" : "[File attached: \(fileName)]"
        let userMessage = Message(role: .user, content: "\(text)\n\(attachmentTag)")
        messages.append(userMessage)
        activeTurnUserMessageID = userMessage.id

        let assistantMessage = Message(role: .assistant, content: "", isStreaming: true)
        messages.append(assistantMessage)
        let assistantID = assistantMessage.id
        let settings = currentSettings
        startSendWatchdog(assistantID: assistantID)

        currentSendTask = Task {
            defer {
                Task { @MainActor in
                    sendWatchdogTask?.cancel()
                    sendWatchdogTask = nil
                }
            }
            await MainActor.run { HapticManager.shared.impact(.light) }
            do {
                let response = try await chatService.sendImageMessage(
                    userId: userId,
                    message: text,
                    imageData: imageData,
                    fileName: fileName,
                    mimeType: mimeType,
                    chatStartedAt: activeChatStartedAt,
                    settings: settings
                )
                let actions = response.actions ?? []
                await MainActor.run {
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.content = response.text
                        $0.actions = actions
                        $0.isStreaming = false
                    }
                    openDeepLinks(actions)
                    statusLabel = nil
                    networkError = nil
                    lastFailedText = nil
                    isSending = false
                    currentSendTask = nil
                    finishActivity()
                    HapticManager.shared.impact(.soft)
                    drainQueuedTurns()
                }
            } catch {
                await MainActor.run {
                    lastFailedText = text
                    lastFailedUserMessageID = userMessage.id
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.isStreaming = false
                        $0.turnError = friendlyNetworkError(error.localizedDescription)
                    }
                    lastFailedAssistantMessageID = assistantID
                    networkError = nil
                    statusLabel = nil
                    isSending = false
                    currentSendTask = nil
                    failActiveActivity()
                    HapticManager.shared.error()
                    drainQueuedTurns()
                }
            }
        }
    }

    func clearChat() {
        currentSendTask?.cancel()
        currentSendTask = nil
        sendWatchdogTask?.cancel()
        sendWatchdogTask = nil
        pendingLocalAction = nil
        lastFailedText = nil
        lastFailedUserMessageID = nil
        lastFailedAssistantMessageID = nil
        messages.removeAll()
        inputText = ""
        isSending = false
        statusLabel = nil
        activeTurnUserMessageID = nil
        activitySteps = []
        queuedTurns.removeAll()
        networkError = nil
        scrollTargetMessageID = nil
        isViewingHistorySnapshot = false
        historySnapshotLabel = nil
    }

    func requestLocationAccess() {
        locationManager.requestPermission()
    }

    private func messages(from entries: [HistoryEntry]) -> [Message] {
        entries.compactMap { entry -> Message? in
            guard let role = Message.Role(rawValue: entry.role) else { return nil }
            return Message(
                dbId: entry.id,
                role: role,
                content: entry.content,
                timestamp: Date.oxyParse(entry.createdAt) ?? Date(),
                actions: entry.actions ?? [],
                sources: entry.sources ?? []
            )
        }
    }

    // Resume the current session only if it's still "live" by the same rule the
    // server uses to group sessions (`buildConversationSessions`): less than 45
    // minutes since the last activity AND the same calendar day. Otherwise start
    // a fresh session. This keeps the client's notion of the active chat aligned
    // with the sidebar's session list — reopening the app the next day (or after
    // a long idle) no longer feeds yesterday's messages into the current context.
    // Must match the server's buildConversationSessions grouping.
    static let sessionReuseWindow: TimeInterval = 45 * 60
    static func canReuseSession(lastActivity: Date, now: Date) -> Bool {
        now.timeIntervalSince(lastActivity) < sessionReuseWindow
            && Calendar.current.isDate(lastActivity, inSameDayAs: now)
    }

    #if DEBUG
    static func runSessionRuleCheck() {
        let now = Calendar.current.startOfDay(for: Date()).addingTimeInterval(12 * 60 * 60) // midday
        assert(canReuseSession(lastActivity: now.addingTimeInterval(-10 * 60), now: now), "recent same-day should reuse")
        assert(!canReuseSession(lastActivity: now.addingTimeInterval(-46 * 60), now: now), "past window should start new")
        assert(!canReuseSession(lastActivity: now.addingTimeInterval(-13 * 60 * 60), now: now), "different day should start new")
    }

    static func runChatUXRuleCheck() {
        let trainSteps = activityTemplate(for: "How do I get to Kings Langley by train?")
        assert(trainSteps.filter { $0.title == "Getting your location" }.count == 1, "activity should include one location step")
        assert(trainSteps.contains { $0.title == "Finding routes" }, "train activity should find routes")
        assert(trainSteps.contains { $0.title == "Checking train options" }, "train activity should check train options")
        assert(trainSteps.last?.title == "Preparing result", "activity should end with result preparation")

        let drivingSteps = activityTemplate(for: "Drive to Birmingham International")
        assert(drivingSteps.contains { $0.title == "Finding routes" }, "driving activity should find routes")
        assert(!drivingSteps.contains { $0.title == "Checking train options" }, "driving activity should not show train-only work")

        let queued = Message(role: .user, content: "I'm taking a train", queuedForActiveTask: true)
        assert(queued.queuedForActiveTask, "correction message should be visibly queueable")

        let fixture = """
        {
          "action": "get_directions",
          "success": true,
          "headline": "1h 48m · 10:12-12:00",
          "bookingUrl": "https://www.thetrainline.com/search",
          "routeContext": { "origin": "Solihull", "destination": "Kings Langley", "mode": "rail", "departure": "10:12", "arrival": "12:00", "duration": "1h 48m" },
          "itinerary": [
            { "type": "transit", "service": "X1 bus", "from": "Solihull", "to": "Birmingham International", "duration": "24 min" },
            { "type": "rail", "service": "Avanti West Coast", "from": "Birmingham International", "to": "Milton Keynes Central", "duration": "1h 8m" }
          ]
        }
        """.data(using: .utf8)!
        let action = try? JSONDecoder().decode(ActionResult.self, from: fixture)
        assert(action?.itinerary?.count == 2, "train route should decode structured legs for card rendering")
        assert(action?.routeContext?.duration == "1h 48m", "route duration should decode for card rendering")
    }
    #endif

    private func chatStartedAt(for userId: String) -> String {
        let key = chatStartedAtKey(userId)
        let now = Date()
        if let saved = UserDefaults.standard.string(forKey: key),
           Date.oxyParse(saved) != nil,
           let lastActivity = UserDefaults.standard.string(forKey: lastActivityKey(userId)).flatMap(Date.oxyParse),
           Self.canReuseSession(lastActivity: lastActivity, now: now) {
            return saved
        }
        let startedAt = now.oxyISO8601String
        UserDefaults.standard.set(startedAt, forKey: key)
        UserDefaults.standard.set(startedAt, forKey: lastActivityKey(userId))
        return startedAt
    }

    /// Stamp the active session's last-activity time. Called whenever the user
    /// sends a message so the 45-minute reuse window in `chatStartedAt(for:)`
    /// tracks real activity rather than when the session first opened.
    private func markChatActivity(for userId: String) {
        UserDefaults.standard.set(Date().oxyISO8601String, forKey: lastActivityKey(userId))
    }

    private func devTiming(_ event: String, _ fields: [String: Any] = [:]) {
        #if DEBUG
        var payload = fields
        payload["area"] = "chat_ui"
        payload["event"] = event
        payload["t"] = Date().oxyISO8601String
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            print("[dev-timing] \(text)")
        }
        #endif
    }

    private func chatStartedAtKey(_ userId: String) -> String {
        "oxy_current_chat_started_at_\(userId)"
    }

    private func lastActivityKey(_ userId: String) -> String {
        "oxy_current_chat_last_activity_\(userId)"
    }

    private func closestMessageID(in messages: [Message], to createdAt: String, messageId: String? = nil) -> UUID? {
        if let messageId, let exact = messages.first(where: { $0.dbId == messageId }) {
            return exact.id
        }
        guard let target = Date.oxyParse(createdAt) else { return nil }
        return messages
            .min(by: { abs($0.timestamp.timeIntervalSince(target)) < abs($1.timestamp.timeIntervalSince(target)) })?
            .id
    }

    private func historyLabel(for createdAt: String) -> String? {
        guard let date = Date.oxyParse(createdAt) else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM yyyy · HH:mm"
        return formatter.string(from: date)
    }

    @discardableResult
    private func updateAssistantMessage(id: UUID, _ update: (inout Message) -> Void) -> Bool {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return false }
        update(&messages[index])
        return true
    }

    private func removeMessage(id: UUID) {
        messages.removeAll { $0.id == id }
    }

    private func enqueueTurn(_ text: String, userId: String) {
        inputText = ""
        let queued = Message(role: .user, content: text, queuedForActiveTask: true)
        messages.append(queued)
        queuedTurns.append(QueuedTurn(text: text, messageID: queued.id, userId: userId))
        markChatActivity(for: userId)
    }

    private func drainQueuedTurns() {
        guard !isSending, let next = queuedTurns.first else { return }
        queuedTurns.removeFirst()
        if let index = messages.firstIndex(where: { $0.id == next.messageID }) {
            messages[index].queuedForActiveTask = false
        }
        inputText = next.text
        sendMessage(userId: next.userId, retryingUserMessageID: next.messageID)
    }

    private static func activityTemplate(for text: String) -> [ActivityStep] {
        let lower = text.lowercased()
        var titles: [String] = []
        let needsLocation = shouldFetchLocationText(lower)
        if needsLocation {
            titles.append("Getting your location")
        }
        if lower.contains("fare") || lower.contains("ticket") || lower.contains("trainline") {
            titles.append("Checking fares")
        }
        if lower.contains("train") || lower.contains("rail") {
            titles.append("Finding routes")
            titles.append("Checking train options")
        } else if lower.contains("bus") || lower.contains("transit") || lower.contains("public transport") || lower.contains("directions") || lower.contains("route") {
            titles.append("Finding routes")
        } else if lower.contains("drive") || lower.contains("driving") || lower.contains("navigate") {
            titles.append("Finding routes")
        }
        titles.append("Preparing result")
        var seen = Set<String>()
        return titles
            .filter { seen.insert($0).inserted }
            .map { ActivityStep(title: $0, state: .pending) }
    }

    private static func shouldFetchLocationText(_ lower: String) -> Bool {
        if lower.hasPrefix("remember ") || lower.hasPrefix("save ") || lower.hasPrefix("note down ") {
            return false
        }
        if lower.contains("play ") || lower.contains("pause") || lower.contains("playlist") || lower.contains("song") {
            return false
        }
        return localRequestTerms.contains { lower.contains($0) }
    }

    private func setActivity(_ title: String, state: ActivityStepState) {
        guard !activitySteps.isEmpty else { return }
        if let index = activitySteps.firstIndex(where: { $0.title == title }) {
            activitySteps[index].state = state
        } else if state != .complete {
            activitySteps.insert(ActivityStep(title: title, state: state), at: max(activitySteps.count - 1, 0))
        }
        if state == .active {
            for index in activitySteps.indices where activitySteps[index].title != title && activitySteps[index].state == .active {
                activitySteps[index].state = .complete
            }
        }
    }

    private func updateActivity(status: String, label: String) {
        let combined = "\(status) \(label)".lowercased()
        if combined.contains("location") {
            setActivity("Getting your location", state: .active)
        } else if combined.contains("train") {
            setActivity("Finding routes", state: .complete)
            setActivity("Checking train options", state: .active)
        } else if combined.contains("fare") || combined.contains("ticket") {
            setActivity("Checking fares", state: .active)
        } else if combined.contains("direction") || combined.contains("trip") || combined.contains("route") {
            setActivity("Finding routes", state: .active)
        } else if combined.contains("summary") || combined.contains("speaking") {
            setActivity("Preparing result", state: .active)
        }
    }

    private func markActionsComplete(_ results: [ActionResult]) {
        for result in results {
            let state: ActivityStepState = result.success ? .complete : .failed
            switch result.action {
            case "get_directions", "plan_trip":
                setActivity("Finding routes", state: state)
                if result.itinerary?.contains(where: { ($0.type ?? "").lowercased().contains("rail") }) == true {
                    setActivity("Checking train options", state: state)
                }
            case "search_trains":
                setActivity("Finding routes", state: state)
                setActivity("Checking train options", state: state)
            default:
                break
            }
        }
        setActivity("Preparing result", state: .active)
    }

    private func finishActivity() {
        for index in activitySteps.indices where activitySteps[index].state == .active || activitySteps[index].state == .pending {
            activitySteps[index].state = .complete
        }
        activeTurnUserMessageID = nil
        activitySteps = []
    }

    private func failActiveActivity() {
        if let active = activitySteps.firstIndex(where: { $0.state == .active }) {
            activitySteps[active].state = .failed
        } else if !activitySteps.isEmpty {
            activitySteps[activitySteps.count - 1].state = .failed
        }
        activeTurnUserMessageID = nil
        activitySteps = []
    }

    private func shouldFetchLocation(for text: String) -> Bool {
        Self.shouldFetchLocationText(text.lowercased())
    }

    private func setStatus(_ status: String, _ label: String) {
        let hiddenStatuses = ["thinking_start", "action_complete", "speaking_start"]
        guard !hiddenStatuses.contains(status), !label.isEmpty else {
            if status == "action_complete" || status == "speaking_start" {
                statusLabel = nil
            }
            return
        }
        statusLabel = label
        clearStatusSoon()
    }

    private func clearStatusSoon() {
        let current = statusLabel
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            if statusLabel == current {
                statusLabel = nil
            }
        }
    }

    private func startSendWatchdog(assistantID: UUID) {
        sendWatchdogTask?.cancel()
        sendWatchdogTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(45))
            guard !Task.isCancelled, isSending else { return }
            currentSendTask?.cancel()
            currentSendTask = nil
            _ = updateAssistantMessage(id: assistantID) { message in
                if message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    message.turnError = "That took too long. Try again."
                } else {
                    message.turnError = "The response stopped before it finished. Try again."
                }
                message.isStreaming = false
            }
            statusLabel = nil
            failActiveActivity()
            networkError = nil
            lastFailedText = messages.reversed().first(where: { $0.role == .user })?.content
            isSending = false
            drainQueuedTurns()
        }
    }

    private func friendlyNetworkError(_ error: String) -> String {
        let lower = error.lowercased()
        if lower.contains("network") || lower.contains("internet") || lower.contains("lost") || lower.contains("offline") {
            return "Network connection was lost. Try again."
        }
        if lower.contains("timed out") || lower.contains("timeout") {
            return "That took too long. Try again."
        }
        if lower.contains("session expired") {
            return "Session expired. Please sign in again."
        }
        return "Something went wrong. Try again."
    }

    nonisolated private static func nativeMusicTimeoutResult() -> NativeLocalActionResult {
        NativeLocalActionResult(
            action: "play_music",
            text: "Native music took too long to respond, so I stopped waiting.",
            cardText: "Native music timed out",
            actionSummary: "Music timed out",
            deepLink: nil,
            success: false,
            error: "Native music request timed out."
        )
    }

    nonisolated private static func nativeHealthTimeoutResult() -> NativeLocalActionResult {
        NativeLocalActionResult(
            action: "check_health",
            text: "Apple Health took too long to respond, so I stopped waiting.",
            cardText: "Health timed out",
            actionSummary: "Health timed out",
            deepLink: "x-apple-health://",
            success: false,
            error: "Native health request timed out."
        )
    }

    nonisolated private static func isLikelyNativeHealthRequest(_ text: String) -> Bool {
        let lower = text.lowercased()
        let hasHealthTerm = lower.contains("health")
            || lower.contains("steps")
            || lower.contains("step count")
            || lower.contains("heart rate")
            || lower.contains("bpm")
            || lower.contains("resting heart")
            || lower.contains("sleep")
            || lower.contains("slept")
            || lower.contains("workout")
            || lower.contains("workouts")
            || lower.contains("exercise")
        guard hasHealthTerm else { return false }

        return lower.contains("my ")
            || lower.contains("i ")
            || lower.contains("i've")
            || lower.contains("ive ")
            || lower.contains("me ")
            || lower.contains("today")
            || lower.contains("yesterday")
            || lower.contains("last night")
            || lower.contains("this week")
            || lower.contains("latest")
            || lower.contains("current")
            || lower.contains("check health")
            || lower.contains("health snapshot")
            || lower.contains("health data")
    }

    private func runNativeActionWithHardTimeout(
        seconds: Double,
        timeoutResult: NativeLocalActionResult?,
        operation: @escaping () async -> NativeLocalActionResult?
    ) async -> NativeLocalActionResult? {
        let operationTask = Task {
            await operation()
        }

        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let box = NativeActionTimeoutBox()

                Task.detached {
                    let result = await operationTask.value
                    box.resume(continuation, with: result)
                }

                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds) {
                    operationTask.cancel()
                    box.resume(continuation, with: timeoutResult)
                }
            }
        } onCancel: {
            operationTask.cancel()
        }
    }

    private func executeNativeMusicWithTimeout(query: String) async -> NativeLocalActionResult? {
        await runNativeActionWithHardTimeout(seconds: 7, timeoutResult: Self.nativeMusicTimeoutResult()) {
            await NativeIntegrationManager.shared.playResolvedMusicQuery(query)
        }
    }

    private func executeLocalRequestWithTimeout(_ text: String) async -> NativeLocalActionResult? {
        let lower = text.lowercased()
        let isMusicRequest = lower.contains("play")
            || lower.contains("music")
            || lower.contains("song")
            || lower.contains("playlist")

        if isMusicRequest {
            return await runNativeActionWithHardTimeout(seconds: 7, timeoutResult: Self.nativeMusicTimeoutResult()) {
                await NativeIntegrationManager.shared.executeLocalRequest(text)
            }
        }

        let timeoutResult = Self.isLikelyNativeHealthRequest(text) ? Self.nativeHealthTimeoutResult() : nil
        return await runNativeActionWithHardTimeout(seconds: 7, timeoutResult: timeoutResult) {
            await NativeIntegrationManager.shared.executeLocalRequest(text)
        }
    }

    private func playBackendMusicActions(
        _ results: [ActionResult],
        assistantID: UUID,
        userId: String,
        originalMessage: String
    ) async {
        guard let action = results.first(where: { $0.action == "play_music" && $0.success }) else { return }
        let query = (action.cardText ?? action.text ?? "")
            .replacingOccurrences(of: #"(?i)^playing\s+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        guard !query.isEmpty, !musicQueryStillNeedsResolution(query) else { return }
        guard let nativeResult = await executeNativeMusicWithTimeout(query: query) else { return }
        let nativeAction = ActionResult(native: nativeResult)
        _ = updateAssistantMessage(id: assistantID) {
            $0.content = nativeResult.text
            $0.actions = [nativeAction]
            $0.isStreaming = false
        }
        await chatService.logNativeLocalAction(
            userId: userId,
            message: originalMessage,
            result: nativeAction,
            chatStartedAt: activeChatStartedAt
        )
    }

    private func musicQueryStillNeedsResolution(_ query: String) -> Bool {
        let lower = query.lowercased()
        return lower.contains("billboard")
            || lower.contains("hot 100")
            || lower.contains("chart")
            || lower.contains("most popular")
            || lower.contains("top song")
            || lower.contains("top track")
            || lower.contains("number one")
            || lower.contains("right now")
            || lower.contains("currently")
            || lower.contains("today")
            || lower.contains("latest")
            || lower.contains("trending")
    }

    private func localActionDecision(for text: String) -> Bool? {
        let lower = text
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        let confirmCommands = [
            "yes", "yep", "yeah", "yea", "sure", "confirm", "continue",
            "go ahead", "do it", "open it", "open", "ok", "okay"
        ]
        if confirmCommands.contains(lower) { return true }
        if lower.range(of: #"^(yes|yeah|yep|sure|confirm|continue|go ahead|open it|do it)\b"#, options: .regularExpression) != nil {
            return true
        }
        let cancelCommands = ["no", "nope", "cancel", "stop", "never mind", "nevermind", "don't", "dont"]
        if cancelCommands.contains(lower) { return false }
        if lower.range(of: #"^(no|nope|cancel|stop|don'?t)\b"#, options: .regularExpression) != nil {
            return false
        }
        return nil
    }

    private func shouldHoldForLocalConfirmation(_ action: ActionResult, settings: OxySettings) -> Bool {
        guard action.action == "open_app" else { return false }
        if settings.reviewBeforeOpeningApps { return true }
        return action.risk == "sensitive_app" && settings.confirmSensitiveAppOpens
    }

    private func confirmationPrompt(for action: ActionResult) -> String {
        let target = action.cardText ?? "that app"
        if action.risk == "sensitive_app" {
            return "Open \(target)? Say yes to continue."
        }
        return "Open \(target)?"
    }

    private func shouldAutoOpen(_ action: ActionResult, settings: OxySettings) -> Bool {
        guard Self.autoOpenActions.contains(action.action) else { return false }
        return !shouldHoldForLocalConfirmation(action, settings: settings)
    }

    // MARK: - Deep Links

    func openDeepLinks(_ results: [ActionResult]) {
        let settings = currentSettings
        if settings.reviewBeforeOpeningApps { return }
        for result in results {
            guard shouldAutoOpen(result, settings: settings) else { continue }
            openActionLink(result)
        }
    }

    /// Pendant/silent-exec variant: opens any successful action that has a link,
    /// bypassing the normal UI-confirmation whitelist. Also triggers native music
    /// resolution for play_music results.
    func openPendantActions(_ results: [ActionResult]) {
        let settings = currentSettings
        for result in results where result.success {
            let hasLink = result.deepLink != nil || result.webLink != nil
            if hasLink && !shouldHoldForLocalConfirmation(result, settings: settings) {
                openActionLink(result)
            }
        }
        for result in results where result.action == "play_music" && result.success {
            let query = (result.cardText ?? result.text ?? "")
                .replacingOccurrences(of: #"(?i)^playing\s+"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
            if !query.isEmpty {
                Task { _ = await self.executeNativeMusicWithTimeout(query: query) }
            }
        }
    }

    func openActionLink(_ result: ActionResult) {
        if let link = result.deepLink, let url = URL(string: link) {
            if url.scheme == "oxy-open-app" {
                Task { @MainActor in
                    await NativeIntegrationManager.shared.openBestEffortApp(from: url)
                }
            } else {
                UIApplication.shared.open(url)
            }
        } else if let link = result.webLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        }
    }

}
