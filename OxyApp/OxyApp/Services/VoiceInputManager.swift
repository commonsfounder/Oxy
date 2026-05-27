import AVFoundation
import Speech
import Observation

@Observable
@MainActor
final class VoiceInputManager {
    var isRecording = false
    var isPreparing = false
    var transcript = ""
    var errorMessage: String?

    private var audioEngine: AVAudioEngine?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var startTask: Task<Void, Never>?

    var speechAuthStatus: SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    var micAuthStatus: AVAudioSession.RecordPermission {
        AVAudioSession.sharedInstance().recordPermission
    }

    var isAuthorized: Bool {
        speechAuthStatus == .authorized && micAuthStatus == .granted
    }

    func requestPermissions() {
        SFSpeechRecognizer.requestAuthorization { _ in }
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
    }

    func startRecording() {
        guard !isRecording, !isPreparing else { return }

        startTask?.cancel()
        startTask = Task { [weak self] in
            await self?.beginRecording()
        }
    }

    private func beginRecording() async {
        isPreparing = true
        errorMessage = nil
        transcript = ""

        guard await ensurePermissions() else {
            isPreparing = false
            errorMessage = "Enable microphone and speech access to use voice."
            return
        }

        let recognizer = SFSpeechRecognizer(locale: Locale.current)
        guard let recognizer, recognizer.isAvailable else {
            isPreparing = false
            errorMessage = "Speech recognition not available"
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            engine.prepare()
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            isPreparing = false
            errorMessage = "Audio setup failed: \(error.localizedDescription)"
            return
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || (result?.isFinal == true) {
                    self.stopRecording()
                }
            }
        }

        audioEngine = engine
        recognitionRequest = request
        isPreparing = false
        isRecording = true
    }

    func stopRecording() {
        startTask?.cancel()
        startTask = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil
        isPreparing = false
        isRecording = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func ensurePermissions() async -> Bool {
        let speech = await requestSpeechAuthorizationIfNeeded()
        let mic = await requestMicrophoneAuthorizationIfNeeded()
        return speech == .authorized && mic == .granted
    }

    private func requestSpeechAuthorizationIfNeeded() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func requestMicrophoneAuthorizationIfNeeded() async -> AVAudioSession.RecordPermission {
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
