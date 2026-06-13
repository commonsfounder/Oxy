import Foundation
import Observation
import AVFoundation
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

@Observable
@MainActor
final class ChatViewModel {
    var messages: [Message] = []
    var inputText = ""
    var isSending = false
    var statusLabel: String?
    var scrollTargetMessageID: UUID?
    var isViewingHistorySnapshot = false
    var historySnapshotLabel: String?
    var networkError: String?
    /// When true, this turn is not persisted server-side (shadow / incognito chat).
    var incognito = false

    /// Called on the main actor when a silent pendant execution finishes.
    var onSilentExecComplete: (() -> Void)?

    @ObservationIgnored private let audioPlayback = AudioPlaybackManager()
    @ObservationIgnored private var currentSendTask: Task<Void, Never>?
    @ObservationIgnored private var sendWatchdogTask: Task<Void, Never>?
    @ObservationIgnored private var activeChatStartedAt: String?
    @ObservationIgnored private var pendingLocalAction: ActionResult?
    @ObservationIgnored private var lastFailedText: String?

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
        "book_uber", "order_deliveroo", "order_uber_eats",
        "search_netflix_title", "add_to_netflix_list",
        "make_call", "add_to_music_playlist", "open_app"
    ]

    private static let localRequestTerms = [
        "uber", "ride", "taxi", "nearest", "closest", "near me", "nearby",
        "place", "maps", "mcdonald", "john lewis", "gym", "restaurant", "cafe", "coffee",
        "shop", "supermarket", "store", "pharmacy", "station", "cinema",
        "bank", "atm", "directions", "navigate", "route", "bus", "buses", "transit",
        "public transport", "walk", "walking", "drive", "driving"
    ]

    func prepareChat(userId: String) async {
        #if DEBUG
        Self.runSessionRuleCheck()
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
    }

    func sendMessage(userId: String) {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        if isViewingHistorySnapshot {
            startNewChat(userId: userId)
        }
        if activeChatStartedAt == nil {
            activeChatStartedAt = chatStartedAt(for: userId)
        }
        markChatActivity(for: userId)
        let pendingDecision = localActionDecision(for: text)

        audioPlayback.stop()
        inputText = ""
        isSending = true
        statusLabel = nil
        networkError = nil

        let userMessage = Message(role: .user, content: text)
        messages.append(userMessage)

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
                }
                location = await locationManager.currentLocationForLocalRequest() ?? location
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
                    if holdForConfirmation {
                        pendingLocalAction = actionResult
                    } else if shouldAutoOpen(actionResult, settings: settings) {
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
            var fullText = ""

            for await event in stream {
                if Task.isCancelled { break }
                await MainActor.run {
                    switch event {
                    case .text(let chunk):
                        fullText += chunk
                        guard updateAssistantMessage(id: assistantID, { $0.content = fullText }) else { return }
                        statusLabel = nil

                    case .replace(let replacement):
                        fullText = replacement
                        guard updateAssistantMessage(id: assistantID, { $0.content = fullText }) else { return }

                    case .actions(let results):
                        guard updateAssistantMessage(id: assistantID, { $0.actions = results }) else { return }
                        openDeepLinks(results)
                        if results.contains(where: { $0.success }) {
                            HapticManager.shared.success()
                        } else if results.contains(where: { !$0.success }) {
                            HapticManager.shared.warning()
                        }
                        Task {
                            await playBackendMusicActions(results, assistantID: assistantID, userId: userId, originalMessage: text)
                        }

                    case .status(let status, let label):
                        setStatus(status, label)

                    case .transcription:
                        break

                    case .transcriptionError(let error):
                        guard updateAssistantMessage(id: assistantID, { $0.content = error }) else { return }
                        statusLabel = nil

                    case .sources(let sources):
                        guard updateAssistantMessage(id: assistantID, { $0.sources = sources }) else { return }

                    case .audio(let base64Audio, _):
                        playAudio(base64Audio)

                    case .ttsError(let error):
                        statusLabel = "Voice unavailable: \(error)"

                    case .done:
                        _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                        statusLabel = nil
                        networkError = nil
                        lastFailedText = nil
                        isSending = false
                        currentSendTask = nil
                        HapticManager.shared.impact(.soft)

                    case .error(let error):
                        lastFailedText = text
                        networkError = friendlyNetworkError(error)
                        HapticManager.shared.error()
                        if fullText.isEmpty {
                            _ = updateAssistantMessage(id: assistantID, { $0.content = "Something went wrong: \(error)" })
                        }
                        _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                        statusLabel = nil
                        isSending = false
                        currentSendTask = nil
                    }
                }
            }

            await MainActor.run {
                _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                isSending = false
                statusLabel = nil
                currentSendTask = nil
            }
        }
    }

    func sendCommand(_ command: String, userId: String) {
        guard !isSending else { return }
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
                    case .audio(let base64Audio, _):
                        self.playAudio(base64Audio)
                    case .done, .error:
                        break
                    default:
                        break
                    }
                }
            }
        }
    }

    func retryLastFailedMessage(userId: String) {
        guard let lastFailedText, !isSending else { return }
        networkError = nil
        inputText = lastFailedText
        sendMessage(userId: userId)
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
        networkError = nil

        let attachmentTag = isImage ? "[Image attached]" : "[File attached: \(fileName)]"
        let userMessage = Message(role: .user, content: "\(text)\n\(attachmentTag)")
        messages.append(userMessage)

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
                    if let audio = response.audio {
                        playAudio(audio)
                    } else if let ttsError = response.ttsError {
                        statusLabel = "Voice unavailable: \(ttsError)"
                    } else {
                        statusLabel = nil
                    }
                    networkError = nil
                    lastFailedText = nil
                    isSending = false
                    currentSendTask = nil
                }
            } catch {
                await MainActor.run {
                    lastFailedText = text
                    networkError = friendlyNetworkError(error.localizedDescription)
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.content = "Something went wrong with that \(isImage ? "image" : "file"): \(error.localizedDescription)"
                        $0.isStreaming = false
                    }
                    statusLabel = nil
                    isSending = false
                    currentSendTask = nil
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
        messages.removeAll()
        inputText = ""
        isSending = false
        statusLabel = nil
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

    private func shouldFetchLocation(for text: String) -> Bool {
        let lower = text.lowercased()
        if lower.hasPrefix("remember ") || lower.hasPrefix("save ") || lower.hasPrefix("note down ") {
            return false
        }
        if lower.contains("play ") || lower.contains("pause") || lower.contains("playlist") || lower.contains("song") {
            return false
        }
        return Self.localRequestTerms.contains { lower.contains($0) }
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
                    message.content = "I got stuck there. Try that again and I’ll keep it tighter."
                }
                message.isStreaming = false
            }
            statusLabel = nil
            networkError = "Oxy got stuck waiting for the network. Try again."
            lastFailedText = messages.reversed().first(where: { $0.role == .user })?.content
            isSending = false
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

    // MARK: - Audio Playback

    private func playAudio(_ base64Audio: String) {
        audioPlayback.play(base64Audio) { [weak self] message in
            Task { @MainActor in
                self?.statusLabel = message
            }
        }
    }
}

