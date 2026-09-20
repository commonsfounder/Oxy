import Foundation

public enum AgentCLIProviderID: String, Codable, CaseIterable, Sendable {
    case codex
    case claude
}

public struct AgentCLIAvailability: Codable, Equatable, Sendable {
    public let provider: AgentCLIProviderID
    public let isInstalled: Bool
    public let isAuthenticated: Bool
    public let authenticationVerifiedLive: Bool
    public let executablePath: String?
    public let detail: String

    public init(
        provider: AgentCLIProviderID,
        isInstalled: Bool,
        isAuthenticated: Bool,
        authenticationVerifiedLive: Bool = false,
        executablePath: String?,
        detail: String
    ) {
        self.provider = provider
        self.isInstalled = isInstalled
        self.isAuthenticated = isAuthenticated
        self.authenticationVerifiedLive = authenticationVerifiedLive
        self.executablePath = executablePath
        self.detail = detail
    }

    public static func ready(provider: AgentCLIProviderID, executablePath: String) -> Self {
        Self(
            provider: provider,
            isInstalled: true,
            isAuthenticated: true,
            authenticationVerifiedLive: true,
            executablePath: executablePath,
            detail: "Ready"
        )
    }
}

public struct AgentCLIRequest: Sendable {
    public let prompt: String
    public let workingDirectory: URL
    public let preferredProvider: AgentCLIProviderID?
    public let model: String?
    public let providerModels: [AgentCLIProviderID: String]

    public init(
        prompt: String,
        workingDirectory: URL,
        preferredProvider: AgentCLIProviderID? = nil,
        model: String? = nil,
        providerModels: [AgentCLIProviderID: String] = [:]
    ) {
        self.prompt = prompt
        self.workingDirectory = workingDirectory
        self.preferredProvider = preferredProvider
        self.model = model
        self.providerModels = providerModels
    }

    func model(for provider: AgentCLIProviderID) -> String? {
        providerModels[provider] ?? model
    }
}

public enum AgentCLIInvocationParser {
    public static func parse(
        _ invocation: String,
        currentDirectory: URL
    ) -> AgentCLIRequest? {
        let pattern = #"^\s*adam,?\s+ask\s+(codex|claude)\s+(?:to\s+)?(.+?)\s*$"#
        guard let expression = try? NSRegularExpression(
            pattern: pattern,
            options: [.caseInsensitive]
        ) else { return nil }

        let range = NSRange(invocation.startIndex..., in: invocation)
        guard
            let match = expression.firstMatch(in: invocation, range: range),
            match.range == range,
            let providerRange = Range(match.range(at: 1), in: invocation),
            let promptRange = Range(match.range(at: 2), in: invocation),
            let provider = AgentCLIProviderID(
                rawValue: invocation[providerRange].lowercased()
            )
        else { return nil }

        return AgentCLIRequest(
            prompt: String(invocation[promptRange]),
            workingDirectory: currentDirectory,
            preferredProvider: provider
        )
    }
}

public enum AgentConversationRequestFactory {
    public static func makeRequest(
        input: String,
        selectedProvider: AgentCLIProviderID,
        workingDirectory: URL,
        providerModels: [AgentCLIProviderID: String] = [:]
    ) throws -> AgentCLIRequest {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw AgentCLIBridgeError.emptyPrompt }

        if let naturalRequest = AgentCLIInvocationParser.parse(
            text,
            currentDirectory: workingDirectory
        ) {
            return AgentCLIRequest(
                prompt: naturalRequest.prompt,
                workingDirectory: workingDirectory,
                preferredProvider: naturalRequest.preferredProvider,
                providerModels: providerModels
            )
        }

        return AgentCLIRequest(
            prompt: text,
            workingDirectory: workingDirectory,
            preferredProvider: selectedProvider,
            providerModels: providerModels
        )
    }
}

public struct AgentCLIResponse: Codable, Equatable, Sendable {
    public let text: String
    public let structuredOutput: String

    public init(text: String, structuredOutput: String) {
        self.text = text
        self.structuredOutput = structuredOutput
    }
}

public struct AgentCLIRunResult: Codable, Equatable, Sendable {
    public let provider: AgentCLIProviderID
    public let rawResponse: String
    public let renderedSpeech: String?
    public let spoken: Bool
    public let deliveryError: String?
    public let provenance: AgentCLIRunProvenance
}

public struct AgentCLIRunProvenance: Codable, Equatable, Sendable {
    public let executablePath: String?
    public let authenticationDetail: String
    public let authenticationVerifiedBeforeRun: Bool
    public let model: String?
    public let rendererProvider: AgentCLIProviderID?
    public let accessMode: String
}

public protocol AgentCLIProviding {
    var id: AgentCLIProviderID { get }
    func availability() -> AgentCLIAvailability
    func run(prompt: String, in workingDirectory: URL, model: String?) throws -> AgentCLIResponse
}

public protocol AgentVoiceRendering {
    func render(_ rawResponse: String) throws -> String
}

public protocol AgentSpeechOutput {
    func speak(_ text: String) throws
}

public enum AgentCLIBridgeError: Error, Equatable, LocalizedError {
    case emptyPrompt
    case invalidWorkingDirectory(String)
    case noAvailableProvider
    case providerUnavailable(AgentCLIProviderID, String)
    case allProvidersFailed([String])
    case noRenderer(AgentCLIProviderID)

