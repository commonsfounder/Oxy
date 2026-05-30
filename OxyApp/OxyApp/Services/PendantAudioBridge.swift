import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// The pendant streams PCM audio continuously once connected. This bridge
/// feeds ALL incoming audio into Apple's live speech recognizer (which has
/// its own built-in VAD), and delivers the final transcript to the chat.
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
    @ObservationIgnored private var connectObserver: NSObjectProtocol?
    @ObservationIgnored private let sampleRate: Double = 16000

    // Live recognition
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var isSessionActive = false

    // Restart timer — Apple limits recognition to ~60s per session,
    // so we restart periodically when no speech is detected.
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

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

        // Start recognition when pendant connects
        connectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.startRecognitionSession()
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
        if let observer { NotificationCenter.default.removeObserver(observer) }
        if let connectionObserver { NotificationCenter.default.removeObserver(connectionObserver) }
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver) }
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        // Start a recognition session if we don't have one yet
        if !isSessionActive {
            startRecognitionSession()
        }

        guard let request = recognitionRequest else { return }

        // Convert raw PCM bytes to AVAudioPCMBuffer and feed to recognizer
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

    // MARK: - Speech recognition

    private func startRecognitionSession() {
        guard !isSessionActive else { return }
        guard let recognizer, recognizer.isAvailable else {
            print("[PendantBridge] Speech recognizer not available")
            errorMessage = "Speech recognition not available"
            return
        }

        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            Task {
                let status = await requestSpeechAuthorization()
                if status == .authorized {
                    startRecognitionSession()
                } else {
                    errorMessage = "Speech recognition not authorized"
                }
            }
            return
        }

        // Cancel any previous session
        recognitionTask?.cancel()
        recognitionRequest = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Let Apple's recognizer handle VAD — it will return isFinal
        // when the user stops speaking
        request.requiresOnDeviceRecognition = false
        recognitionRequest = request
        isSessionActive = true

        state = .listening
        errorMessage = nil

        print("[PendantBridge] Starting speech recognition session")

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }

                if let result {
                    let transcript = result.bestTranscription.formattedString
                    self.lastTranscript = transcript

                    if result.isFinal {
                        print("[PendantBridge] Final transcript: \(transcript)")
                        self.deliverTranscript(transcript)
                        // Restart session for next utterance
                        self.isSessionActive = false
                        self.startRecognitionSession()
                    }
                }

                if let error {
                    print("[PendantBridge] Recognition error: \(error.localizedDescription)")
                    // Session ended — restart for next utterance
                    self.isSessionActive = false
                    if self.state != .idle {
                        self.state = .listening
                        self.startRecognitionSession()
                    }
                }
            }
        }

        // Apple limits recognition sessions to ~60s. Restart before that.
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: sessionTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.restartSession()
            }
        }
    }

    private func restartSession() {
        print("[PendantBridge] Restarting recognition session (timeout)")
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        isSessionActive = false
        startRecognitionSession()
    }

    private func deliverTranscript(_ transcript: String) {
        guard !transcript.isEmpty else { return }
        print("[PendantBridge] Delivering transcript: \(transcript)")
        lastTranscript = transcript
        state = .transcribing
        onTranscript?(transcript)

        // Brief transcribing state, then back to listening
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            if self?.state == .transcribing {
                self?.state = .listening
            }
        }
    }

    private func stopRecognition() {
        print("[PendantBridge] Stopping recognition")
        restartTimer?.invalidate()
        restartTimer = nil
        isSessionActive = false
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
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
