import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges pendant BLE audio to the chat pipeline.
///
/// Listens for raw PCM data from `PendantBLEManager`, buffers it until "DONE"
/// is received, then transcribes the audio using Apple Speech and posts the
/// transcript via a callback.
@Observable
@MainActor
final class PendantAudioBridge {

    enum BridgeState: String {
        case idle
        case listening
        case transcribing
    }

    private(set) var state: BridgeState = .idle
    private(set) var lastTranscript: String?
    private(set) var errorMessage: String?

    @ObservationIgnored private var audioBuffer = Data()
    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private let sampleRate: Double = 16000
    @ObservationIgnored private let doneSignal = Data("DONE".utf8)

    var onTranscript: ((String) -> Void)?

    init() {
        observer = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didReceiveData,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let data = notification.object as? Data else { return }
            Task { @MainActor in
                self?.handleIncomingData(data)
            }
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func handleIncomingData(_ data: Data) {
        if data == doneSignal {
            let captured = audioBuffer
            audioBuffer = Data()
            if captured.isEmpty {
                state = .idle
                return
            }
            state = .transcribing
            Task {
                await transcribe(pcmData: captured)
            }
        } else {
            if state != .listening {
                state = .listening
                audioBuffer = Data()
                errorMessage = nil
            }
            audioBuffer.append(data)
        }
    }

    private func transcribe(pcmData: Data) async {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            let status = await requestSpeechAuthorization()
            guard status == .authorized else {
                errorMessage = "Speech recognition not authorized"
                state = .idle
                return
            }
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale.current),
              recognizer.isAvailable else {
            errorMessage = "Speech recognition not available"
            state = .idle
            return
        }

        let audioFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!

        let frameCount = UInt32(pcmData.count / MemoryLayout<Int16>.size)
        guard frameCount > 0,
              let pcmBuf = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameCount) else {
            errorMessage = "Invalid audio data"
            state = .idle
            return
        }
        pcmBuf.frameLength = frameCount

        pcmData.withUnsafeBytes { raw in
            if let src = raw.baseAddress {
                memcpy(pcmBuf.int16ChannelData![0], src, pcmData.count)
            }
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        request.append(pcmBuf)
        request.endAudio()

        do {
            let result = try await recognizer.recognitionTask(with: request)
            let transcript = result.bestTranscription.formattedString
            if transcript.isEmpty {
                errorMessage = "Could not understand audio"
                state = .idle
                return
            }
            lastTranscript = transcript
            state = .idle
            onTranscript?(transcript)
        } catch {
            errorMessage = "Transcription failed: \(error.localizedDescription)"
            state = .idle
        }
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}

// Async wrapper for SFSpeechRecognizer since it uses completion handlers
private extension SFSpeechRecognizer {
    func recognitionTask(with request: SFSpeechRecognitionRequest) async throws -> SFSpeechRecognitionResult {
        try await withCheckedThrowingContinuation { continuation in
            recognitionTask(with: request) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let result, result.isFinal {
                    continuation.resume(returning: result)
                }
            }
        }
    }
}