// Streamed TTS arrives as many small WAV chunks (one per PCM segment). Playing each as a
// separate AVAudioPlayer left a gap + click at every boundary (crackling). Instead we schedule
// the raw PCM gaplessly into a single AVAudioEngine player node, so chunks play as one
// continuous stream. Backend TTS is 24kHz / 16-bit / mono.
private final class AudioPlaybackManager: NSObject {
    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let renderFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var onError: ((String) -> Void)?
    private var configured = false
    private var observerAdded = false

    func play(_ base64Audio: String, onError: @escaping (String) -> Void) {
        guard let data = Data(base64Encoded: base64Audio),
              let buffer = Self.pcmBuffer(fromWav: data, format: renderFormat) else { return }
        self.onError = onError
        guard ensureRunning() else { return }
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
        if !playerNode.isPlaying { playerNode.play() }
    }

    func stop() {
        if playerNode.isPlaying { playerNode.stop() }
        if engine.isRunning { engine.stop() }
        configured = false
    }

    // Engine + audio session are set up once; reconfiguring per chunk added latency and gaps.
    private func ensureRunning() -> Bool {
        if configured && engine.isRunning { return true }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)

            if !observerAdded {
                observerAdded = true
                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.interruptionNotification,
                    object: nil, queue: .main
                ) { [weak self] note in
                    guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                          let t = AVAudioSession.InterruptionType(rawValue: type) else { return }
                    if t == .began { self?.stop() } else { self?.configured = false }
                }
                // Headphones unplugged etc.: stop so audio doesn't blast the speaker mid-reply.
                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.routeChangeNotification,
                    object: nil, queue: .main
                ) { [weak self] note in
                    guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                          reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
                    self?.stop()
                }
            }

            if engine.attachedNodes.contains(playerNode) == false {
                engine.attach(playerNode)
                engine.connect(playerNode, to: engine.mainMixerNode, format: renderFormat)
            }
            engine.prepare()
            try engine.start()
            configured = true
            return true
        } catch {
            onError?("Voice playback failed")
            return false
        }
    }

    // Strips the WAV header and converts 16-bit PCM to a float buffer the engine can schedule.
    private static func pcmBuffer(fromWav data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let bytes = [UInt8](data)
        // Find the "data" subchunk; fall back to the canonical 44-byte header offset.
        var pcmStart = 44
        if let marker = "data".data(using: .ascii) {
            let markerBytes = [UInt8](marker)
            var i = 12
            while i + 8 <= bytes.count {
                if Array(bytes[i..<i+4]) == markerBytes { pcmStart = i + 8; break }
                i += 1
            }
        }
        guard bytes.count > pcmStart else { return nil }
        let pcmBytes = bytes[pcmStart...]
        let sampleCount = pcmBytes.count / 2
        guard sampleCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        pcmBytes.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                channel[i] = Float(Int16(littleEndian: samples[i])) / 32768.0
            }
        }
        return buffer
    }
}