    public var errorDescription: String? {
        switch self {
        case .emptyPrompt:
            return "The agent prompt is empty"
        case let .invalidWorkingDirectory(path):
            return "The requested folder is not available: \(path)"
        case .noAvailableProvider:
            return "No installed and authenticated agent CLI is available"
        case let .providerUnavailable(provider, detail):
            return "\(provider.rawValue.capitalized) is unavailable: \(detail)"
        case let .allProvidersFailed(failures):
            return failures.joined(separator: " | ")
        case let .noRenderer(provider):
            return "No voice renderer is configured for \(provider.rawValue.capitalized)"
        }
    }
}

public final class AgentCLIBridge {
    private let providers: [any AgentCLIProviding]
    private let defaultRenderer: (any AgentVoiceRendering)?
    private let providerRenderers: [AgentCLIProviderID: any AgentVoiceRendering]
    private let speaker: any AgentSpeechOutput

    public init(
        providers: [any AgentCLIProviding],
        renderer: any AgentVoiceRendering,
        speaker: any AgentSpeechOutput
    ) {
        self.providers = providers
        defaultRenderer = renderer
        providerRenderers = [:]
        self.speaker = speaker
    }

    public init(
        providers: [any AgentCLIProviding],
        providerRenderers: [AgentCLIProviderID: any AgentVoiceRendering],
        speaker: any AgentSpeechOutput
    ) {
        self.providers = providers
        defaultRenderer = nil
        self.providerRenderers = providerRenderers
        self.speaker = speaker
    }

    public static func live(
        rendererModel: String? = nil,
        claudeRendererModel: String? = nil
    ) -> AgentCLIBridge {
        AgentCLIBridge(
            providers: [CodexCLIProvider(), ClaudeCLIProvider()],
            providerRenderers: [
                .codex: CodexAdamVoiceRenderer(model: rendererModel),
                .claude: ClaudeAdamVoiceRenderer(model: claudeRendererModel)
            ],
            speaker: MacSaySpeechOutput()
        )
    }

    public func availableProviders() -> [AgentCLIAvailability] {
        providers.map { $0.availability() }
    }

    public func run(_ request: AgentCLIRequest, speak: Bool = true) throws -> AgentCLIRunResult {
        let prompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { throw AgentCLIBridgeError.emptyPrompt }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: request.workingDirectory.path,
            isDirectory: &isDirectory
        ), isDirectory.boolValue else {
            throw AgentCLIBridgeError.invalidWorkingDirectory(request.workingDirectory.path)
        }

        let candidates = try candidateProviders(request.preferredProvider)
        var selected: (provider: any AgentCLIProviding, availability: AgentCLIAvailability)?
        var response: AgentCLIResponse?
        var failures: [String] = []

        for candidate in candidates {
            do {
                response = try candidate.provider.run(
                    prompt: prompt,
                    in: request.workingDirectory,
                    model: request.model(for: candidate.provider.id)
                )
                selected = candidate
                break
            } catch {
                failures.append("\(candidate.provider.id.rawValue.capitalized): \(error.localizedDescription)")
                if request.preferredProvider != nil { throw error }
            }
        }

        guard let selected, let response else {
            throw AgentCLIBridgeError.allProvidersFailed(failures)
        }
        let provenance = AgentCLIRunProvenance(
            executablePath: selected.availability.executablePath,
            authenticationDetail: selected.availability.detail,
            authenticationVerifiedBeforeRun: selected.availability.authenticationVerifiedLive,
            model: request.model(for: selected.provider.id),
            rendererProvider: providerRenderers[selected.provider.id] == nil
                ? nil
                : selected.provider.id,
            accessMode: "selected-folder read-only"
        )
        guard let renderer = providerRenderers[selected.provider.id] ?? defaultRenderer else {
            return AgentCLIRunResult(
                provider: selected.provider.id,
                rawResponse: response.text,
                renderedSpeech: nil,
                spoken: false,
                deliveryError: AgentCLIBridgeError.noRenderer(selected.provider.id).localizedDescription,
                provenance: provenance
            )
        }

        let renderedSpeech: String
        do {
            renderedSpeech = try renderer.render(response.text)
        } catch {
            return AgentCLIRunResult(
                provider: selected.provider.id,
                rawResponse: response.text,
                renderedSpeech: nil,
                spoken: false,
                deliveryError: error.localizedDescription,
                provenance: provenance
            )
        }

        if speak {
            do {
                try speaker.speak(renderedSpeech)
            } catch {
                return AgentCLIRunResult(
                    provider: selected.provider.id,
                    rawResponse: response.text,
                    renderedSpeech: renderedSpeech,
                    spoken: false,
                    deliveryError: error.localizedDescription,
                    provenance: provenance
                )
            }
        }

        return AgentCLIRunResult(
            provider: selected.provider.id,
            rawResponse: response.text,
            renderedSpeech: renderedSpeech,
            spoken: speak,
            deliveryError: nil,
            provenance: provenance
        )
    }

    private func candidateProviders(
        _ preferredProvider: AgentCLIProviderID?
    ) throws -> [(provider: any AgentCLIProviding, availability: AgentCLIAvailability)] {
        if let preferredProvider {
            guard let provider = providers.first(where: { $0.id == preferredProvider }) else {
                throw AgentCLIBridgeError.providerUnavailable(preferredProvider, "Adapter not configured")
            }
            let status = provider.availability()
            guard status.isInstalled, status.isAuthenticated else {
                throw AgentCLIBridgeError.providerUnavailable(preferredProvider, status.detail)
            }
            return [(provider, status)]
        }

        let candidates = providers.compactMap { provider in
            let status = provider.availability()
            return status.isInstalled && status.isAuthenticated ? (provider, status) : nil
        }
        guard !candidates.isEmpty else {
            throw AgentCLIBridgeError.noAvailableProvider
        }
        return candidates
    }
}
