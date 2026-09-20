import Foundation
import XCTest
@testable import AdamMacRuntime

final class AgentCLIBridgeTests: XCTestCase {
    func testRunKeepsAgentOutputExactAndPassesOnlyItToVoiceAndSpeech() throws {
        let provider = FakeAgentProvider(
            id: .codex,
            availability: .ready(provider: .codex, executablePath: "/usr/local/bin/codex"),
            response: AgentCLIResponse(
                text: "1. **Persistence is unfinished.** Tasks disappear after restart.",
                structuredOutput: "{\"type\":\"result\"}"
            )
        )
        let renderer = RecordingVoiceRenderer(output: "First, persistence is unfinished. Tasks disappear after restart.")
        let speaker = RecordingSpeaker()
        let bridge = AgentCLIBridge(providers: [provider], renderer: renderer, speaker: speaker)
        let folder = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)

        let result = try bridge.run(
            AgentCLIRequest(
                prompt: "What is unfinished?",
                workingDirectory: folder,
                preferredProvider: .codex
            ),
            speak: true
        )

        XCTAssertEqual(result.provider, .codex)
        XCTAssertEqual(result.rawResponse, "1. **Persistence is unfinished.** Tasks disappear after restart.")
        XCTAssertEqual(renderer.received, [result.rawResponse])
        XCTAssertEqual(result.renderedSpeech, "First, persistence is unfinished. Tasks disappear after restart.")
        XCTAssertEqual(speaker.spoken, [try XCTUnwrap(result.renderedSpeech)])
        XCTAssertTrue(result.spoken)
        XCTAssertNil(result.deliveryError)
    }

    func testRunUsesFirstReadyProviderWhenNoneIsPreferred() throws {
        let unavailableCodex = FakeAgentProvider(
            id: .codex,
            availability: AgentCLIAvailability(
                provider: .codex,
                isInstalled: true,
                isAuthenticated: false,
                executablePath: "/usr/local/bin/codex",
                detail: "Sign in required"
            ),
            response: AgentCLIResponse(text: "unused", structuredOutput: "")
        )
        let readyClaude = FakeAgentProvider(
            id: .claude,
            availability: .ready(provider: .claude, executablePath: "/usr/local/bin/claude"),
            response: AgentCLIResponse(text: "Claude's exact answer", structuredOutput: "{}")
        )
        let renderer = RecordingVoiceRenderer(output: "Claude's spoken answer")
        let bridge = AgentCLIBridge(
            providers: [unavailableCodex, readyClaude],
            renderer: renderer,
            speaker: RecordingSpeaker()
        )

        let result = try bridge.run(
            AgentCLIRequest(
                prompt: "Inspect this folder",
                workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            ),
            speak: false
        )

        XCTAssertEqual(result.provider, .claude)
        XCTAssertEqual(result.rawResponse, "Claude's exact answer")
        XCTAssertFalse(result.spoken)
    }

    func testAutomaticRunFallsBackWhenCodexFailsLive() throws {
        let codex = FakeAgentProvider(
            id: .codex,
            availability: .ready(provider: .codex, executablePath: "/usr/local/bin/codex"),
            error: AgentCLIProviderError.commandFailed(
                provider: .codex,
                status: 1,
                message: "Token expired"
            )
        )
        let claude = FakeAgentProvider(
            id: .claude,
            availability: .ready(provider: .claude, executablePath: "/usr/local/bin/claude"),
            response: AgentCLIResponse(text: "Claude took over", structuredOutput: "{}")
        )
        let bridge = AgentCLIBridge(
            providers: [codex, claude],
            renderer: RecordingVoiceRenderer(output: "Claude took over"),
            speaker: RecordingSpeaker()
        )

        let result = try bridge.run(
            AgentCLIRequest(
                prompt: "Inspect this folder",
                workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
                providerModels: [.codex: "gpt-5.5", .claude: "claude-sonnet"]
            ),
            speak: false
        )

        XCTAssertEqual(result.provider, .claude)
        XCTAssertEqual(result.rawResponse, "Claude took over")
        XCTAssertEqual(codex.receivedModels, ["gpt-5.5"])
        XCTAssertEqual(claude.receivedModels, ["claude-sonnet"])
        XCTAssertEqual(result.provenance.model, "claude-sonnet")
    }

    func testLiveStyleRenderingStaysWithTheSelectedProvider() throws {
        let codexRenderer = RecordingVoiceRenderer(output: "Codex voice")
        let claudeRenderer = RecordingVoiceRenderer(output: "Claude voice")
        let claude = FakeAgentProvider(
            id: .claude,
            availability: .ready(provider: .claude, executablePath: "/usr/local/bin/claude"),
            response: AgentCLIResponse(text: "Claude raw", structuredOutput: "{}")
        )
        let bridge = AgentCLIBridge(
            providers: [claude],
            providerRenderers: [.codex: codexRenderer, .claude: claudeRenderer],
            speaker: RecordingSpeaker()
        )

        let result = try bridge.run(
            AgentCLIRequest(
                prompt: "Inspect this folder",
                workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
                preferredProvider: .claude
            ),
            speak: false
        )

        XCTAssertEqual(codexRenderer.received, [])
        XCTAssertEqual(claudeRenderer.received, ["Claude raw"])
        XCTAssertEqual(result.provenance.rendererProvider, .claude)
    }

    func testRawResponseSurvivesVoiceRenderingFailure() throws {
        let provider = FakeAgentProvider(
            id: .codex,
            availability: .ready(provider: .codex, executablePath: "/usr/local/bin/codex"),
            response: AgentCLIResponse(text: "Codex exact answer", structuredOutput: "{}")
        )
        let bridge = AgentCLIBridge(
            providers: [provider],
            renderer: ThrowingVoiceRenderer(error: AgentVoiceRenderingError.allRenderersFailed(["renderer unavailable"])),
            speaker: RecordingSpeaker()
        )

        let result = try bridge.run(
            AgentCLIRequest(
                prompt: "Inspect this folder",
                workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
                preferredProvider: .codex
            )
        )

        XCTAssertEqual(result.rawResponse, "Codex exact answer")
        XCTAssertNil(result.renderedSpeech)
        XCTAssertFalse(result.spoken)
        XCTAssertEqual(result.deliveryError, "renderer unavailable")
    }

    func testCodexProviderCapturesTheLastAgentMessageFromStructuredOutput() throws {
        let stdout = """
        {"type":"thread.started","thread_id":"thread-1"}
        {"type":"item.completed","item":{"type":"agent_message","text":"Checking the files."}}
        {"type":"item.completed","item":{"type":"agent_message","text":"1. The exact final answer."}}
        {"type":"turn.completed"}
        """
        let runner = RecordingCommandRunner(results: [
            AgentCommandResult(status: 0, stdout: "/opt/codex\n", stderr: ""),
            AgentCommandResult(status: 0, stdout: "Logged in using ChatGPT\n", stderr: ""),
            AgentCommandResult(status: 0, stdout: stdout, stderr: "")
        ])
        let provider = CodexCLIProvider(runner: runner)

        let availability = provider.availability()
        XCTAssertTrue(availability.isAuthenticated)
        XCTAssertFalse(availability.authenticationVerifiedLive)
        let response = try provider.run(
            prompt: "Inspect this folder",
            in: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
            model: "gpt-5.5"
        )

        XCTAssertEqual(response.text, "1. The exact final answer.")
        XCTAssertEqual(response.structuredOutput, stdout)
        XCTAssertNil(runner.commands.last?.standardInput)
        XCTAssertTrue(runner.commands.last?.arguments.contains("danger-full-access") == true)
        XCTAssertTrue(runner.commands.last?.arguments.contains("gpt-5.5") == true)
        XCTAssertEqual(
            runner.commands.last?.readBoundary?.root.standardizedFileURL.path,
            URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).standardizedFileURL.path
        )
        XCTAssertEqual(runner.commands.last?.readBoundary?.provider, .codex)
        XCTAssertEqual(runner.commands.last?.readBoundary?.denyWrites, true)
        XCTAssertFalse(
            runner.commands.last?.arguments.joined(separator: " ")
                .localizedCaseInsensitiveContains("voice") == true
        )
    }

    func testClaudeProviderCapturesResultAndUsesReadOnlyTools() throws {
        let stdout = """
        {"type":"result","subtype":"success","is_error":false,"result":"Claude's exact final answer."}
        """
        let runner = RecordingCommandRunner(results: [
            AgentCommandResult(status: 0, stdout: "/opt/claude\n", stderr: ""),
            AgentCommandResult(
                status: 0,
                stdout: "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\n",
                stderr: ""
            ),
            AgentCommandResult(status: 0, stdout: stdout, stderr: "")
        ])
        let provider = ClaudeCLIProvider(runner: runner)

        let availability = provider.availability()
        XCTAssertTrue(availability.isAuthenticated)
        XCTAssertFalse(availability.authenticationVerifiedLive)
        let response = try provider.run(
            prompt: "Inspect this folder",
            in: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
            model: nil
        )

        XCTAssertEqual(response.text, "Claude's exact final answer.")
        XCTAssertEqual(response.structuredOutput, stdout)
        XCTAssertTrue(runner.commands.last?.arguments.contains("Read,Glob,Grep") == true)
        XCTAssertTrue(runner.commands.last?.arguments.contains("dontAsk") == true)
        XCTAssertEqual(runner.commands.last?.readBoundary?.provider, .claude)
        XCTAssertEqual(runner.commands.last?.readBoundary?.denyWrites, true)
        XCTAssertFalse(
            runner.commands.last?.arguments.joined(separator: " ")
                .localizedCaseInsensitiveContains("voice") == true
        )
    }

    func testAdamVoiceRendererReceivesOnlyCapturedResponseAsItsInput() throws {
        let raw = "1. **Persistence is unfinished.** Tasks disappear after restart."
        let stdout = """
        {"type":"item.completed","item":{"type":"agent_message","text":"First, persistence is unfinished. Tasks disappear after restart."}}
        {"type":"turn.completed"}
        """
        let runner = RecordingCommandRunner(results: [
            AgentCommandResult(status: 0, stdout: stdout, stderr: "")
        ])
        let renderer = CodexAdamVoiceRenderer(model: "gpt-5.5", runner: runner)

        let spoken = try renderer.render(raw)

        XCTAssertEqual(spoken, "First, persistence is unfinished. Tasks disappear after restart.")
        XCTAssertEqual(runner.commands.last?.standardInput, raw)
        XCTAssertTrue(
            runner.commands.last?.workingDirectory?.path.hasPrefix(NSTemporaryDirectory()) == true
        )
        XCTAssertTrue(
            runner.commands.last?.arguments.joined(separator: " ")
                .localizedCaseInsensitiveContains("screenless speech") == true
        )
    }

    func testVoiceRendererFallsBackWhenCodexRendererIsUnavailable() throws {
        let fallback = FallbackAgentVoiceRenderer(renderers: [
            ThrowingVoiceRenderer(error: AgentCLIProviderError.commandFailed(
                provider: .codex,
                status: 127,
                message: "not installed"
            )),
            RecordingVoiceRenderer(output: "Claude rendered this for speech.")
        ])

        let result = try fallback.render("Claude's exact raw answer.")

        XCTAssertEqual(result, "Claude rendered this for speech.")
    }

    func testClaudeVoiceRendererGetsRawResponseWithoutProjectTools() throws {
        let raw = "Claude's exact raw answer."
        let stdout = """
        {"type":"result","subtype":"success","is_error":false,"result":"Claude rendered this for speech."}
        """
        let runner = RecordingCommandRunner(results: [
            AgentCommandResult(status: 0, stdout: stdout, stderr: "")
        ])
        let renderer = ClaudeAdamVoiceRenderer(model: nil, runner: runner)

        let result = try renderer.render(raw)

        XCTAssertEqual(result, "Claude rendered this for speech.")
        XCTAssertEqual(runner.commands.last?.standardInput, raw)
        XCTAssertFalse(runner.commands.last?.arguments.contains(raw) == true)
        let toolsIndex = runner.commands.last?.arguments.firstIndex(of: "--tools")
        XCTAssertEqual(toolsIndex.map { runner.commands.last?.arguments[$0 + 1] }, "")
        XCTAssertTrue(
            runner.commands.last?.workingDirectory?.path.hasPrefix(NSTemporaryDirectory()) == true
        )
    }

    func testNaturalAdamRequestSelectsTheNamedAgentAndCurrentFolder() throws {
        let folder = URL(fileURLWithPath: "/tmp/example-project", isDirectory: true)

        let request = try XCTUnwrap(
            AgentCLIInvocationParser.parse(
                "Adam, ask Codex what's unfinished in this folder",
                currentDirectory: folder
            )
        )

        XCTAssertEqual(request.preferredProvider, .codex)
        XCTAssertEqual(request.workingDirectory, folder)
        XCTAssertEqual(request.prompt, "what's unfinished in this folder")
    }

    func testConversationRequestRoutesSpokenInvocationToNamedProvider() throws {
        let folder = URL(fileURLWithPath: "/tmp/example-project", isDirectory: true)

        let request = try AgentConversationRequestFactory.makeRequest(
            input: "Adam, ask Claude to inspect the tests",
            selectedProvider: .codex,
            workingDirectory: folder,
            providerModels: [.codex: "gpt-5.5", .claude: "claude-sonnet"]
        )

        XCTAssertEqual(request.preferredProvider, .claude)
        XCTAssertEqual(request.prompt, "inspect the tests")
        XCTAssertEqual(request.workingDirectory, folder)
        XCTAssertEqual(request.providerModels[.claude], "claude-sonnet")
    }

    func testConversationRequestUsesVisibleProviderForPlainChatInput() throws {
        let folder = URL(fileURLWithPath: "/tmp/example-project", isDirectory: true)

        let request = try AgentConversationRequestFactory.makeRequest(
            input: "Tell me what is unfinished",
            selectedProvider: .codex,
            workingDirectory: folder
        )

        XCTAssertEqual(request.preferredProvider, .codex)
        XCTAssertEqual(request.prompt, "Tell me what is unfinished")
        XCTAssertEqual(request.workingDirectory, folder)
    }

    func testClaudeProviderReportsExpiredTokenInsteadOfReturningItAsAnAnswer() throws {
        let stdout = """
        {"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."}
        """
        let runner = RecordingCommandRunner(results: [
            AgentCommandResult(status: 1, stdout: stdout, stderr: "")
        ])
        let provider = ClaudeCLIProvider(runner: runner)

        XCTAssertThrowsError(
            try provider.run(
                prompt: "Inspect this folder",
                in: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
                model: nil
            )
        ) { error in
            XCTAssertEqual(
                error as? AgentCLIProviderError,
                .commandFailed(
                    provider: .claude,
                    status: 1,
                    message: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."
                )
            )
        }
    }

    func testFinderStyleEnvironmentCanLocateUserInstalledAgentCLIs() {
        let environment = FoundationAgentCommandRunner.commandEnvironment()
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let paths = environment["PATH", default: ""].split(separator: ":").map(String.init)

        XCTAssertTrue(paths.contains("\(home)/.local/bin"))
        XCTAssertTrue(paths.contains("/opt/homebrew/bin"))
        XCTAssertTrue(paths.contains("/usr/local/bin"))
    }

    func testSandboxProfileReadsOnlySelectedHomeSubtreeAndDeniesWritesThere() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let selected = URL(fileURLWithPath: "\(home)/Documents/Selected Project", isDirectory: true)
        let profile = FoundationAgentCommandRunner.sandboxProfile(
            for: AgentCommandReadBoundary(root: selected, provider: .codex, denyWrites: true)
        )

        XCTAssertTrue(profile.contains("(deny file-read* (subpath \"\(home)\"))"))
        XCTAssertTrue(profile.contains("(deny file-read* (subpath \"/Volumes\"))"))
        XCTAssertTrue(profile.contains("(subpath \"\(selected.path)\")"))
        XCTAssertTrue(profile.contains("(deny file-write* (subpath \"\(selected.path)\"))"))
        XCTAssertFalse(profile.contains(".codex/auth.json"))
        XCTAssertFalse(profile.contains(".claude.json"))
    }
}

