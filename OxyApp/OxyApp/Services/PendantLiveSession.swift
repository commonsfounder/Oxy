import AVFoundation
import Foundation
import Observation

/// Bridges pendant BLE audio directly to the Gemini Live API via the
/// backend's `/companion-live` WebSocket. This eliminates the transcribe →
/// polish → HTTP chain and drops end-to-end latency from ~3-6s to <1s.
///
/// Protocol:
///   Client → Server: auth, session.start, audio.append, audio.end, session.stop
///   Server → Client: session.ready, audio, transcript.user, transcript.assistant,
///                     actions, status, turn.complete, error
@Observable
@MainActor
final class PendantLiveSession {

    enum SessionState: String {
        case disconnected
        case connecting
        case ready
        case listening
        case speaking
    }

    private(set) var state: SessionState = .disconnected
    private(set) var userTranscript: String?
    private(set) var assistantTranscript: String?
    private(set) var errorMessage: String?

    // Callbacks
    var onActionResults: (([ActionResult]) -> Void)?
    var onSpeakingDone: (() -> Void)?

    // WebSocket
    @ObservationIgnored private var webSocket: URLSessionWebSocketTask?
    @ObservationIgnored private var urlSession: URLSession?

    // Audio playback via AVAudioEngine for gapless streaming
    @ObservationIgnored private var audioEngine: AVAudioEngine?
    @ObservationIgnored private var playerNode: AVAudioPlayerNode?
    @ObservationIgnored private let outputSampleRate: Double = 24000
    @ObservationIgnored private lazy var outputFormat: AVAudioFormat = {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: outputSampleRate, channels: 1, interleaved: true)!
    }()

    // BLE lifecycle observers (audio itself arrives via ingest(), routed by ChatView)
    @ObservationIgnored private var connectObserver: NSObjectProtocol?
    @ObservationIgnored private var disconnectObserver: NSObjectProtocol?

    /// True only when the live session can actually accept audio right now.
    /// While connecting/disconnected this is false so the local fallback bridge
    /// keeps handling audio — the user is never left dead if the live handshake
    /// stalls or the backend is unreachable. Live "upgrades" once it's ready.
    var isActive: Bool {
        state == .ready || state == .listening || state == .speaking
    }

    // Pendant sends 16-bit PCM @ 16kHz; batch ~100ms before forwarding
    @ObservationIgnored private var pendingAudioData = Data()
    @ObservationIgnored private let minBytesPerForward = 3200 // 100ms @ 16kHz * 2 bytes

    // Track whether we have active pendant audio
    @ObservationIgnored private var isForwardingAudio = false

    init() {
        connectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didConnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.onPendantConnected() }
        }

        disconnectObserver = NotificationCenter.default.addObserver(
            forName: PendantBLEManager.didDisconnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.disconnect() }
        }
    }

    deinit {
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver) }
        if let disconnectObserver { NotificationCenter.default.removeObserver(disconnectObserver) }
    }

    // MARK: - Connection lifecycle

    private func onPendantConnected() {
        // Run audio session setup on a background thread — AVAudioSession.setActive
        // can block briefly while the system notifies other audio clients, which
        // would stall the main thread and freeze the UI during pendant connect.
        Task.detached(priority: .userInitiated) { [weak self] in
            self?.setupAudioSession()
            await self?.connect()
        }
    }

    func connect() {
        guard state == .disconnected else { return }
        let token = KeychainHelper.shared.read(key: "session_token") ?? ""
        guard !token.isEmpty else {
            errorMessage = "Not authenticated"
            return
        }

        let base = APIClient.shared.baseURL
        let wsURL = base
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")

        guard let url = URL(string: "\(wsURL)/companion-live") else {
            errorMessage = "Invalid server URL"
            return
        }

        state = .connecting
        errorMessage = nil
        print("[LiveSession] Connecting to \(url)")

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        urlSession = URLSession(configuration: config)
        webSocket = urlSession?.webSocketTask(with: url)
        webSocket?.resume()

        // Authenticate
        sendJSON(["type": "auth", "token": token])

        // Start the live session
        let voiceName = UserDefaults.standard.string(forKey: "oxy_voice") ?? "Aoede"
        sendJSON(["type": "session.start", "voice": voiceName])

        receiveLoop()
    }

    func disconnect() {
        print("[LiveSession] Disconnecting")
        sendJSON(["type": "session.stop"])
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        stopAudioEngine()
        state = .disconnected
        isForwardingAudio = false
        pendingAudioData = Data()
        userTranscript = nil
        assistantTranscript = nil
    }

    // MARK: - WebSocket communication

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(str)) { error in
            if let error {
                print("[LiveSession] Send error: \(error.localizedDescription)")
            }
        }
    }

    private func receiveLoop() {
        webSocket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.handleServerEvent(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleServerEvent(text)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveLoop()

                case .failure(let error):
                    print("[LiveSession] Receive error: \(error.localizedDescription)")
                    if self.state != .disconnected {
                        self.state = .disconnected
                        self.errorMessage = "Connection lost"
                        // Auto-reconnect after a brief delay
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                            if NativeIntegrationManager.shared.pendant.isConnected {
                                self?.connect()
                            }
                        }
                    }
                }
            }
        }
    }

    private func handleServerEvent(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "session.ready":
            print("[LiveSession] Session ready")
            state = .ready
            // If pendant is already connected and streaming, move to listening
            if NativeIntegrationManager.shared.pendant.isConnected {
                state = .listening
            }

        case "session.authenticated":
            print("[LiveSession] Authenticated")

        case "transcript.user":
            let transcript = json["text"] as? String ?? ""
            userTranscript = transcript
            if state == .listening || state == .ready {
                state = .listening
            }

        case "transcript.assistant":
            let transcript = json["text"] as? String ?? ""
            assistantTranscript = transcript

        case "audio":
            if state != .speaking {
                state = .speaking
            }
            if let audioData = json["data"] as? String {
                playLiveAudio(audioData, mimeType: json["mimeType"] as? String ?? "audio/pcm;rate=24000")
            }

        case "actions":
            if let resultsData = json["results"],
               let jsonData = try? JSONSerialization.data(withJSONObject: resultsData),
               let results = try? JSONDecoder().decode([ActionResult].self, from: jsonData) {
                onActionResults?(results)
            }

        case "status":
            let status = json["status"] as? String ?? ""
            let label = json["label"] as? String ?? ""
            print("[LiveSession] Status: \(status) — \(label)")
            if status == "speaking_start" {
                state = .speaking
            }

        case "turn.complete":
            print("[LiveSession] Turn complete")
            stopAudioEngine()
            userTranscript = nil
            assistantTranscript = nil
            state = .listening
            onSpeakingDone?()
            NativeIntegrationManager.shared.pendant.sendCommand("DONE")

        case "interrupted":
            print("[LiveSession] Interrupted")
            stopAudioEngine()
            state = .listening

        case "error":
            let error = json["error"] as? String ?? "Unknown error"
            print("[LiveSession] Error: \(error)")
            errorMessage = error

        case "session.closed":
            print("[LiveSession] Session closed by server")
            state = .disconnected

        default:
            break
        }
    }

    // MARK: - Pendant audio forwarding

    /// Routed audio sink. Called by ChatView's audio router while this session
    /// owns the audio path. Buffers until ready, then forwards over the socket.
    func ingest(_ data: Data) {
        guard state == .ready || state == .listening || state == .speaking else { return }

        pendingAudioData.append(data)
        if pendingAudioData.count >= minBytesPerForward {
            flushPendantAudio()
        }
    }

    private func flushPendantAudio() {
        guard !pendingAudioData.isEmpty else { return }
        let chunk = pendingAudioData
        pendingAudioData = Data()

        // Send raw PCM as base64 to the WebSocket
        let base64 = chunk.base64EncodedString()
        sendJSON([
            "type": "audio.append",
            "data": base64,
            "mimeType": "audio/pcm;rate=16000"
        ])

        if !isForwardingAudio {
            isForwardingAudio = true
            print("[LiveSession] Audio forwarding started")
        }
    }

    // MARK: - Audio playback

    private nonisolated func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            print("[LiveSession] Audio session error: \(error.localizedDescription)")
        }
    }

    private func ensureAudioEngine() {
        guard audioEngine == nil else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: outputFormat)
        do {
            try engine.start()
            player.play()
            audioEngine = engine
            playerNode = player
        } catch {
            print("[LiveSession] Engine start error: \(error.localizedDescription)")
        }
    }

    private func playLiveAudio(_ base64: String, mimeType: String) {
        guard let rawData = Data(base64Encoded: base64), !rawData.isEmpty else { return }

        ensureAudioEngine()
        guard let player = playerNode else { return }

        let sampleCount = rawData.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: UInt32(sampleCount)) else { return }
        buffer.frameLength = UInt32(sampleCount)

        rawData.withUnsafeBytes { rawBuf in
            guard let src = rawBuf.baseAddress else { return }
            if let dst = buffer.int16ChannelData?[0] {
                dst.update(from: src.assumingMemoryBound(to: Int16.self), count: sampleCount)
            }
        }

        player.scheduleBuffer(buffer)
    }

    private func stopAudioEngine() {
        playerNode?.stop()
        audioEngine?.stop()
        audioEngine = nil
        playerNode = nil
    }
}
