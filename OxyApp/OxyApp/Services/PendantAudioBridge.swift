import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// The pendant streams PCM audio continuously once connected. This bridge
/// feeds it into Apple's live speech recognizer, detects when the user
/// finishes speaking (via silence timeout), and sends the transcript
/// to the chat.
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

    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private var connectionObserver: NSObjectProtocol?
    @ObservationIgnored private let sampleRate: Double = 16000

    // Live recognition
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?

    // Voice activity detection via audio energy
    @ObservationIgnored private var isSpeechActive = false
    @ObservationIgnored private var silenceTimer: Timer?
    @ObservationIgnored private let silenceTimeout: TimeInterval = 2.0
    @ObservationIgnored private let speechThreshold: Float = 200.0
    @ObservationIgnored private var partialTranscript = ""

    // Audio format (matches pendant: 16-bit PCM mono @ 16 kHz)
    @ObservationIgnored private lazy var audioFormat: AVAudioFormat = {
        AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!
    }()

    var onTranscript: ((String) -> Void)?

    init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)

        observer = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didReceiveData,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let data = notification.object as? Data else { return }
            Task { @MainActor in
                self?.handleIncomingAudio(data)
            }
        }

        // Stop recognition when pendant disconnects
        connectionObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didDisconnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.stopRecognition()
            }
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        if let connectionObserver {
            NotificationCenter.default.removeObserver(connectionObserver)
        }
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        let energy = computeEnergy(data)

        if energy > speechThreshold {
            if !isSpeechActive {
                isSpeechActive = true
                startRecognition()
            }
            resetSilenceTimer()
        } else if isSpeechActive {
            // Below threshold — might be a pause; silence timer handles it
        }

        // Feed audio to recognizer if active
        if isSpeechActive, let request = recognitionRequest {
            let frameCount = UInt32(data.count / MemoryLayout<Int16>.size)
            guard frameCount > 0,
                  let pcmBuf = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameCount) else {
                return
            }
            pcmBuf.frameLength = frameCount
            data.withUnsafeBytes { raw in
                if let src = raw.baseAddress {
                    memcpy(pcmBuf.int16ChannelData![0], src, data.count)
                }
            }
            request.append(pcmBuf)
        }
    }

    private func computeEnergy(_ data: Data) -> Float {
        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return 0 }

        return data.withUnsafeBytes { raw -> Float in
            guard let ptr = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return 0 }
            var sum: Float = 0
            for i in 0..<sampleCount {
                let sample = Float(ptr[i])
                sum += sample * sample
            }
            return sqrt(sum / Float(sampleCount)) // RMS
        }
    }

    // MARK: - Silence detection

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: silenceTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.onSilenceDetected()
            }
        }
    }

    private func onSilenceDetected() {
        guard isSpeechActive else { return }
        isSpeechActive = false
        finishRecognition()
    }

    // MARK: - Speech recognition

    private func startRecognition() {
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition not available"
            return
        }

        // Check/request authorization
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            Task {
                let status = await requestSpeechAuthorization()
                if status == .authorized {
                    startRecognition()
                } else {
                    errorMessage = "Speech recognition not authorized"
                }
            }
            return
        }

        // Cancel any existing session
        recognitionTask?.cancel()
        recognitionRequest = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        state = .listening
        errorMessage = nil
        partialTranscript = ""

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.partialTranscript = result.bestTranscription.formattedString
                    self.lastTranscript = self.partialTranscript

                    if result.isFinal {
                        self.deliverTranscript(self.partialTranscript)
                    }
                }
                if error != nil && self.partialTranscript.isEmpty {
                    // Recognition error with no transcript — reset
                    self.state = .idle
                }
            }
        }
    }

    private func finishRecognition() {
        state = .transcribing
        silenceTimer?.invalidate()
        silenceTimer = nil

        recognitionRequest?.endAudio()

        // If we already have a partial transcript, deliver it after a short delay
        // to allow the recognizer to finalize
        let transcript = partialTranscript
        if !transcript.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                if self.state == .transcribing {
                    self.deliverTranscript(self.lastTranscript ?? transcript)
                }
            }
        }
    }

    private func deliverTranscript(_ transcript: String) {
        guard !transcript.isEmpty else {
            state = .idle
            return
        }
        print("[PendantBridge] Transcript: \(transcript)")
        lastTranscript = transcript
        state = .idle
        onTranscript?(transcript)

        // Clean up for next utterance
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        partialTranscript = ""
    }

    private func stopRecognition() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        isSpeechActive = false
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        partialTranscript = ""
        state = .idle
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}
