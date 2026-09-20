import Foundation

struct AgentCommand: Equatable {
    let executableURL: URL
    let arguments: [String]
    let workingDirectory: URL?
    let standardInput: String?
    let readBoundary: AgentCommandReadBoundary?

    init(
        executableURL: URL = URL(fileURLWithPath: "/usr/bin/env"),
        arguments: [String],
        workingDirectory: URL? = nil,
        standardInput: String? = nil,
        readBoundary: AgentCommandReadBoundary? = nil
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.standardInput = standardInput
        self.readBoundary = readBoundary
    }
}

struct AgentCommandReadBoundary: Equatable {
    let root: URL
    let provider: AgentCLIProviderID
    let denyWrites: Bool
}

struct AgentCommandResult: Equatable {
    let status: Int32
    let stdout: String
    let stderr: String
}

protocol AgentCommandRunning {
    func run(_ command: AgentCommand) throws -> AgentCommandResult
}

final class FoundationAgentCommandRunner: AgentCommandRunning {
    func run(_ command: AgentCommand) throws -> AgentCommandResult {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("adam-agent-command-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        let stdoutURL = scratch.appendingPathComponent("stdout")
        let stderrURL = scratch.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil)

        let stdoutHandle = try FileHandle(forWritingTo: stdoutURL)
        let stderrHandle = try FileHandle(forWritingTo: stderrURL)
        defer {
            try? stdoutHandle.close()
            try? stderrHandle.close()
        }

        let process = Process()
        var environment = Self.commandEnvironment()
        if let readBoundary = command.readBoundary {
            try Self.prepareIsolatedProviderHome(
                for: readBoundary.provider,
                in: scratch,
                environment: &environment
            )
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = [
                "-p", Self.sandboxProfile(for: readBoundary),
                command.executableURL.path
            ] + command.arguments
        } else {
            process.executableURL = command.executableURL
            process.arguments = command.arguments
        }
        process.environment = environment
        process.currentDirectoryURL = command.workingDirectory
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        var stdinHandle: FileHandle?
        if let standardInput = command.standardInput {
            let stdinURL = scratch.appendingPathComponent("stdin")
            try Data(standardInput.utf8).write(to: stdinURL)
            stdinHandle = try FileHandle(forReadingFrom: stdinURL)
            process.standardInput = stdinHandle
        } else {
            process.standardInput = FileHandle.nullDevice
        }

        try process.run()
        process.waitUntilExit()
        try? stdinHandle?.close()
        try stdoutHandle.synchronize()
        try stderrHandle.synchronize()

        return AgentCommandResult(
            status: process.terminationStatus,
            stdout: try String(contentsOf: stdoutURL, encoding: .utf8),
            stderr: try String(contentsOf: stderrURL, encoding: .utf8)
        )
    }

