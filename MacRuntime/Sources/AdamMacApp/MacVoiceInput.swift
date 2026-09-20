import AVFoundation
import Foundation
import Speech

@MainActor
final class MacVoiceInput: ObservableObject {
    @Published private(set) var isListening = false
    @Published private(set) var transcript = ""
    @Published private(set) var errorMessage: String?

    var onFinalTranscript: ((String) -> Void)?

    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var deliveredFinal = false
    private var hasAudioTap = false

    func toggle() {
        if isListening {
            stop()
        } else {
            Task { await startWithPermission() }
        }
    }

    func stop() {
        guard isListening else { return }
        let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        deliveredFinal = true
        stopIfNeeded()
        if !final.isEmpty {
            onFinalTranscript?(final)
        }
    }

    func cancel() {
        deliveredFinal = true
        stopIfNeeded()
        transcript = ""
    }

    private func startWithPermission() async {
        errorMessage = nil
        let speechAllowed = await requestSpeechPermission()
        guard speechAllowed else {
            errorMessage = "Speech recognition permission is required."
            return
        }
        let microphoneAllowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard microphoneAllowed else {
            errorMessage = "Microphone permission is required."
            return
        }
        startRecognition()
    }

    private func startRecognition() {
        stopIfNeeded()
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition is unavailable."
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            errorMessage = "On-device speech recognition is unavailable."
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request
        transcript = ""
        deliveredFinal = false

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        hasAudioTap = true

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.finishAndDeliver()
                    }
                } else if let error {
                    self.errorMessage = error.localizedDescription
                    self.stopIfNeeded()
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isListening = true
        } catch {
            errorMessage = error.localizedDescription
            stopIfNeeded()
        }
    }

    private func finishAndDeliver() {
        guard !deliveredFinal else { return }
        deliveredFinal = true
        let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        stopIfNeeded()
        if !final.isEmpty {
            onFinalTranscript?(final)
        }
    }

    private func stopIfNeeded() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if hasAudioTap {
            audioEngine.inputNode.removeTap(onBus: 0)
            hasAudioTap = false
        }
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        isListening = false
    }

    private func requestSpeechPermission() async -> Bool {
        if SFSpeechRecognizer.authorizationStatus() == .authorized {
            return true
        }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }
}
