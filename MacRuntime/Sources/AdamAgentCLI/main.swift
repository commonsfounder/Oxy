import AdamMacRuntime
import Foundation

private struct Options {
    var folder: String?
    var prompt: String?
    var provider: AgentCLIProviderID?
    var model: String?
    var rendererModel: String?
    var shouldSpeak = true
    var listProviders = false
    var json = false
}

private enum CLIError: Error, LocalizedError {
    case missingValue(String)
    case invalidProvider(String)
    case missingRequiredArguments
    case modelNeedsProvider
    case unknownArgument(String)

    var errorDescription: String? {
        switch self {
        case let .missingValue(flag):
            return "Missing value for \(flag)"
        case let .invalidProvider(value):
            return "Unknown agent '\(value)'. Use codex or claude."
        case .missingRequiredArguments:
            return "Both --folder and --prompt are required"
        case .modelNeedsProvider:
            return "--model requires --agent codex or --agent claude"
        case let .unknownArgument(value):
            return "Unknown argument: \(value)"
        }
    }
}

private func parseArguments(_ arguments: [String]) throws -> Options {
    var options = Options()

    if let first = arguments.first, !first.hasPrefix("--") {
        let invocation = arguments.joined(separator: " ")
        let currentDirectory = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        )
        guard let request = AgentCLIInvocationParser.parse(
            invocation,
            currentDirectory: currentDirectory
        ) else {
            throw CLIError.unknownArgument(invocation)
        }
        options.folder = request.workingDirectory.path
        options.prompt = request.prompt
        options.provider = request.preferredProvider
        return options
    }

    var index = 0

    func value(after flag: String) throws -> String {
        guard index + 1 < arguments.count else { throw CLIError.missingValue(flag) }
        return arguments[index + 1]
    }

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--folder":
            options.folder = try value(after: argument)
            index += 2
        case "--prompt":
            options.prompt = try value(after: argument)
            index += 2
        case "--agent":
            let raw = try value(after: argument)
            guard let provider = AgentCLIProviderID(rawValue: raw.lowercased()) else {
                throw CLIError.invalidProvider(raw)
            }
            options.provider = provider
            index += 2
        case "--model":
            options.model = try value(after: argument)
            index += 2
        case "--renderer-model":
            options.rendererModel = try value(after: argument)
            index += 2
        case "--no-speak":
            options.shouldSpeak = false
            index += 1
        case "--list":
            options.listProviders = true
            index += 1
        case "--json":
            options.json = true
            index += 1
        case "--help", "-h":
            printUsage()
            exit(0)
        default:
            throw CLIError.unknownArgument(argument)
        }
    }
    if options.model != nil, options.provider == nil {
        throw CLIError.modelNeedsProvider
    }
    return options
}

private func printUsage() {
    print("""
    Usage:
      adam-agent --list [--json]
      adam-agent "Adam, ask Codex what's unfinished in this folder"
      adam-agent --folder <path> --prompt <text> [--agent codex|claude]
                 [--model <agent-model>] [--renderer-model <codex-model>]
                 [--no-speak] [--json]
    """)
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    let options = try parseArguments(Array(CommandLine.arguments.dropFirst()))
    let environment = ProcessInfo.processInfo.environment
    let defaultCodexModel = environment["ADAM_CODEX_MODEL"]
    let rendererModel = options.rendererModel
        ?? defaultCodexModel
        ?? (options.provider == nil || options.provider == .codex ? options.model : nil)
    let bridge = AgentCLIBridge.live(
        rendererModel: rendererModel,
        claudeRendererModel: environment["ADAM_CLAUDE_MODEL"]
    )
    var providerModels: [AgentCLIProviderID: String] = [:]
    if let defaultCodexModel {
        providerModels[.codex] = defaultCodexModel
    }
    if let defaultClaudeModel = environment["ADAM_CLAUDE_MODEL"] {
        providerModels[.claude] = defaultClaudeModel
    }

    if options.listProviders {
        let providers = bridge.availableProviders()
        if options.json {
            try writeJSON(providers)
        } else {
            for provider in providers {
                let state: String
                if provider.isInstalled && provider.isAuthenticated && provider.authenticationVerifiedLive {
                    state = "ready"
                } else if provider.isInstalled && provider.isAuthenticated {
                    state = "sign-in stored; live access is checked when used"
                } else {
                    state = "unavailable"
                }
                print("\(provider.provider.rawValue): \(state) — \(provider.detail)")
            }
        }
        exit(0)
    }

    guard let folder = options.folder, let prompt = options.prompt else {
        throw CLIError.missingRequiredArguments
    }

    let result = try bridge.run(
        AgentCLIRequest(
            prompt: prompt,
            workingDirectory: URL(fileURLWithPath: folder, isDirectory: true),
            preferredProvider: options.provider,
            model: options.model,
            providerModels: providerModels
        ),
        speak: options.shouldSpeak
    )

    if options.json {
        try writeJSON(result)
    } else {
        print("Agent: \(result.provider.rawValue)")
        print("\nExact agent response:\n\(result.rawResponse)")
        print("\nAdam voice:\n\(result.renderedSpeech ?? "Unavailable")")
        print("\nSpoken: \(result.spoken ? "yes" : "no")")
        if let deliveryError = result.deliveryError {
            print("Delivery error: \(deliveryError)")
        }
    }
} catch {
    FileHandle.standardError.write(Data("adam-agent: \(error.localizedDescription)\n".utf8))
    exit(1)
}