    static func commandEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let additions = [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]
        let existing = environment["PATH", default: ""]
            .split(separator: ":")
            .map(String.init)
        environment["PATH"] = (additions + existing)
            .reduce(into: [String]()) { paths, path in
                if !paths.contains(path) { paths.append(path) }
            }
            .joined(separator: ":")
        return environment
    }

    static func sandboxProfile(for boundary: AgentCommandReadBoundary) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = boundary.root.standardizingPathAndResolvingSymlinks()
        let providerPaths: [String]
        switch boundary.provider {
        case .codex:
            providerPaths = [
                home.appendingPathComponent(".local/bin").path,
                home.appendingPathComponent(".codex/packages/standalone").path
            ]
        case .claude:
            providerPaths = [
                home.appendingPathComponent(".local/bin").path,
                home.appendingPathComponent(".local/share/claude").path
            ]
        }

        let readable = (providerPaths + [root.path])
            .map { "(subpath \"\(sandboxEscaped($0))\")" }
            .joined(separator: " ")
        let writeRule = boundary.denyWrites
            ? "(deny file-write* (subpath \"\(sandboxEscaped(root.path))\"))"
            : ""
        return """
        (version 1)
        (allow default)
        (deny file-read* (subpath "\(sandboxEscaped(home.path))"))
        (deny file-read* (subpath "/Volumes"))
        (allow file-read* \(readable))
        \(writeRule)
        """
    }

    private static func prepareIsolatedProviderHome(
        for provider: AgentCLIProviderID,
        in scratch: URL,
        environment: inout [String: String]
    ) throws {
        let fileManager = FileManager.default
        let realHome = fileManager.homeDirectoryForCurrentUser
        let isolatedHome = scratch.appendingPathComponent("home", isDirectory: true)
        try fileManager.createDirectory(at: isolatedHome, withIntermediateDirectories: true)
        environment["HOME"] = isolatedHome.path

        switch provider {
        case .codex:
            let codexHome = isolatedHome.appendingPathComponent(".codex", isDirectory: true)
            try fileManager.createDirectory(at: codexHome, withIntermediateDirectories: true)
            try copyRequiredCredential(
                from: realHome.appendingPathComponent(".codex/auth.json"),
                to: codexHome.appendingPathComponent("auth.json")
            )
            environment["CODEX_HOME"] = codexHome.path
        case .claude:
            try copyRequiredCredential(
                from: realHome.appendingPathComponent(".claude.json"),
                to: isolatedHome.appendingPathComponent(".claude.json")
            )
            let claudeConfig = isolatedHome.appendingPathComponent(".claude", isDirectory: true)
            try fileManager.createDirectory(at: claudeConfig, withIntermediateDirectories: true)
            environment["CLAUDE_CONFIG_DIR"] = claudeConfig.path
        }
    }

    private static func copyRequiredCredential(from source: URL, to destination: URL) throws {
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: source.path])
        }
        try FileManager.default.copyItem(at: source, to: destination)
    }

    private static func sandboxEscaped(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

private extension URL {
    func standardizingPathAndResolvingSymlinks() -> URL {
        standardizedFileURL.resolvingSymlinksInPath()
    }
}

public enum AgentCLIProviderError: Error, Equatable, LocalizedError {
    case commandFailed(provider: AgentCLIProviderID, status: Int32, message: String)
    case invalidStructuredOutput(provider: AgentCLIProviderID, message: String)

    public var errorDescription: String? {
        switch self {
        case let .commandFailed(provider, status, message):
            return "\(provider.rawValue.capitalized) failed (status \(status)): \(message)"
        case let .invalidStructuredOutput(provider, message):
            return "\(provider.rawValue.capitalized) returned unusable output: \(message)"
        }
    }
}

public final class CodexCLIProvider: AgentCLIProviding {
    public let id = AgentCLIProviderID.codex
    private let runner: any AgentCommandRunning

    public convenience init() {
        self.init(runner: FoundationAgentCommandRunner())
    }

    init(runner: any AgentCommandRunning) {
        self.runner = runner
    }

    public func availability() -> AgentCLIAvailability {
        let located: AgentCommandResult
        do {
            located = try runner.run(AgentCommand(arguments: ["which", "codex"]))
        } catch {
            return unavailable(installed: false, path: nil, detail: error.localizedDescription)
        }

        let path = located.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard located.status == 0, !path.isEmpty else {
            return unavailable(installed: false, path: nil, detail: "Codex CLI is not installed")
        }

        do {
            let auth = try runner.run(AgentCommand(arguments: ["codex", "login", "status"]))
            let detail = [auth.stdout, auth.stderr]
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return AgentCLIAvailability(
                provider: id,
                isInstalled: true,
                isAuthenticated: auth.status == 0 && detail.localizedCaseInsensitiveContains("logged in"),
                authenticationVerifiedLive: false,
                executablePath: path,
                detail: detail.isEmpty ? "Codex authentication status unavailable" : detail
            )
        } catch {
            return unavailable(installed: true, path: path, detail: error.localizedDescription)
        }
    }

    public func run(prompt: String, in workingDirectory: URL, model: String?) throws -> AgentCLIResponse {
        var arguments = ["codex", "exec"]
        if let model, !model.isEmpty {
            arguments += ["--model", model]
        }
        arguments += [
            // The outer macOS profile is the authoritative read/write boundary.
            // A nested Codex seatbelt cannot initialize inside sandbox-exec.
            "--sandbox", "danger-full-access",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--json",
            "-C", workingDirectory.path,
            prompt
        ]

        let result = try runner.run(
            AgentCommand(
                arguments: arguments,
                workingDirectory: workingDirectory,
                readBoundary: AgentCommandReadBoundary(
                    root: workingDirectory,
                    provider: id,
                    denyWrites: true
                )
            )
        )
        guard result.status == 0 else {
            throw AgentCLIProviderError.commandFailed(
                provider: id,
                status: result.status,
                message: failureMessage(from: result)
            )
        }
        guard let final = Self.finalAgentMessage(from: result.stdout), !final.isEmpty else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: id,
                message: failureMessage(from: result)
            )
        }
        return AgentCLIResponse(text: final, structuredOutput: result.stdout)
    }

    static func finalAgentMessage(from output: String) -> String? {
        var final: String?
        for line in output.split(whereSeparator: \Character.isNewline) {
            guard
                let data = String(line).data(using: .utf8),
                let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                event["type"] as? String == "item.completed",
                let item = event["item"] as? [String: Any],
                item["type"] as? String == "agent_message",
                let text = item["text"] as? String
            else { continue }
            final = text
        }
        return final
    }

    private func unavailable(installed: Bool, path: String?, detail: String) -> AgentCLIAvailability {
        AgentCLIAvailability(
            provider: id,
            isInstalled: installed,
            isAuthenticated: false,
            executablePath: path,
            detail: detail
        )
    }

    private func failureMessage(from result: AgentCommandResult) -> String {
        for line in result.stdout.split(whereSeparator: \Character.isNewline).reversed() {
            guard
                let data = String(line).data(using: .utf8),
                let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if let error = event["error"] as? [String: Any], let message = error["message"] as? String {
                return message
            }
            if let message = event["message"] as? String {
                return message
            }
        }

        let combined = [result.stderr, result.stdout]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return combined.isEmpty ? "No response" : combined
    }
}

