import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// Audio flow: pendant PDM (16 kHz Int16) → BLE chunks → accumulated buffer →
/// Float32 conversion → SFSpeechRecognizer. Energy-based VAD signals end-of-
/// utterance so the recognizer commits a final result promptly rather than
/// waiting for its own timeout.
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

    // Speech recognition
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var isSessionActive = false

    // BLE chunk accumulation — pendant sends 20-byte chunks; we batch to ~256 ms
    @ObservationIgnored private var pendingPCMData = Data()
    @ObservationIgnored private let minSamplesPerBatch: Int = 4096  // ~256 ms @ 16 kHz

    // Session restart guard (Apple caps recognition sessions at ~60 s)
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

    // Error back-off
    @ObservationIgnored private var errorRestartDelay: TimeInterval = 3.0

    // Float32 format for SFSpeechRecognizer
    @ObservationIgnored private lazy var floatFormat: AVAudioFormat = {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!
    }()

    // Moderate gain — PDM gain-40 firmware output is quiet; 3× avoids clipping
    @ObservationIgnored private let micGain: Float = 3.0

    // ── VAD state machine ──────────────────────────────────────────────────────
    // RMS threshold below which audio is considered silence (normalized 0–1 scale)
    @ObservationIgnored private let speechRMSThreshold: Float = 0.008

    // How many consecutive silent batches end an utterance (~2 s at 256 ms/batch)
    @ObservationIgnored private let silenceOffsetBatches = 8

    // How many consecutive speech batches confirm onset (avoids false triggers)
    @ObservationIgnored private let speechOnsetBatches = 2

    @ObservationIgnored private var consecutiveSpeechBatches = 0
    @ObservationIgnored private var consecutiveSilenceBatches = 0
    @ObservationIgnored private var hasSpeechInSession = false
    @ObservationIgnored private var utteranceEnded = false

    // Diagnostic counter for periodic logging
    @ObservationIgnored private var diagnosticCounter = 0

    var onTranscript: ((String) -> Void)?

    init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)

        observer = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didReceiveData,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let data = notification.object as? Data else { return }
            Task { @MainActor in self?.handleIncomingAudio(data) }
        }

        connectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.onPendantConnected() }
        }

        connectionObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didDisconnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.stopRecognition() }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        if let connectionObserver { NotificationCenter.default.removeObserver(connectionObserver) }
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver) }
    }

    // MARK: - Pendant lifecycle

    private func onPendantConnected() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("[PendantBridge] Audio session warning: \(error.localizedDescription)")
        }

        resetVAD()
        pendingPCMData = Data()
        // Don't start a recognition session here — the pendant only streams
        // audio while its button is held. Starting eagerly causes an immediate
        // "No speech detected" error loop. handleIncomingAudio starts the
        // session lazily when the first audio chunk actually arrives.
        state = .listening
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        if !isSessionActive { startRecognitionSession() }
        pendingPCMData.append(data)
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

        guard let pcmBuf = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: UInt32(sampleCount)) else { return }
        pcmBuf.frameLength = UInt32(sampleCount)

        var sumSquares: Float = 0
        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            guard let dst = pcmBuf.floatChannelData?[0] else { return }
            for i in 0..<sampleCount {
                let normalized = Float(src[i]) / 32768.0
                sumSquares += normalized * normalized
                // Apply gain then clamp to prevent distortion
                dst[i] = max(-1.0, min(1.0, normalized * micGain))
            }
        }

        let rms = sqrt(sumSquares / Float(sampleCount))
        updateVAD(rms: rms)

        diagnosticCounter += 1
        if diagnosticCounter % 20 == 0 {
            print("[PendantBridge] rms=\(String(format: "%.4f", rms)) speech=\(consecutiveSpeechBatches) silence=\(consecutiveSilenceBatches)")
        }

        // Stop feeding audio after utterance ends — let recognizer finalize
        if !utteranceEnded {
            request.append(pcmBuf)
        }
    }

    // MARK: - VAD

    private func updateVAD(rms: Float) {
        let isSpeech = rms > speechRMSThreshold

        if isSpeech {
            consecutiveSilenceBatches = 0
            consecutiveSpeechBatches += 1

            if consecutiveSpeechBatches >= speechOnsetBatches && !hasSpeechInSession {
                hasSpeechInSession = true
                utteranceEnded = false
                print("[PendantBridge] Speech onset (rms=\(String(format: "%.4f", rms)))")
            }
        } else {
            consecutiveSpeechBatches = 0
            if hasSpeechInSession && !utteranceEnded {
                consecutiveSilenceBatches += 1
                if consecutiveSilenceBatches >= silenceOffsetBatches {
                    utteranceEnded = true
                    consecutiveSilenceBatches = 0
                    print("[PendantBridge] Speech offset — signalling end of audio")
                    recognitionRequest?.endAudio()
                }
            }
        }
    }

    private func resetVAD() {
        consecutiveSpeechBatches = 0
        consecutiveSilenceBatches = 0
        hasSpeechInSession = false
        utteranceEnded = false
    }

    // MARK: - Speech recognition

    private func startRecognitionSession() {
        guard !isSessionActive else { return }
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition not available"
            return
        }

        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            Task {
                let status = await requestSpeechAuthorization()
                if status == .authorized { startRecognitionSession() }
                else { errorMessage = "Speech recognition not authorized" }
            }
            return
        }

        recognitionTask?.cancel()
        recognitionRequest = nil
        pendingPCMData = Data()
        resetVAD()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Let on-device recognition run when available for lower latency
        if #available(iOS 17, *) {
            request.requiresOnDeviceRecognition = false
        }
        recognitionRequest = request
        isSessionActive = true
        state = .listening
        errorMessage = nil

        print("[PendantBridge] Recognition session started")

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }

                if let result {
                    let transcript = result.bestTranscription.formattedString
                    self.lastTranscript = transcript

                    if result.isFinal {
                        print("[PendantBridge] Final: \(transcript)")
                        self.isSessionActive = false
                        if !transcript.trimmingCharacters(in: .whitespaces).isEmpty {
                            self.deliverTranscript(transcript)
                        }
                        // Start fresh session for next utterance
                        self.startRecognitionSession()
                    }
                }

                if let error {
                    print("[PendantBridge] Recognition error: \(error.localizedDescription)")
                    self.isSessionActive = false
                    self.recognitionRequest = nil
                    self.recognitionTask = nil
                    self.pendingPCMData = Data()
                    self.resetVAD()
                    // Don't proactively restart — let handleIncomingAudio start
                    // a fresh session when the user next presses the button.
                    if self.state != .idle {
                        self.state = .listening
                    }
                }
            }
        }

        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: sessionTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.restartSession() }
        }
    }

    private func restartSession() {
        print("[PendantBridge] Session timeout — resetting, will restart on next audio")
        flushAudioBuffer()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        isSessionActive = false
        pendingPCMData = Data()
        resetVAD()
        // Session will be lazily restarted by handleIncomingAudio
    }

    private func deliverTranscript(_ transcript: String) {
        print("[PendantBridge] Delivering: \(transcript)")
        lastTranscript = transcript
        state = .transcribing

        // Notify pendant that AI is now processing
        NativeIntegrationManager.shared.pendant.sendCommand("THINK")

        onTranscript?(transcript)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            if self?.state == .transcribing { self?.state = .listening }
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
        resetVAD()
        state = .idle
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}
