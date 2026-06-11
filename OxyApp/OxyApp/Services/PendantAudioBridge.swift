import Foundation
import Observation

/// Bridges continuous pendant BLE audio to the chat pipeline.
///
/// Audio flow: pendant PDM (16 kHz Int16) → BLE chunks → onset VAD →
/// WAV encode → /pendant/transcribe (Gemini) → onTranscript → sendMessage().
///
/// Using server-side Gemini transcription instead of SFSpeechRecognizer
/// eliminates the on-device ASR hallucination problem ("No" from distorted
/// or quiet audio) and is far more accurate for real speech.
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

    /// Transient, user-facing note shown in the listening bar (e.g. "Didn't
    /// catch that"). Auto-clears so the bar returns to its normal prompt.
    private(set) var notice: String?

    /// Set this before the first utterance so the bridge can authenticate API calls.
    var userId: String = ""

    @ObservationIgnored private var connectionObserver: NSObjectProtocol?
    @ObservationIgnored private var connectObserver: NSObjectProtocol?

    // BLE chunk accumulation — pendant sends 20-byte chunks; batch to ~256 ms
    @ObservationIgnored private var pendingPCMData = Data()
    @ObservationIgnored private let minSamplesPerBatch: Int = 4096   // ~256 ms @ 16 kHz

    // Pre-speech ring buffer: keeps ~512 ms before onset so first syllables
    // are not clipped when we open the session.
    @ObservationIgnored private var preSpeechBuffer = Data()
    @ObservationIgnored private let preSpeechBufferCapacity = 4096 * 2 * 2

    // Raw Int16 accumulation during an active utterance (for WAV encoding)
    @ObservationIgnored private var rawAudioBuffer = Data()

    // Session hard-cap guard (Gemini has its own limits; cap at ~55 s)
    @ObservationIgnored private var sessionCapTimer: Timer?
    @ObservationIgnored private let sessionTimeout: TimeInterval = 55

    // ── VAD ───────────────────────────────────────────────────────────────────
    // RMS above threshold for N consecutive batches → speech onset.
    @ObservationIgnored private let speechRMSThreshold: Float = 0.04
    @ObservationIgnored private let speechOnsetBatches = 3

    @ObservationIgnored private var consecutiveSpeechBatches = 0
    @ObservationIgnored private var hasSpeechInSession = false
    @ObservationIgnored private var isSessionActive = false
    @ObservationIgnored private var utteranceEnded = false

    // Silence offset: debounce timer fires upload after the last speech batch.
    // 1.1 s is long enough to ride over a natural mid-sentence pause but ~0.4 s
    // snappier than the old 1.5 s, which the user feels on every utterance.
    @ObservationIgnored private var silenceEndTimer: DispatchWorkItem?
    @ObservationIgnored private let silenceDebounce: TimeInterval = 1.1

    @ObservationIgnored private var diagnosticCounter = 0

    var onTranscript: ((String) -> Void)?

    init() {
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
            Task { @MainActor in self?.onPendantDisconnected() }
        }
    }

    deinit {
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver) }
        if let connectionObserver { NotificationCenter.default.removeObserver(connectionObserver) }
    }

    // MARK: - Pendant lifecycle

    private func onPendantConnected() {
        fullReset()
        state = .listening
        print("[PendantBridge] Ready — waiting for speech onset")
    }

    private func onPendantDisconnected() {
        fullReset()
        state = .idle
        print("[PendantBridge] Disconnected")
    }

    // MARK: - Audio ingestion

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

        // Compute RMS for VAD — no gain applied; firmware PDM gain=80 delivers
        // clean levels directly (RMS ~0.16–0.27 for speech, ~0.001 for silence).
        var sumSquares: Float = 0
        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<sampleCount {
                let s = Float(src[i]) / 32768.0
                sumSquares += s * s
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
        let isSpeech = rms > speechRMSThreshold
        updateVAD(isSpeech: isSpeech, rms: rms)

        if hasSpeechInSession && !wasInSpeech {
            openAudioSession(preSpeech: preSpeechBuffer)
            preSpeechBuffer = Data()
        }

        if isSessionActive && !utteranceEnded {
            rawAudioBuffer.append(data)
            // Only speech batches push the silence deadline forward.
            if isSpeech { rescheduleSilenceEnd() }
        }
    }

    // MARK: - VAD

    private func updateVAD(isSpeech: Bool, rms: Float) {
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

    private func rescheduleSilenceEnd() {
        silenceEndTimer?.cancel()
        let item = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.isSessionActive, !self.utteranceEnded else { return }
                self.utteranceEnded = true
                let bytes = self.rawAudioBuffer.count
                print("[PendantBridge] Silence timeout — uploading \(bytes) bytes")
                await self.finalizeAndTranscribe()
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

    // MARK: - Session management

    private func openAudioSession(preSpeech: Data) {
        guard !isSessionActive else { return }
        isSessionActive = true
        notice = nil
        rawAudioBuffer = preSpeech  // Replay pre-speech so first syllables aren't lost
        print("[PendantBridge] Audio session opened (+\(preSpeech.count)B pre-speech)")

        rescheduleSilenceEnd()

        sessionCapTimer?.invalidate()
        sessionCapTimer = Timer.scheduledTimer(withTimeInterval: sessionTimeout, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isSessionActive, !self.utteranceEnded else { return }
                self.utteranceEnded = true
                print("[PendantBridge] Session cap — uploading")
                await self.finalizeAndTranscribe()
            }
        }
    }

    /// Encode the accumulated audio as WAV, POST to /pendant/transcribe,
    /// and deliver the Gemini transcript to the chat pipeline.
    private func finalizeAndTranscribe() async {
        let audio = rawAudioBuffer
        let uid = userId
        teardownSession()

        guard !audio.isEmpty, !uid.isEmpty else {
            state = .listening
            return
        }

        state = .transcribing

        let wav = buildWAV(from: audio)
        do {
            let data = try await APIClient.shared.multipartRequest(
                path: "/pendant/transcribe",
                fields: ["userId": uid],
                fileField: "audio",
                fileName: "pendant.wav",
                mimeType: "audio/wav",
                fileData: wav
            )
            let response = try JSONDecoder().decode(TranscribeResponse.self, from: data)
            let transcript = response.transcript.trimmingCharacters(in: .whitespacesAndNewlines)

            print("[PendantBridge] Final: \(transcript.isEmpty ? "(empty)" : transcript)")

            if !transcript.isEmpty {
                lastTranscript = transcript
                deliverTranscript(transcript)
            } else {
                print("[PendantBridge] Empty transcript — skipping")
                showNotice("Didn't catch that — try again")
                state = .listening
            }
        } catch {
            print("[PendantBridge] Transcription error: \(error.localizedDescription)")
            errorMessage = "Transcription failed"
            showNotice("Couldn't reach Oxy — check connection")
            state = .listening
        }
    }

    /// Show a brief note in the listening bar, then clear it.
    private func showNotice(_ text: String) {
        notice = text
        let token = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            if self?.notice == token { self?.notice = nil }
        }
    }

    private func teardownSession() {
        isSessionActive = false
        rawAudioBuffer = Data()
        preSpeechBuffer = Data()
        sessionCapTimer?.invalidate()
        sessionCapTimer = nil
        resetVAD()
    }

    private func deliverTranscript(_ transcript: String) {
        print("[PendantBridge] Sending via chat: \(transcript)")
        state = .transcribing
        onTranscript?(transcript)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            if self?.state == .transcribing { self?.state = .listening }
        }
    }

    private func fullReset() {
        isSessionActive = false
        pendingPCMData = Data()
        rawAudioBuffer = Data()
        preSpeechBuffer = Data()
        sessionCapTimer?.invalidate()
        sessionCapTimer = nil
        resetVAD()
    }

    // MARK: - WAV encoding

    /// Wraps raw 16-bit little-endian PCM (16 kHz, mono) in a standard WAV container.
    private func buildWAV(from int16Data: Data) -> Data {
        let sampleRate: UInt32 = 16000
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(int16Data.count)

        var hdr = Data(capacity: 44)
        hdr.append(contentsOf: "RIFF".utf8)
        hdr.appendLE(UInt32(36 + dataSize))
        hdr.append(contentsOf: "WAVE".utf8)
        hdr.append(contentsOf: "fmt ".utf8)
        hdr.appendLE(UInt32(16))
        hdr.appendLE(UInt16(1))           // PCM
        hdr.appendLE(numChannels)
        hdr.appendLE(sampleRate)
        hdr.appendLE(byteRate)
        hdr.appendLE(blockAlign)
        hdr.appendLE(bitsPerSample)
        hdr.append(contentsOf: "data".utf8)
        hdr.appendLE(dataSize)

        return hdr + int16Data
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.littleEndian) { self.append(contentsOf: $0) }
    }
}

private struct TranscribeResponse: Codable {
    let transcript: String
}
