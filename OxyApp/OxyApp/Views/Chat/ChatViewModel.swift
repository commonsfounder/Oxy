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

    private let chatService = ChatService()
    private let locationManager = LocationManager.shared

    private var currentSettings: OxySettings {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            return saved
        }
        return OxySettings()
    }

    private static let autoOpenActions: Set<String> = [
        "book_uber", "order_deliveroo", "order_uber_eats",
        "play_music", "search_netflix_title", "add_to_netflix_list",
        "send_message", "make_call", "get_directions"
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
        let needsFreshLocation = Self.localRequestTerms.contains { text.localizedCaseInsensitiveContains($0) }

        currentSendTask = Task {
            var location = locationManager.locationDict
            if needsFreshLocation {
                await MainActor.run {
                    statusLabel = "Checking location"
                }
                location = await locationManager.currentLocationForLocalRequest() ?? location
            }

            let stream = chatService.sendMessage(
                userId: userId,
                message: text,
                settings: settings,
                location: location
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

                    case .status(_, let label):
                        statusLabel = label

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

    func clearChat() {
        currentSendTask?.cancel()
        currentSendTask = nil
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

    // MARK: - Deep Links

    private func openDeepLinks(_ results: [ActionResult]) {
        for result in results {
            guard Self.autoOpenActions.contains(result.action) else { continue }
            if let link = result.deepLink, let url = URL(string: link) {
                UIApplication.shared.open(url)
            } else if let link = result.webLink, let url = URL(string: link) {
                UIApplication.shared.open(url)
            }
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
