import Foundation
import Observation

@Observable
final class ChatViewModel {
    var messages: [Message] = []
    var inputText = ""
    var isSending = false
    var statusLabel: String?

    private let chatService = ChatService()

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
        } catch {
            // History load failure is non-fatal — start with empty chat
        }
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

        Task {
            let stream = chatService.sendMessage(userId: userId, message: text)
            var fullText = ""
            var actionResults: [ActionResult] = []

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
                        actionResults = results
                        messages[assistantIndex].actions = results

                    case .status(_, let label):
                        statusLabel = label

                    case .transcription:
                        break

                    case .transcriptionError(let error):
                        messages[assistantIndex].content = error
                        statusLabel = nil

                    case .audio:
                        // Phase 2: audio playback
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
}
