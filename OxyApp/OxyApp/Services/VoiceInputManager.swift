import AVFoundation
import Observation

@Observable
@MainActor
final class VoiceInputManager {
    var isRecording = false
    var isTranscribing = false
    var transcript = ""
    var errorMessage: String?

    private var recorder: AVAudioRecorder?
    private var tempURL: URL?
    private var currentUserId = ""
    private var transcribeTask: Task<Void, Never>?

    var micAuthStatus: AVAudioSession.RecordPermission {
        AVAudioSession.sharedInstance().recordPermission
    }

    var isAuthorized: Bool {
        micAuthStatus == .granted
    }

    func requestPermissions() {
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
    }

    func startRecording(userId: String) {
        guard !isRecording, !isTranscribing else { return }
        currentUserId = userId
        transcript = ""
        errorMessage = nil
        Task { await beginRecording() }
    }

    private func beginRecording() async {
        errorMessage = nil
        transcript = ""

        guard await requestMicrophoneIfNeeded() == .granted else {
            errorMessage = "Enable microphone access to use voice."
            return
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("oxy_voice_\(UUID().uuidString).wav")

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false
        ]

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.prepareToRecord()
            guard rec.record() else {
                throw NSError(domain: "VoiceInputManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Recorder did not start."])
            }
            recorder = rec
            tempURL = url
            isRecording = true
            #if DEBUG
            print("[VoiceInput] recording url=\(url.lastPathComponent) format=wav sampleRate=16000 channels=1")
            #endif
        } catch {
            errorMessage = "Audio setup failed: \(error.localizedDescription)"
            // The session may have been activated above even though recording
            // never actually started; leaving it active blocks other audio
            // (e.g. music ducking) until the app backgrounds.
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    func stopRecording() {
        guard isRecording, let rec = recorder, let url = tempURL else {
            cancel()
            return
        }
        rec.stop()
        recorder = nil
        tempURL = nil
        isRecording = false
        isTranscribing = true

        let uid = currentUserId
        transcribeTask = Task {
            defer {
                try? FileManager.default.removeItem(at: url)
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                if !Task.isCancelled { isTranscribing = false }
            }
            guard !Task.isCancelled else { return }
            do {
                let audioData = try Data(contentsOf: url)
                #if DEBUG
                print("[VoiceInput] upload bytes=\(audioData.count) field=audio file=voice.wav mime=audio/wav")
                #endif
                guard !audioData.isEmpty else {
                    throw NSError(domain: "VoiceInputManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "Recorded audio was empty."])
                }
                let responseData = try await APIClient.shared.multipartRequest(
                    path: "/pendant/transcribe",
                    fields: ["userId": uid],
                    fileField: "audio",
                    fileName: "voice.wav",
                    mimeType: "audio/wav",
                    fileData: audioData
                )
                guard !Task.isCancelled else { return }
                struct TranscriptResponse: Decodable { let transcript: String }
                let result = try JSONDecoder().decode(TranscriptResponse.self, from: responseData)
                transcript = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if transcript.isEmpty {
                    errorMessage = "I couldn't clearly make out what you said. Please try again."
                }
            } catch {
                if !Task.isCancelled {
                    #if DEBUG
                    print("[VoiceInput] transcription failed: \(error.localizedDescription)")
                    #endif
                    errorMessage = "Transcription failed. Please try again."
                }
            }
        }
    }

    func cancel() {
        transcribeTask?.cancel()
        transcribeTask = nil
        recorder?.stop()
        recorder = nil
        if let url = tempURL {
            try? FileManager.default.removeItem(at: url)
            tempURL = nil
        }
        isRecording = false
        isTranscribing = false
        transcript = ""
        errorMessage = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestMicrophoneIfNeeded() async -> AVAudioSession.RecordPermission {
        let session = AVAudioSession.sharedInstance()
        let current = session.recordPermission
        guard current == .undetermined else { return current }
        return await withCheckedContinuation { continuation in
            session.requestRecordPermission { granted in
                continuation.resume(returning: granted ? .granted : .denied)
            }
        }
    }
}
