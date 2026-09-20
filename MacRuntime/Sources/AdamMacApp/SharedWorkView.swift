import SwiftUI

struct SharedWorkView: View {
    @StateObject private var model = SharedWorkModel()
    @StateObject private var voice = MacVoiceInput()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.userID == nil {
                Text("Work across your devices").font(.title2)
                TextField("Email or username", text: $model.identifier)
                SecureField("Password", text: $model.password)
                Button("Sign in") { Task { await model.signIn() } }
                    .disabled(model.busy || model.password.isEmpty || model.identifier.isEmpty)
            } else {
                HStack {
                    Text("Adam").font(.headline)
                    Text(model.userID ?? "").foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh") { Task { await model.refresh() } }
                    Button("Sign out") { voice.cancel(); model.signOut() }.disabled(model.busy)
                }
                HSplitView {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(model.tasks) { task in
                                Button { model.select(task) } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(task.goal).lineLimit(2)
                                        Text(task.statusText).font(.caption).foregroundStyle(.secondary)
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                                }.buttonStyle(.plain)
                            }
                        }
                    }.frame(minWidth: 200, idealWidth: 240)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if let task = model.selected {
                                Text(task.goal).font(.title2)
                                Text(task.statusText).foregroundStyle(.secondary)
                                ForEach(task.results, id: \.id) { result in
                                    Text(result.summary).textSelection(.enabled)
                                }
                                if !task.awaitingApproval && ["pending", "paused", "failed"].contains(task.status) {
                                    Button("Continue request") { Task { await model.startSelected() } }.disabled(model.busy)
                                }
                            } else {
                                Text("Start a request or select one from Work.").foregroundStyle(.secondary)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding()
                    }.frame(minWidth: 300)
                }
                HStack {
                    TextField("What needs doing?", text: $model.input)
                        .onSubmit { Task { await model.submit() } }
                    Button(voice.isListening ? "Send speech" : "Speak") {
                        model.interrupt()
                        voice.toggle()
                    }.disabled(model.busy)
                    Button("Send") { voice.cancel(); Task { await model.submit() } }
                        .disabled(model.busy || model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if voice.isListening { Text(voice.transcript.isEmpty ? "Listening" : voice.transcript).foregroundStyle(.secondary) }
                HStack {
                    if model.speaking {
                        Button("Stop speaking") { model.interrupt() }
                    } else if let delivery = model.delivery, !delivery.finished {
                        Button("Continue speaking") { model.resumeSpeaking() }
                    }
                    if let error = voice.errorMessage { Text(error).foregroundStyle(.red) }
                }
            }
            Text(model.status).font(.caption).foregroundStyle(.secondary)
        }
        .padding(24)
        .textFieldStyle(.roundedBorder)
        .task {
            voice.onFinalTranscript = { transcript in
                switch transcript.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                case "continue speaking", "keep speaking": model.resumeSpeaking()
                case "stop speaking", "be quiet": model.interrupt()
                default: Task { await model.submit(transcript) }
                }
            }
            while !Task.isCancelled {
                await model.refresh()
                do { try await Task.sleep(for: .seconds(5)) } catch { break }
            }
        }
        .onChange(of: voice.isListening) { _, listening in model.speechAllowed = !listening }
        .onDisappear { voice.cancel(); model.interrupt() }
    }
}
