import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// The pendant streams PCM audio continuously once connected. This bridge
/// converts the raw PCM to float32 format, feeds it into Apple's live speech
/// recognizer, and delivers the final transcript for silent execution.
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

    // Restart timer — Apple limits recognition to ~60s per session
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

    // Debounce restart after errors to avoid rapid loops
    @ObservationIgnored private var errorRestartDelay: TimeInterval = 2.0

    // Float32 audio format for SFSpeechRecognizer
    @ObservationIgnored private lazy var floatFormat: AVAudioFormat = {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!
    }()

    // Gain to amplify quiet PDM mic samples
    @ObservationIgnored private let micGain: Float = 4.0

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

        connectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.onPendantConnected()
            }
        }

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

    // MARK: - Pendant lifecycle

    private func onPendantConnected() {
        // Configure audio session so SFSpeechRecognizer works properly
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            print("[PendantBridge] Audio session configured for recording")
        } catch {
            print("[PendantBridge] Failed to configure audio session: \(error)")
        }

        startRecognitionSession()
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        if !isSessionActive {
            startRecognitionSession()
        }

        guard let request = recognitionRequest else { return }

        // Convert Int16 PCM → Float32 with gain amplification
        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return }

        guard let pcmBuf = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: UInt32(sampleCount)) else {
            return
        }
        pcmBuf.frameLength = UInt32(sampleCount)

        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            guard let dst = pcmBuf.floatChannelData?[0] else { return }
            for i in 0..<sampleCount {
                // Convert Int16 [-32768, 32767] to Float32 [-1.0, 1.0] and apply gain
                dst[i] = (Float(src[i]) / 32768.0) * micGain
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

        recognitionTask?.cancel()
        recognitionRequest = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
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
                        // Restart for next utterance
                        self.isSessionActive = false
                        self.startRecognitionSession()
                    }
                }

                if let error {
                    print("[PendantBridge] Recognition error: \(error.localizedDescription)")
                    self.isSessionActive = false
                    // Delay restart to avoid rapid error loops
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.errorRestartDelay) { [weak self] in
                        guard let self, self.state != .idle else { return }
                        self.startRecognitionSession()
                    }
                }
            }
        }

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

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}
