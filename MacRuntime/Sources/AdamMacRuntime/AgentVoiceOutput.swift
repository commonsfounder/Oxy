import Foundation

public enum AgentVoiceRenderingError: Error, Equatable, LocalizedError {
    case allRenderersFailed([String])

    public var errorDescription: String? {
        switch self {
        case let .allRenderersFailed(failures):
            return failures.joined(separator: " | ")
        }
    }
}

public final class FallbackAgentVoiceRenderer: AgentVoiceRendering {
    private let renderers: [any AgentVoiceRendering]

    public init(renderers: [any AgentVoiceRendering]) {
        self.renderers = renderers
    }

    public func render(_ rawResponse: String) throws -> String {
        var failures: [String] = []
        for renderer in renderers {
            do {
                return try renderer.render(rawResponse)
            } catch {
                failures.append(error.localizedDescription)
            }
        }
        throw AgentVoiceRenderingError.allRenderersFailed(failures)
    }
}

public final class CodexAdamVoiceRenderer: AgentVoiceRendering {
    private let model: String?
    private let runner: any AgentCommandRunning

    public convenience init(model: String? = nil) {
        self.init(model: model, runner: FoundationAgentCommandRunner())
    }

    init(model: String?, runner: any AgentCommandRunning) {
        self.model = model
        self.runner = runner
    }

    public func render(_ rawResponse: String) throws -> String {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("adam-voice-renderer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        var arguments = ["codex", "exec"]
        if let model, !model.isEmpty {
            arguments += ["--model", model]
        }
        arguments += [
            // The command runner already applies the renderer's macOS boundary.
            "--sandbox", "danger-full-access",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--json",
            "-C", scratch.path,
            AdamVoiceRendererPrompt.instruction
        ]

        let result = try runner.run(
            AgentCommand(
                arguments: arguments,
                workingDirectory: scratch,
                standardInput: rawResponse,
                readBoundary: AgentCommandReadBoundary(
                    root: scratch,
                    provider: .codex,
                    denyWrites: false
                )
            )
        )
        guard result.status == 0 else {
            throw AgentCLIProviderError.commandFailed(
                provider: .codex,
                status: result.status,
                message: Self.combinedOutput(result)
            )
        }
        guard let rendered = CodexCLIProvider.finalAgentMessage(from: result.stdout), !rendered.isEmpty else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: .codex,
                message: Self.combinedOutput(result)
            )
        }
        return rendered
    }

    private static func combinedOutput(_ result: AgentCommandResult) -> String {
        let combined = [result.stderr, result.stdout]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return combined.isEmpty ? "No response" : combined
    }
}

public final class ClaudeAdamVoiceRenderer: AgentVoiceRendering {
    private let model: String?
    private let runner: any AgentCommandRunning

    public convenience init(model: String? = nil) {
        self.init(model: model, runner: FoundationAgentCommandRunner())
    }

    init(model: String?, runner: any AgentCommandRunning) {
        self.model = model
        self.runner = runner
    }

    public func render(_ rawResponse: String) throws -> String {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("adam-voice-renderer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        var arguments = [
            "claude",
            "--print",
            "--safe-mode",
            "--no-session-persistence",
            "--permission-mode", "dontAsk",
            "--tools", "",
            "--output-format", "json",
            "--system-prompt", AdamVoiceRendererPrompt.instruction
        ]
        if let model, !model.isEmpty {
            arguments += ["--model", model]
        }
        let result = try runner.run(
            AgentCommand(
                arguments: arguments,
                workingDirectory: scratch,
                standardInput: rawResponse,
                readBoundary: AgentCommandReadBoundary(
                    root: scratch,
                    provider: .claude,
                    denyWrites: false
                )
            )
        )
        guard
            let data = result.stdout.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: .claude,
                message: Self.combinedOutput(result)
            )
        }

        let rendered = object["result"] as? String ?? ""
        let isError = object["is_error"] as? Bool == true
        guard result.status == 0, !isError else {
            throw AgentCLIProviderError.commandFailed(
                provider: .claude,
                status: result.status,
                message: rendered.isEmpty ? Self.combinedOutput(result) : rendered
            )
        }
        guard !rendered.isEmpty else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: .claude,
                message: "The rendered result was empty"
            )
        }
        return rendered
    }

    private static func combinedOutput(_ result: AgentCommandResult) -> String {
        let combined = [result.stderr, result.stdout]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return combined.isEmpty ? "No response" : combined
    }
}

private enum AdamVoiceRendererPrompt {
    static let instruction = """
    You are Adam's separate voice renderer. The supplied text is the complete and only source response. Rewrite it as brief, natural screenless speech. Preserve every substantive claim, qualification, and ranking. Remove Markdown, file paths, line numbers, and visual formatting. Add no facts, advice, or conclusions. Return only the words to be spoken.
    """
}

public enum AgentSpeechError: Error, Equatable, LocalizedError {
    case emptyText
    case commandFailed(status: Int32, message: String)

    public var errorDescription: String? {
        switch self {
        case .emptyText:
            return "There is no voice text to speak"
        case let .commandFailed(status, message):
            return "macOS speech failed (status \(status)): \(message)"
        }
    }
}

public final class MacSaySpeechOutput: AgentSpeechOutput {
    private let rate: Int
    private let runner: any AgentCommandRunning

    public convenience init(rate: Int = 185) {
        self.init(rate: rate, runner: FoundationAgentCommandRunner())
    }

    init(rate: Int, runner: any AgentCommandRunning) {
        self.rate = rate
        self.runner = runner
    }

    public func speak(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AgentSpeechError.emptyText
        }

        let inputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("adam-speech-\(UUID().uuidString).txt")
        try Data(text.utf8).write(to: inputURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: inputURL) }

        let result = try runner.run(
            AgentCommand(
                executableURL: URL(fileURLWithPath: "/usr/bin/say"),
                arguments: ["-r", String(rate), "-f", inputURL.path]
            )
        )
        guard result.status == 0 else {
            let message = [result.stderr, result.stdout]
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw AgentSpeechError.commandFailed(
                status: result.status,
                message: message.isEmpty ? "No response" : message
            )
        }
    }
}
