import AdamMacRuntime
import AppKit
import Foundation

struct MacAgentMessage: Identifiable {
    enum Role {
        case user
        case agent
    }

    let id = UUID()
    let role: Role
    let content: String
    let renderedSpeech: String?
    let deliveryError: String?
    let provider: AgentCLIProviderID?
}

@MainActor
final class MacAgentConversationModel: ObservableObject {
    private static let workingDirectoryKey = "AdamAgentWorkingDirectory"

    @Published var inputText = ""
    @Published var selectedProvider = AgentCLIProviderID.codex
    @Published private(set) var workingDirectory: URL?
    @Published private(set) var messages: [MacAgentMessage] = []
    @Published private(set) var availability: [AgentCLIAvailability] = []
    @Published private(set) var isRunning = false
    @Published private(set) var status: String

    init(workingDirectory: URL? = nil) {
        let savedPath = UserDefaults.standard.string(forKey: Self.workingDirectoryKey)
        let savedDirectory = savedPath
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            .flatMap { url in
                var isDirectory: ObjCBool = false
                return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
                    && isDirectory.boolValue ? url : nil
            }
        let selectedDirectory = workingDirectory ?? savedDirectory
        self.workingDirectory = selectedDirectory
        status = selectedDirectory == nil
            ? "Choose a folder, then type or speak."
            : "Ready"
    }

    func refreshAvailability() {
        Task {
            let statuses = await Task.detached(priority: .utility) {
                AgentCLIBridge.live().availableProviders()
            }.value
            availability = statuses
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = workingDirectory
        panel.prompt = "Use folder"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        workingDirectory = folder
        UserDefaults.standard.set(folder.path, forKey: Self.workingDirectoryKey)
        status = "Ready"
    }

    func submit(_ spokenText: String? = nil) {
        let original = (spokenText ?? inputText)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty, !isRunning else { return }
        guard let workingDirectory else {
            status = "Choose a folder first."
            return
        }

        let environment = ProcessInfo.processInfo.environment
        var providerModels: [AgentCLIProviderID: String] = [:]
        if let codexModel = environment["ADAM_CODEX_MODEL"] {
            providerModels[.codex] = codexModel
        }
        if let claudeModel = environment["ADAM_CLAUDE_MODEL"] {
            providerModels[.claude] = claudeModel
        }

        let request: AgentCLIRequest
        do {
            request = try AgentConversationRequestFactory.makeRequest(
                input: original,
                selectedProvider: selectedProvider,
                workingDirectory: workingDirectory,
                providerModels: providerModels
            )
        } catch {
            status = error.localizedDescription
            return
        }

        messages.append(MacAgentMessage(
            role: .user,
            content: original,
            renderedSpeech: nil,
            deliveryError: nil,
            provider: nil
        ))
        inputText = ""
        isRunning = true
        status = "Asking \((request.preferredProvider ?? selectedProvider).rawValue.capitalized)"

        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    let bridge = AgentCLIBridge.live(
                        rendererModel: providerModels[.codex],
                        claudeRendererModel: providerModels[.claude]
                    )
                    return try bridge.run(request, speak: true)
                }.value
                messages.append(MacAgentMessage(
                    role: .agent,
                    content: result.rawResponse,
                    renderedSpeech: result.renderedSpeech,
                    deliveryError: result.deliveryError,
                    provider: result.provider
                ))
                status = result.deliveryError == nil
                    ? (result.spoken ? "Spoken" : "Answer received")
                    : "Answer received · voice unavailable"
            } catch {
                messages.append(MacAgentMessage(
                    role: .agent,
                    content: error.localizedDescription,
                    renderedSpeech: nil,
                    deliveryError: nil,
                    provider: request.preferredProvider
                ))
                status = "Could not run"
            }
            isRunning = false
        }
    }

    func detail(for provider: AgentCLIProviderID) -> String {
        guard let state = availability.first(where: { $0.provider == provider }) else {
            return "Checking"
        }
        if state.isInstalled, state.isAuthenticated {
            return "Installed · sign-in stored"
        }
        return state.detail
    }
}
