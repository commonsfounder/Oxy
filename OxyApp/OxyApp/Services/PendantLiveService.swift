import AVFoundation
import Foundation
import Observation
import UIKit

extension Notification.Name {
    static let pendantNativeAction = Notification.Name("oxy.pendantNativeAction")
}

/// Streams raw BLE audio from the pendant directly to the Gemini Live
/// `/realtime-voice` WebSocket for end-to-end STT + reasoning + TTS.
///
/// This replaces the SFSpeechRecognizer path entirely: audio never goes
/// through Apple's on-device recogniser. Gemini Live handles transcription,
/// conversation, tool execution, and TTS in a single low-latency pipeline.
@Observable
@MainActor
final class PendantLiveService {

    enum LiveState {
        case idle
        case connecting
        case listening    // session active, audio streaming
        case processing   // Gemini turn in progress
    }

    private(set) var liveState: LiveState = .idle
    private(set) var userTranscript: String?
    private(set) var assistantTranscript: String?
    private(set) var errorMessage: String?

    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var isSessionOpen = false
    @ObservationIgnored private var pendingChunks: [Data] = []   // buffered before session opens
    @ObservationIgnored private let audioPlayer = PendantAudioOutputPlayer()

    @ObservationIgnored private var bleDataObserver: NSObjectProtocol?
    @ObservationIgnored private var connectObserver: NSObjectProtocol?
    @ObservationIgnored private var disconnectObserver: NSObjectProtocol?

    init() {
        bleDataObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didReceiveData,
            object: nil,
            queue: .main
        ) { [weak self] n in
            guard let data = n.object as? Data else { return }
            Task { @MainActor in self?.forwardAudioChunk(data) }
        }

        connectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.openSession() }
        }

        disconnectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didDisconnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.closeSession() }
        }
    }

    deinit {
        [bleDataObserver, connectObserver, disconnectObserver]
            .compactMap { $0 }
            .forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Session lifecycle

    private func openSession() {
        guard liveState == .idle else { return }
        liveState = .connecting

        let base = APIClient.shared.baseURL
        let wsBase = base
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")

        guard let url = URL(string: "\(wsBase)/realtime-voice") else {
            errorMessage = "Invalid WebSocket URL"
            liveState = .idle
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("[PendantLive] Audio session: \(error.localizedDescription)")
        }

        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()

        // Authenticate immediately
        let token = KeychainHelper.shared.read(key: "session_token") ?? ""
        send(["type": "auth", "token": token])

        Task { await receiveLoop() }
        print("[PendantLive] WebSocket opened, authenticating…")
    }

    private func closeSession() {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        isSessionOpen = false
        pendingChunks = []
        liveState = .idle
        userTranscript = nil
        assistantTranscript = nil
        audioPlayer.stop()
        print("[PendantLive] Session closed")
    }

    // MARK: - Audio forwarding

    private func forwardAudioChunk(_ data: Data) {
        let event: [String: Any] = [
            "type": "audio-chunk",
            "data": data.base64EncodedString(),
            "mimeType": "audio/l16;rate=16000"
        ]

        if isSessionOpen {
            send(event)
        } else if liveState == .connecting {
            // Buffer up to ~1 s of audio while session negotiates
            if pendingChunks.count < 80 { pendingChunks.append(data) }
        }
    }

    private func flushPendingChunks() {
        for chunk in pendingChunks {
            send([
                "type": "audio-chunk",
                "data": chunk.base64EncodedString(),
                "mimeType": "audio/l16;rate=16000"
            ])
        }
        pendingChunks = []
    }

    // MARK: - WebSocket receive loop

    private func receiveLoop() async {
        guard let task = socket else { return }
        while true {
            do {
                let msg = try await task.receive()
                let text: String
                switch msg {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8) ?? ""; break
                @unknown default: continue
                }
                await MainActor.run { handleEvent(text) }
            } catch {
                await MainActor.run {
                    if liveState != .idle {
                        print("[PendantLive] Receive error: \(error.localizedDescription)")
                        closeSession()
                    }
                }
                break
            }
        }
    }

    // MARK: - Server event handling

    private func handleEvent(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {

        case "live-authenticated":
            // Start the Gemini Live session with the user's chosen voice
            let voice = UserDefaults.standard.string(forKey: "oxy_live_voice") ?? "Schedar"
            send(["type": "live-start", "voice": voice])

        case "live-open":
            isSessionOpen = true
            liveState = .listening
            flushPendingChunks()
            print("[PendantLive] Gemini Live session open")

        case "user-transcript":
            let text = json["text"] as? String ?? ""
            userTranscript = text
            if json["final"] as? Bool == true && !text.isEmpty {
                liveState = .processing
                NativeIntegrationManager.shared.pendant.sendCommand("THINK")
                print("[PendantLive] User said: \(text)")
            }

        case "assistant-transcript":
            assistantTranscript = json["text"] as? String

        case "assistant-audio":
            guard let b64 = json["data"] as? String,
                  let audioData = Data(base64Encoded: b64) else { return }
            let mimeType = json["mimeType"] as? String ?? "audio/pcm;rate=24000"
            audioPlayer.enqueue(audioData, mimeType: mimeType)

        case "assistant-actions":
            if let results = json["results"] as? [[String: Any]] {
                handleActionResults(results)
            }

        case "live-turn-complete":
            liveState = .listening
            userTranscript = nil
            assistantTranscript = nil
            NativeIntegrationManager.shared.pendant.sendCommand("DONE")
            print("[PendantLive] Turn complete")

        case "live-interrupted":
            audioPlayer.stop()

        case "live-error":
            let msg = json["error"] as? String ?? "Unknown error"
            errorMessage = msg
            print("[PendantLive] Error: \(msg)")
            // Brief pause then reconnect
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.closeSession()
                self?.openSession()
            }

        case "live-closed":
            closeSession()

        default:
            break
        }
    }

    // MARK: - Native action dispatch

    private func handleActionResults(_ results: [[String: Any]]) {
        for result in results {
            guard let signal = result["nativeSignal"] as? String else { continue }
            NotificationCenter.default.post(
                name: .pendantNativeAction,
                object: nil,
                userInfo: ["signal": signal, "data": result]
            )
        }
    }

    // MARK: - WebSocket send

    private func send(_ dict: [String: Any]) {
        guard let task = socket,
              let body = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: body, encoding: .utf8) else { return }
        task.send(.string(text)) { error in
            if let error {
                print("[PendantLive] Send error: \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - PCM audio output player

/// Plays back raw 16-bit PCM audio chunks from Gemini Live (typically 24 kHz mono).
final class PendantAudioOutputPlayer {

    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var pcmFormat: AVAudioFormat?
    private var configuredSampleRate: Double = 0

    func enqueue(_ data: Data, mimeType: String) {
        let sampleRate = parseSampleRate(mimeType)
        ensureEngine(sampleRate: sampleRate)

        guard let format = pcmFormat else { return }

        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: UInt32(sampleCount)) else { return }
        buf.frameLength = UInt32(sampleCount)

        data.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self),
                  let dst = buf.floatChannelData?[0] else { return }
            for i in 0..<sampleCount {
                dst[i] = Float(src[i]) / 32768.0
            }
        }

        playerNode?.scheduleBuffer(buf, completionHandler: nil)
    }

    func stop() {
        playerNode?.stop()
        engine?.stop()
        engine = nil
        playerNode = nil
        pcmFormat = nil
        configuredSampleRate = 0
    }

    private func ensureEngine(sampleRate: Double) {
        if engine != nil && configuredSampleRate == sampleRate { return }
        stop()

        let eng = AVAudioEngine()
        let node = AVAudioPlayerNode()
        guard let fmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else { return }

        eng.attach(node)
        eng.connect(node, to: eng.mainMixerNode, format: fmt)

        do {
            try eng.start()
            node.play()
            engine = eng
            playerNode = node
            pcmFormat = fmt
            configuredSampleRate = sampleRate
        } catch {
            print("[PendantAudioPlayer] Engine start failed: \(error.localizedDescription)")
        }
    }

    private func parseSampleRate(_ mimeType: String) -> Double {
        if let match = mimeType.range(of: #"rate=(\d+)"#, options: .regularExpression) {
            let s = String(mimeType[match]).replacingOccurrences(of: "rate=", with: "")
            return Double(s) ?? 24000
        }
        return 24000
    }
}
