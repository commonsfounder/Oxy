import AdamMacRuntime
import SwiftUI

struct AgentConversationView: View {
    @StateObject private var model = MacAgentConversationModel()
    @StateObject private var voice = MacVoiceInput()

    var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            conversation
            Divider()
            composer
        }
        .task {
            voice.onFinalTranscript = { transcript in
                model.submit(transcript)
            }
            model.refreshAvailability()
        }
    }

    private var controls: some View {
        HStack(spacing: 16) {
            Picker("Agent", selection: $model.selectedProvider) {
                ForEach(AgentCLIProviderID.allCases, id: \.self) { provider in
                    Text(provider.rawValue.capitalized).tag(provider)
                }
            }
            .frame(width: 180)

            Text(model.detail(for: model.selectedProvider))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer()

            Button(model.workingDirectory?.lastPathComponent ?? "Choose folder") {
                model.chooseFolder()
            }
            .help(model.workingDirectory?.path ?? "Select the folder this agent may read")
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 14)
    }

    private var conversation: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if model.messages.isEmpty {
                    Text("Ask what needs attention in the selected folder.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 240)
                }

                ForEach(model.messages) { message in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.role == .user
                            ? "You"
                            : (message.provider?.rawValue.capitalized ?? "Agent"))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(message.content)
                            .textSelection(.enabled)
                        if let spoken = message.renderedSpeech,
                           spoken != message.content {
                            Text("Spoken")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(spoken)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        if let deliveryError = message.deliveryError {
                            Text(deliveryError)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(
                        message.role == .user
                            ? Color.accentColor.opacity(0.10)
                            : Color.secondary.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 14)
                    )
                }
            }
            .padding(28)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if voice.isListening || !voice.transcript.isEmpty {
                Text(voice.transcript.isEmpty ? "Listening" : voice.transcript)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let error = voice.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack(alignment: .bottom, spacing: 12) {
                TextField("Ask about this folder", text: $model.inputText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .onSubmit { model.submit() }

                Button(voice.isListening ? "Stop" : "Speak") {
                    voice.toggle()
                }
                .disabled(model.isRunning || model.workingDirectory == nil)

                Button(model.isRunning ? "Working" : "Send") {
                    model.submit()
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isRunning
                        || model.workingDirectory == nil
                        || model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }

            Text(model.status)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
    }
}
