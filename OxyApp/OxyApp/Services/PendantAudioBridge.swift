import AVFoundation
import Foundation
import Observation
import Speech

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// Audio flow: pendant PDM (16 kHz Int16) → BLE chunks → onset VAD →
/// SFSpeechRecognizer → onTranscript callback → sendMessage().
///
/// Silence detection uses a debounce timer rather than batch counting so
/// endAudio() is guaranteed to fire regardless of background noise level.
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
    @ObservationIgnored private let preSpeechBufferCapacity = 4096 * 2 * 2

    // Session hard-cap guard (Apple caps recognition sessions at ~60 s)
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

    @ObservationIgnored private let micGain: Float = 3.0

    // ── VAD ───────────────────────────────────────────────────────────────────
    // Onset: RMS must exceed threshold for N consecutive batches before opening
    // a recognition session (avoids phantom triggers from transient noise).
    @ObservationIgnored private let speechRMSThreshold: Float = 0.04
    @ObservationIgnored private let speechOnsetBatches = 3

    @ObservationIgnored private var consecutiveSpeechBatches = 0
    @ObservationIgnored private var hasSpeechInSession = false
    @ObservationIgnored private var utteranceEnded = false

    // Silence offset: a debounce timer fires endAudio() 1.5 s after the last
    // speech batch. This is decoupled from the noise floor entirely — no
    // threshold-based silence counting that can get stuck.
    @ObservationIgnored private var silenceEndTimer: DispatchWorkItem?
    @ObservationIgnored private let silenceDebounce: TimeInterval = 1.5

    @ObservationIgnored private var diagnosticCounter = 0

    var onTranscript: ((String) -> Void)?

    init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)

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
        if let connectionObserver { NotificationCenter.default.removeObserver(connectionObserver) }
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver) }
    }

    // MARK: - Pendant lifecycle

    private func onPendantConnected() {
        fullReset()
        state = .listening
        print("[PendantBridge] Ready — waiting for speech onset")
    }

    // MARK: - Audio handling

    func ingest(_ data: Data) {
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
            print("[PendantBridge] rms=\(String(format: "%.4f", rms)) speech=\(consecutiveSpeechBatches) active=\(isSessionActive)")
        }

        if !isSessionActive {
            preSpeechBuffer.append(data)
            if preSpeechBuffer.count > preSpeechBufferCapacity {
                preSpeechBuffer = preSpeechBuffer.suffix(preSpeechBufferCapacity)
            }
        }

        let wasInSpeech = hasSpeechInSession
        updateVAD(rms: rms)

        if hasSpeechInSession && !wasInSpeech {
            openRecognitionSession(replayBuffer: preSpeechBuffer)
            preSpeechBuffer = Data()
        }

        if isSessionActive, let request = recognitionRequest, !utteranceEnded {
            request.append(pcmBuf)
            // Each speech batch resets the silence debounce
            if hasSpeechInSession {
                rescheduleSilenceEnd()
            }
        }
    }

    // MARK: - VAD

    private func updateVAD(rms: Float) {
        let isSpeech = rms > speechRMSThreshold

        if isSpeech {
            consecutiveSpeechBatches += 1
            if consecutiveSpeechBatches >= speechOnsetBatches && !hasSpeechInSession {
                hasSpeechInSession = true
                utteranceEnded = false
                print("[PendantBridge] Speech onset (rms=\(String(format: "%.4f", rms)))")
            }
        } else {
            consecutiveSpeechBatches = 0
        }
    }

    // Debounce: endAudio() fires 1.5 s after the last speech batch, regardless
    // of whether the noise floor is above or below any threshold.
    private func rescheduleSilenceEnd() {
        silenceEndTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.isSessionActive, !self.utteranceEnded else { return }
                self.utteranceEnded = true
                print("[PendantBridge] Speech offset (silence timeout) — signalling end of audio")
                self.recognitionRequest?.endAudio()
            }
        }
        silenceEndTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + silenceDebounce, execute: item)
    }

    private func resetVAD() {
        consecutiveSpeechBatches = 0
        hasSpeechInSession = false
        utteranceEnded = false
        silenceEndTimer?.cancel()
        silenceEndTimer = nil
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

        // Schedule the initial silence timeout from session open
        rescheduleSilenceEnd()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }

                if let result {
                    let transcript = result.bestTranscription.formattedString
                    self.lastTranscript = transcript

                    if result.isFinal {
                        print("[PendantBridge] Final: \(transcript)")
                        self.teardownSession()
                        if !transcript.trimmingCharacters(in: .whitespaces).isEmpty {
                            self.deliverTranscript(transcript)
                        }
                        if self.state != .idle { self.state = .listening }
                    }
                }

                if let error {
                    print("[PendantBridge] Recognition error: \(error.localizedDescription)")
                    self.teardownSession()
                    if self.state != .idle { self.state = .listening }
                }
            }
        }

        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: sessionTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.handleSessionTimeout() }
        }
    }

    private func teardownSession() {
        isSessionActive = false
        recognitionRequest = nil
        recognitionTask = nil
        restartTimer?.invalidate()
        restartTimer = nil
        resetVAD()
        preSpeechBuffer = Data()
    }

    private func handleSessionTimeout() {
        print("[PendantBridge] Session timeout — closing")
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        pendingPCMData = Data()
        teardownSession()
    }

    private func deliverTranscript(_ transcript: String) {
        print("[PendantBridge] Sending via chat: \(transcript)")
        lastTranscript = transcript
        state = .transcribing
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