public final class ClaudeCLIProvider: AgentCLIProviding {
    public let id = AgentCLIProviderID.claude
    private let runner: any AgentCommandRunning

    public convenience init() {
        self.init(runner: FoundationAgentCommandRunner())
    }

    init(runner: any AgentCommandRunning) {
        self.runner = runner
    }

    public func availability() -> AgentCLIAvailability {
        let located: AgentCommandResult
        do {
            located = try runner.run(AgentCommand(arguments: ["which", "claude"]))
        } catch {
            return unavailable(installed: false, path: nil, detail: error.localizedDescription)
        }

        let path = located.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard located.status == 0, !path.isEmpty else {
            return unavailable(installed: false, path: nil, detail: "Claude Code CLI is not installed")
        }

        do {
            let auth = try runner.run(AgentCommand(arguments: ["claude", "auth", "status"]))
            let object = try? Self.jsonObject(auth.stdout)
            let loggedIn = object?["loggedIn"] as? Bool == true
            let method = object?["authMethod"] as? String
            return AgentCLIAvailability(
                provider: id,
                isInstalled: true,
                isAuthenticated: auth.status == 0 && loggedIn,
                authenticationVerifiedLive: false,
                executablePath: path,
                detail: loggedIn
                    ? "Logged in\(method.map { " using \($0)" } ?? "")"
                    : "Claude authentication is required"
            )
        } catch {
            return unavailable(installed: true, path: path, detail: error.localizedDescription)
        }
    }

    public func run(prompt: String, in workingDirectory: URL, model: String?) throws -> AgentCLIResponse {
        var arguments = [
            "claude",
            "--print",
            "--safe-mode",
            "--no-session-persistence",
            "--permission-mode", "dontAsk",
            "--tools", "Read,Glob,Grep",
            "--output-format", "json"
        ]
        if let model, !model.isEmpty {
            arguments += ["--model", model]
        }
        arguments.append(prompt)

        let result = try runner.run(
            AgentCommand(
                arguments: arguments,
                workingDirectory: workingDirectory,
                readBoundary: AgentCommandReadBoundary(
                    root: workingDirectory,
                    provider: id,
                    denyWrites: true
                )
            )
        )
        guard let object = try? Self.jsonObject(result.stdout) else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: id,
                message: combinedOutput(result)
            )
        }

        let text = object["result"] as? String ?? ""
        let isError = object["is_error"] as? Bool == true
        guard result.status == 0, !isError else {
            throw AgentCLIProviderError.commandFailed(
                provider: id,
                status: result.status,
                message: text.isEmpty ? combinedOutput(result) : text
            )
        }
        guard !text.isEmpty else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: id,
                message: "The result was empty"
            )
        }
        return AgentCLIResponse(text: text, structuredOutput: result.stdout)
    }

    private static func jsonObject(_ text: String) throws -> [String: Any] {
        guard
            let data = text.data(using: .utf8),
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw AgentCLIProviderError.invalidStructuredOutput(
                provider: .claude,
                message: "Expected a JSON object"
            )
        }
        return object
    }

    private func unavailable(installed: Bool, path: String?, detail: String) -> AgentCLIAvailability {
        AgentCLIAvailability(
            provider: id,
            isInstalled: installed,
            isAuthenticated: false,
            executablePath: path,
            detail: detail
        )
    }

    private func combinedOutput(_ result: AgentCommandResult) -> String {
        let combined = [result.stderr, result.stdout]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return combined.isEmpty ? "No response" : combined
    }
}
