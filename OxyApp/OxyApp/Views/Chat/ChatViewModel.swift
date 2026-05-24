import Foundation
import Observation
import UIKit

@Observable
final class ChatViewModel {
    var messages: [Message] = []
    var inputText = ""
    var isSending = false
    var statusLabel: String?

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
        "play_music", "search_netflix_title", "add_to_netflix_list"
    ]

    func loadHistory(userId: String) async {
        do {
            let entries = try await chatService.loadHistory(userId: userId)
            let loaded = entries.compactMap { entry -> Message? in
                guard let role = Message.Role(rawValue: entry.role) else { return nil }
                return Message(
                    role: role,
                    content: entry.content,
                    timestamp: ISO8601DateFormatter().date(from: entry.createdAt ?? "") ?? Date()
                )
            }
            await MainActor.run {
                messages = loaded
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
        let assistantIndex = messages.count - 1

        let settings = currentSettings
        let location = locationManager.locationDict

        Task {
            let stream = chatService.sendMessage(
                userId: userId,
                message: text,
                settings: settings,
                location: location
            )
            var fullText = ""

            for await event in stream {
                await MainActor.run {
                    switch event {
                    case .text(let chunk):
                        fullText += chunk
                        messages[assistantIndex].content = fullText
                        statusLabel = nil

                    case .replace(let replacement):
                        fullText = replacement
                        messages[assistantIndex].content = fullText

                    case .actions(let results):
                        messages[assistantIndex].actions = results
                        openDeepLinks(results)

                    case .status(_, let label):
                        statusLabel = label

                    case .transcription:
                        break

                    case .transcriptionError(let error):
                        messages[assistantIndex].content = error
                        statusLabel = nil

                    case .audio:
                        break

                    case .ttsError:
                        break

                    case .done:
                        messages[assistantIndex].isStreaming = false
                        statusLabel = nil
                        isSending = false

                    case .error(let error):
                        if fullText.isEmpty {
                            messages[assistantIndex].content = "Something went wrong: \(error)"
                        }
                        messages[assistantIndex].isStreaming = false
                        statusLabel = nil
                        isSending = false
                    }
                }
            }

            await MainActor.run {
                messages[assistantIndex].isStreaming = false
                isSending = false
                statusLabel = nil
            }
        }
    }

    func clearChat() {
        messages.removeAll()
        inputText = ""
        isSending = false
        statusLabel = nil
    }

    func requestLocationAccess() {
        locationManager.requestPermission()
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
}
