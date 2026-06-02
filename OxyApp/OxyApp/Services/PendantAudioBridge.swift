import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// Audio flow: pendant PDM (16 kHz Int16) → BLE chunks → VAD → SFSpeechRecognizer.
/// A recognition session is only opened once the VAD confirms speech onset, so
/// SFSpeechRecognizer never sits idle receiving silence and firing "No speech detected".
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

    // Pre-speech ring buffer: keeps ~512 ms of raw Int16 audio so utterance
    // onset words aren't clipped when we open the session after VAD confirmation.
    @ObservationIgnored private var preSpeechBuffer = Data()
    @ObservationIgnored private let preSpeechBufferCapacity = 4096 * 2 * 2 // ~512 ms of Int16

    // Session restart guard (Apple caps recognition sessions at ~60 s)
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

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
    @ObservationIgnored private let speechRMSThreshold: Float = 0.008
    @ObservationIgnored private let silenceOffsetBatches = 8
    @ObservationIgnored private let speechOnsetBatches = 2

    @ObservationIgnored private var consecutiveSpeechBatches = 0
    @ObservationIgnored private var consecutiveSilenceBatches = 0
    @ObservationIgnored private var hasSpeechInSession = false
    @ObservationIgnored private var utteranceEnded = false

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

        fullReset()
        state = .listening
        print("[PendantBridge] Ready — waiting for speech onset")
    }

    // MARK: - Audio handling

    private func handleIncomingAudio(_ data: Data) {
        pendingPCMData.append(data)
        let sampleCount = pendingPCMData.count / MemoryLayout<Int16>.size
        if sampleCount >= minSamplesPerBatch {
            flushAudioBuffer()
        }
    }

    private func flushAudioBuffer() {
        let data = pendingPCMData
        pendingPCMData = Data()

        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return }

        // Convert Int16 → Float32 and compute RMS for VAD
        guard let pcmBuf = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: UInt32(sampleCount)) else { return }
        pcmBuf.frameLength = UInt32(sampleCount)

        var sumSquares: Float = 0
        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            guard let dst = pcmBuf.floatChannelData?[0] else { return }
            for i in 0..<sampleCount {
                let normalized = Float(src[i]) / 32768.0
                sumSquares += normalized * normalized
                dst[i] = max(-1.0, min(1.0, normalized * micGain))
            }
        }

        let rms = sqrt(sumSquares / Float(sampleCount))

        diagnosticCounter += 1
        if diagnosticCounter % 20 == 0 {
            print("[PendantBridge] rms=\(String(format: "%.4f", rms)) speech=\(consecutiveSpeechBatches) silence=\(consecutiveSilenceBatches) active=\(isSessionActive)")
        }

        // Roll pre-speech buffer (keep last ~512 ms of raw bytes)
        if !isSessionActive {
            preSpeechBuffer.append(data)
            if preSpeechBuffer.count > preSpeechBufferCapacity {
                preSpeechBuffer = preSpeechBuffer.suffix(preSpeechBufferCapacity)
            }
        }

        let wasInSpeech = hasSpeechInSession
        updateVAD(rms: rms)

        // Speech onset: open recognition session and replay the pre-speech buffer
        // so the first syllables aren't clipped.
        if hasSpeechInSession && !wasInSpeech {
            openRecognitionSession(replayBuffer: preSpeechBuffer)
            preSpeechBuffer = Data()
        }

        // Feed current batch to the active session
        if isSessionActive, let request = recognitionRequest, !utteranceEnded {
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

    private func openRecognitionSession(replayBuffer: Data) {
        guard !isSessionActive else { return }
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition not available"
            return
        }

        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            Task {
                let status = await requestSpeechAuthorization()
                if status == .authorized {
                    openRecognitionSession(replayBuffer: replayBuffer)
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
        if #available(iOS 17, *) {
            request.requiresOnDeviceRecognition = false
        }
        recognitionRequest = request
        isSessionActive = true
        errorMessage = nil

        print("[PendantBridge] Recognition session opened")

        // Replay pre-speech buffer so onset words aren't clipped
        if !replayBuffer.isEmpty {
            let replaySamples = replayBuffer.count / MemoryLayout<Int16>.size
            if let replayBuf = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: UInt32(replaySamples)) {
                replayBuf.frameLength = UInt32(replaySamples)
                replayBuffer.withUnsafeBytes { raw in
                    guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                    guard let dst = replayBuf.floatChannelData?[0] else { return }
                    for i in 0..<replaySamples {
                        let normalized = Float(src[i]) / 32768.0
                        dst[i] = max(-1.0, min(1.0, normalized * micGain))
                    }
                }
                request.append(replayBuf)
            }
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }

                if let result {
                    let transcript = result.bestTranscription.formattedString
                    self.lastTranscript = transcript

                    if result.isFinal {
                        print("[PendantBridge] Final: \(transcript)")
                        self.isSessionActive = false
                        self.recognitionRequest = nil
                        self.recognitionTask = nil
                        self.restartTimer?.invalidate()
                        self.restartTimer = nil
                        self.resetVAD()
                        self.preSpeechBuffer = Data()
                        if !transcript.trimmingCharacters(in: .whitespaces).isEmpty {
                            self.deliverTranscript(transcript)
                        }
                        // Ready for next utterance — session opens on next speech onset
                        if self.state != .idle { self.state = .listening }
                    }
                }

                if let error {
                    print("[PendantBridge] Recognition error: \(error.localizedDescription)")
                    self.isSessionActive = false
                    self.recognitionRequest = nil
                    self.recognitionTask = nil
                    self.restartTimer?.invalidate()
                    self.restartTimer = nil
                    self.resetVAD()
                    self.preSpeechBuffer = Data()
                    if self.state != .idle { self.state = .listening }
                    // No proactive restart — next speech onset opens a fresh session
                }
            }
        }

        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: sessionTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.handleSessionTimeout() }
        }
    }

    private func handleSessionTimeout() {
        print("[PendantBridge] Session timeout — closing, will reopen on next speech onset")
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        isSessionActive = false
        pendingPCMData = Data()
        preSpeechBuffer = Data()
        resetVAD()
    }

    private func deliverTranscript(_ transcript: String) {
        print("[PendantBridge] Delivering: \(transcript)")
        lastTranscript = transcript
        state = .transcribing
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
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        fullReset()
        state = .idle
    }

    private func fullReset() {
        isSessionActive = false
        pendingPCMData = Data()
        preSpeechBuffer = Data()
        resetVAD()
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}
