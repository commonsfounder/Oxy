import Foundation
import Observation
import AVFoundation
import UIKit

@Observable
@MainActor
final class ChatViewModel {
    var messages: [Message] = []
    var inputText = ""
    var isSending = false
    var statusLabel: String?

    @ObservationIgnored private let audioPlayback = AudioPlaybackManager()
    @ObservationIgnored private var currentSendTask: Task<Void, Never>?
    @ObservationIgnored private var sendWatchdogTask: Task<Void, Never>?

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
        "make_call", "play_music", "add_to_music_playlist"
    ]

    private static let localRequestTerms = [
        "uber", "ride", "taxi", "nearest", "closest", "near me", "nearby",
        "place", "maps", "mcdonald", "john lewis", "gym", "restaurant", "cafe", "coffee",
        "shop", "supermarket", "store", "pharmacy", "station", "cinema",
        "bank", "atm", "directions", "navigate", "route", "bus", "buses", "transit",
        "public transport", "walk", "walking", "drive", "driving"
    ]

    func loadHistory(userId: String) async {
        do {
            let entries = try await chatService.loadHistory(userId: userId)
            let loaded = messages(from: entries)
            await MainActor.run {
                messages = loaded
            }
        } catch {}
    }

    func loadHistoryAround(userId: String, createdAt: String) async {
        do {
            let entries = try await chatService.loadHistoryAround(userId: userId, createdAt: createdAt)
            let loaded = messages(from: entries)
            await MainActor.run {
                messages = loaded
                statusLabel = nil
            }
        } catch {}
    }

    func sendMessage(userId: String) {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }

        inputText = ""
        isSending = true
        statusLabel = nil

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
            var location = locationManager.locationDict
            if needsFreshLocation {
                await MainActor.run {
                    statusLabel = "Checking location"
                }
                location = await locationManager.currentLocationForLocalRequest() ?? location
            }

            if let localResult = await executeLocalRequestWithTimeout(text) {
                let actionResult = ActionResult(native: localResult)
                await MainActor.run {
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.content = localResult.text
                        $0.actions = [actionResult]
                        $0.isStreaming = false
                    }
                    statusLabel = nil
                    isSending = false
                    currentSendTask = nil
                    if Self.autoOpenActions.contains(actionResult.action) {
                        openActionLink(actionResult)
                    }
                }
                await chatService.logNativeLocalAction(userId: userId, message: text, result: actionResult)
                return
            }

            let nativeHints = await nativeManager.localContextHints(for: text)

            let stream = chatService.sendMessage(
                userId: userId,
                message: text,
                settings: settings,
                location: location,
                nativeHints: nativeHints
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

                    case .status(let status, let label):
                        setStatus(status, label)

                    case .transcription:
                        break

                    case .transcriptionError(let error):
                        guard updateAssistantMessage(id: assistantID, { $0.content = error }) else { return }
                        statusLabel = nil

                    case .audio(let base64Audio, _):
                        playAudio(base64Audio)

                    case .ttsError(let error):
                        statusLabel = "Voice unavailable: \(error)"

                    case .done:
                        _ = updateAssistantMessage(id: assistantID, { $0.isStreaming = false })
                        statusLabel = nil
                        isSending = false
                        currentSendTask = nil

                    case .error(let error):
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

    func sendImageMessage(userId: String, imageData: Data, fileName: String, mimeType: String) {
        let typed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = typed.isEmpty ? "Look at this image and tell me what you see." : typed
        guard !isSending else { return }

        inputText = ""
        isSending = true
        statusLabel = "Looking at image"

        let userMessage = Message(role: .user, content: "\(text)\n[Image attached]")
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
                    isSending = false
                    currentSendTask = nil
                }
            } catch {
                await MainActor.run {
                    _ = updateAssistantMessage(id: assistantID) {
                        $0.content = "Something went wrong with that image: \(error.localizedDescription)"
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
        messages.removeAll()
        inputText = ""
        isSending = false
        statusLabel = nil
    }

    func requestLocationAccess() {
        locationManager.requestPermission()
    }

    private func messages(from entries: [HistoryEntry]) -> [Message] {
        entries.compactMap { entry -> Message? in
            guard let role = Message.Role(rawValue: entry.role) else { return nil }
            return Message(
                role: role,
                content: entry.content,
                timestamp: ISO8601DateFormatter().date(from: entry.createdAt ?? "") ?? Date(),
                actions: entry.actions ?? []
            )
        }
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
            isSending = false
        }
    }

    nonisolated private static func nativeMusicTimeoutResult() -> NativeLocalActionResult {
        NativeLocalActionResult(
            action: "play_music",
            text: "Apple Music is taking too long to respond. Try again in a moment.",
            cardText: "Native music timed out",
            actionSummary: "Music timed out",
            deepLink: "music://",
            success: false,
            error: "Native music request timed out."
        )
    }

    private func executeNativeMusicWithTimeout(query: String) async -> NativeLocalActionResult? {
        await withTaskGroup(of: NativeLocalActionResult?.self) { group in
            group.addTask {
                await NativeIntegrationManager.shared.playResolvedMusicQuery(query)
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(7))
                return Self.nativeMusicTimeoutResult()
            }
            let result = await group.next() ?? nil
            group.cancelAll()
            return result
        }
    }

    private func executeLocalRequestWithTimeout(_ text: String) async -> NativeLocalActionResult? {
        await withTaskGroup(of: NativeLocalActionResult?.self) { group in
            group.addTask {
                await NativeIntegrationManager.shared.executeLocalRequest(text)
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(7))
                if text.lowercased().contains("play")
                    || text.lowercased().contains("music")
                    || text.lowercased().contains("song")
                    || text.lowercased().contains("playlist") {
                    return Self.nativeMusicTimeoutResult()
                }
                return nil
            }
            let result = await group.next() ?? nil
            group.cancelAll()
            return result
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
        if !nativeAction.success {
            openActionLink(nativeAction)
        }
        _ = updateAssistantMessage(id: assistantID) {
            $0.content = nativeResult.text
            $0.actions = [nativeAction]
            $0.isStreaming = false
        }
        await chatService.logNativeLocalAction(userId: userId, message: originalMessage, result: nativeAction)
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

    // MARK: - Deep Links

    private func openDeepLinks(_ results: [ActionResult]) {
        if currentSettings.reviewBeforeOpeningApps { return }
        for result in results {
            guard Self.autoOpenActions.contains(result.action) else { continue }
            openActionLink(result)
        }
    }

    func openActionLink(_ result: ActionResult) {
        if let link = result.deepLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
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

private final class AudioPlaybackManager: NSObject, AVAudioPlayerDelegate {
    private var audioPlayer: AVAudioPlayer?
    private var pendingAudio: [Data] = []
    private var onError: ((String) -> Void)?

    func play(_ base64Audio: String, onError: @escaping (String) -> Void) {
        guard let data = Data(base64Encoded: base64Audio) else { return }
        self.onError = onError
        pendingAudio.append(data)
        playNextAudioIfNeeded()
    }

    private func playNextAudioIfNeeded() {
        guard audioPlayer?.isPlaying != true, !pendingAudio.isEmpty else { return }
        let data = pendingAudio.removeFirst()

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)

            let player = try AVAudioPlayer(data: data)
            player.delegate = self
            player.prepareToPlay()
            audioPlayer = player
            player.play()
        } catch {
            onError?("Voice playback failed")
            playNextAudioIfNeeded()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if audioPlayer === player {
            audioPlayer = nil
        }
        playNextAudioIfNeeded()
    }
}