private final class FakeAgentProvider: AgentCLIProviding {
    let id: AgentCLIProviderID
    let currentAvailability: AgentCLIAvailability
    let response: AgentCLIResponse?
    let error: Error?
    private(set) var receivedModels: [String?] = []

    init(
        id: AgentCLIProviderID,
        availability: AgentCLIAvailability,
        response: AgentCLIResponse? = nil,
        error: Error? = nil
    ) {
        self.id = id
        currentAvailability = availability
        self.response = response
        self.error = error
    }

    func availability() -> AgentCLIAvailability {
        currentAvailability
    }

    func run(prompt _: String, in _: URL, model: String?) throws -> AgentCLIResponse {
        receivedModels.append(model)
        if let error { throw error }
        return response ?? AgentCLIResponse(text: "", structuredOutput: "")
    }
}

private final class RecordingVoiceRenderer: AgentVoiceRendering {
    let output: String
    private(set) var received: [String] = []

    init(output: String) {
        self.output = output
    }

    func render(_ rawResponse: String) throws -> String {
        received.append(rawResponse)
        return output
    }
}

private final class RecordingSpeaker: AgentSpeechOutput {
    private(set) var spoken: [String] = []

    func speak(_ text: String) throws {
        spoken.append(text)
    }
}

private final class ThrowingVoiceRenderer: AgentVoiceRendering {
    let error: Error

    init(error: Error) {
        self.error = error
    }

    func render(_: String) throws -> String {
        throw error
    }
}

private final class RecordingCommandRunner: AgentCommandRunning {
    private var results: [AgentCommandResult]
    private(set) var commands: [AgentCommand] = []

    init(results: [AgentCommandResult]) {
        self.results = results
    }

    func run(_ command: AgentCommand) throws -> AgentCommandResult {
        commands.append(command)
        return results.removeFirst()
    }
}
