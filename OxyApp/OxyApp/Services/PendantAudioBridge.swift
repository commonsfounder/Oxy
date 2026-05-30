import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// The pendant streams PCM audio continuously once connected. This bridge
/// accumulates small BLE chunks into larger buffers, converts to Float32,
/// and feeds them into Apple's live speech recognizer for transcription.
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

    // Chunk accumulation — BLE sends 20-byte chunks (10 Int16 samples).
    // We accumulate into larger buffers so the recognizer has enough
    // audio context to detect speech.
    @ObservationIgnored private var pendingPCMData = Data()
    @ObservationIgnored private let minSamplesPerBatch: Int = 4096  // ~256ms at 16kHz

    // Restart timer — Apple limits recognition to ~60s per session
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

    // Debounce restart after errors
    @ObservationIgnored private var errorRestartDelay: TimeInterval = 3.0

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
    @ObservationIgnored private let micGain: Float = 8.0

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
        // Use playAndRecord so voice replies still work while we process pendant audio.
        // We're NOT recording from the device mic — we're feeding external BLE audio
        // into SFSpeechRecognizer directly.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            print("[PendantBridge] Audio session configured (playAndRecord)")
        } catch {
            print("[PendantBridge] Audio session warning: \(error.localizedDescription)")
        }

        pendingPCMData = Data()
        startRecognitionSession()
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        if !isSessionActive {
            startRecognitionSession()
        }

        // Accumulate small BLE chunks
        pendingPCMData.append(data)

        // Flush when we have enough samples for meaningful speech detection
        let sampleCount = pendingPCMData.count / MemoryLayout<Int16>.size
        if sampleCount >= minSamplesPerBatch {
            flushAudioBuffer()
        }
    }

    private func flushAudioBuffer() {
        guard let request = recognitionRequest else { return }
        let data = pendingPCMData
        pendingPCMData = Data()

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
        pendingPCMData = Data()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
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
                    print("[PendantBridge] Partial: \(transcript)")

                    if result.isFinal {
                        print("[PendantBridge] Final transcript: \(transcript)")
                        self.deliverTranscript(transcript)
                        self.isSessionActive = false
                        self.startRecognitionSession()
                    }
                }

                if let error {
                    let desc = error.localizedDescription
                    print("[PendantBridge] Recognition error: \(desc)")
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
        // Flush any remaining audio before ending
        flushAudioBuffer()
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
        flushAudioBuffer()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        pendingPCMData = Data()
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
