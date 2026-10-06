@preconcurrency import AVFoundation
import Foundation
@preconcurrency import SoundAnalysis
import UIKit

struct HouseholdSoundEventEnvelope: Equatable {
    let id: String
    let subject: String
    let title: String
    let body: String
    let confidence: Double
    let relevance: Double
    let urgent: Bool
    let requiresNow: Bool
    let occurredAt: Date

    var dictionary: [String: Any] {
        [
            "id": id,
            "type": "sound_detected",
            "subject": subject,
            "title": title,
            "body": body,
            "occurredAt": occurredAt.ISO8601Format(),
            "source": "ios_sound_analysis",
            "confidence": confidence,
            "relevance": relevance,
            "actionable": true,
            "urgent": urgent,
            "requiresNow": requiresNow,
            "interruptionCost": urgent ? "low" : "normal"
        ]
    }
}

struct HouseholdSoundEventFilter {
    private struct Rule {
        let aliases: [String]
        let threshold: Double
        let subject: String
        let title: String
        let body: String
        let relevance: Double
        let urgent: Bool
        let requiresNow: Bool
    }

    private struct Evidence {
        var count: Int
        var lastSeenAt: Date
    }

    private static let rules: [Rule] = [
        Rule(
            aliases: ["smoke_detector"],
            threshold: 0.65,
            subject: "Smoke detector",
            title: "Smoke detector heard",
            body: "A smoke detector may be sounding nearby.",
            relevance: 1,
            urgent: true,
            requiresNow: true
        ),
        Rule(
            aliases: ["glass_breaking", "breaking_glass", "glass_shatter"],
            threshold: 0.7,
            subject: "Breaking glass",
            title: "Breaking glass heard",
            body: "Glass may have broken nearby.",
            relevance: 1,
            urgent: true,
            requiresNow: true
        ),
        Rule(
            aliases: ["door_bell"],
            threshold: 0.7,
            subject: "Doorbell",
            title: "Doorbell heard",
            body: "Someone may be at the door.",
            relevance: 0.9,
            urgent: false,
            requiresNow: true
        ),
        Rule(
            aliases: ["knock"],
            threshold: 0.65,
            subject: "Knocking",
            title: "Knocking heard",
            body: "Someone may be at the door.",
            relevance: 0.85,
            urgent: false,
            requiresNow: true
        ),
        Rule(
            aliases: ["baby_crying", "baby_cry", "infant_cry"],
            threshold: 0.72,
            subject: "Baby crying",
            title: "Baby crying heard",
            body: "A baby may need attention.",
            relevance: 0.9,
            urgent: false,
            requiresNow: true
        )
    ]

    private var evidence: [String: Evidence] = [:]
    private var lastEmittedAt: [String: Date] = [:]
    private let requiredHits = 2
    private let evidenceWindow: TimeInterval = 6
    private let cooldown: TimeInterval = 15 * 60

    mutating func event(
        for classifications: [SNClassification],
        at now: Date = Date()
    ) -> HouseholdSoundEventEnvelope? {
        let candidates = Self.rules.compactMap { rule -> (Rule, Double, String)? in
            let match = classifications
                .filter { classification in
                    let identifier = Self.normalized(classification.identifier)
                    return rule.aliases.contains(identifier)
                }
                .max(by: { $0.confidence < $1.confidence })
            guard let match, match.confidence >= rule.threshold else { return nil }
            return (rule, match.confidence, rule.aliases[0])
        }
        guard let (rule, confidence, key) = candidates.max(by: { $0.1 < $1.1 }) else {
            evidence.removeAll()
            return nil
        }

        let previous = evidence[key]
        let count = previous.map { now.timeIntervalSince($0.lastSeenAt) <= evidenceWindow ? $0.count + 1 : 1 } ?? 1
        evidence = [key: Evidence(count: count, lastSeenAt: now)]
        guard count >= requiredHits else { return nil }
        guard lastEmittedAt[key].map({ now.timeIntervalSince($0) >= cooldown }) ?? true else { return nil }

        lastEmittedAt[key] = now
        evidence.removeAll()
        let bucket = Int(now.timeIntervalSince1970 / cooldown)
        return HouseholdSoundEventEnvelope(
            id: "sound:\(key):\(bucket)",
            subject: rule.subject,
            title: rule.title,
            body: rule.body,
            confidence: confidence,
            relevance: rule.relevance,
            urgent: rule.urgent,
            requiresNow: rule.requiresNow,
            occurredAt: now
        )
    }

    mutating func resetEvidence() {
        evidence.removeAll()
    }

    private static func normalized(_ value: String) -> String {
        value.lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }
}

private final class HouseholdSoundResultsObserver: NSObject, SNResultsObserving {
    let onResult: (SNClassificationResult) -> Void
    let onFailure: (Error) -> Void

    init(onResult: @escaping (SNClassificationResult) -> Void, onFailure: @escaping (Error) -> Void) {
        self.onResult = onResult
        self.onFailure = onFailure
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        onResult(result)
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        onFailure(error)
    }

    func requestDidComplete(_ request: SNRequest) {}
}

private final class HouseholdSoundAnalysisPipeline: @unchecked Sendable {
    private let analyzer: SNAudioStreamAnalyzer
    private let lock = NSLock()

    init(analyzer: SNAudioStreamAnalyzer) {
        self.analyzer = analyzer
    }

    func analyze(_ buffer: AVAudioPCMBuffer, at position: AVAudioFramePosition) {
        lock.lock()
        defer { lock.unlock() }
        analyzer.analyze(buffer, atAudioFramePosition: position)
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        analyzer.removeAllRequests()
    }
}

@MainActor
final class HouseholdSoundMonitor {
    static let shared = HouseholdSoundMonitor()
    static let preferenceKey = "adam_household_sound_awareness"

    private var audioEngine: AVAudioEngine?
    private var analysisPipeline: HouseholdSoundAnalysisPipeline?
    private var resultsObserver: HouseholdSoundResultsObserver?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var filter = HouseholdSoundEventFilter()
    private var activeUserId: String?
    private var pausedForVoiceInput = false
    private var isStarting = false
    #if DEBUG
    private var lastClassificationLogAt = Date.distantPast
    #endif

    private init() {
        lifecycleObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in await HouseholdSoundMonitor.shared.startIfNeeded() }
        })
        lifecycleObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in HouseholdSoundMonitor.shared.stop() }
        })
    }

    func configure(userId: String) async {
        activeUserId = userId.isEmpty ? nil : userId
        if isEnabled {
            await startIfNeeded()
        } else {
            stop()
        }
    }

    func setEnabled(_ enabled: Bool, userId: String) async {
        UserDefaults.standard.set(enabled, forKey: Self.preferenceKey)
        activeUserId = userId.isEmpty ? nil : userId
        if enabled {
            await startIfNeeded()
        } else {
            stop()
        }
    }

    func suspendForVoiceInput() {
        pausedForVoiceInput = true
        stop()
    }

    func resumeAfterVoiceInput() {
        pausedForVoiceInput = false
        Task { await startIfNeeded() }
    }

    func stopAndForgetUser() {
        activeUserId = nil
        pausedForVoiceInput = false
        stop()
    }

    private var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.preferenceKey)
    }

    private func startIfNeeded() async {
        guard isEnabled,
              !pausedForVoiceInput,
              !isStarting,
              audioEngine == nil,
              activeUserId != nil,
              UIApplication.shared.applicationState == .active else { return }

        isStarting = true
        defer { isStarting = false }
        let permission = await microphonePermission()
        guard permission == .granted else {
            if permission == .denied {
                UserDefaults.standard.set(false, forKey: Self.preferenceKey)
            }
            return
        }
        guard isEnabled, !pausedForVoiceInput else { return }

        do {
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { return }

            let streamAnalyzer = SNAudioStreamAnalyzer(format: format)
            let pipeline = HouseholdSoundAnalysisPipeline(analyzer: streamAnalyzer)
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            request.overlapFactor = 0.5
            let observer = HouseholdSoundResultsObserver(
                onResult: { result in
                    Task { @MainActor in
                        HouseholdSoundMonitor.shared.consume(result)
                    }
                },
                onFailure: { error in
                    #if DEBUG
                    print("[HouseholdSound] analysis failed: \(error.localizedDescription)")
                    #endif
                    Task { @MainActor in HouseholdSoundMonitor.shared.stop() }
                }
            )
            try streamAnalyzer.add(request, withObserver: observer)

            input.installTap(onBus: 0, bufferSize: 8_192, format: format) { [pipeline] buffer, time in
                pipeline.analyze(buffer, at: time.sampleTime)
            }

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.mixWithOthers])
            try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            engine.prepare()
            try engine.start()

            audioEngine = engine
            analysisPipeline = pipeline
            resultsObserver = observer
            #if DEBUG
            let supported = request.knownClassifications.filter { classification in
                let normalized = classification.lowercased().replacingOccurrences(of: "-", with: "_")
                return ["alarm", "glass", "door", "knock", "baby", "infant"].contains { normalized.contains($0) }
            }
            print("[HouseholdSound] monitoring; relevant built-in labels=\(supported)")
            #endif
        } catch {
            stop()
            #if DEBUG
            print("[HouseholdSound] start failed: \(error.localizedDescription)")
            #endif
        }
    }

    private func stop() {
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        audioEngine = nil
        analysisPipeline?.stop()
        analysisPipeline = nil
        resultsObserver = nil
        filter.resetEvidence()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func consume(_ result: SNClassificationResult) {
        #if DEBUG
        let now = Date()
        if now.timeIntervalSince(lastClassificationLogAt) >= 1 {
            lastClassificationLogAt = now
            let top = result.classifications.prefix(3).map {
                "\($0.identifier)=\(String(format: "%.3f", $0.confidence))"
            }
            print("[HouseholdSound] observed \(top.joined(separator: ", "))")
        }
        #endif
        guard let userId = activeUserId,
              isEnabled,
              !pausedForVoiceInput,
              let event = filter.event(for: result.classifications) else { return }
        Task {
            #if DEBUG
            print("[HouseholdSound] detected id=\(event.id) confidence=\(String(format: "%.3f", event.confidence))")
            #endif
            let accepted = await NativeIntegrationManager.shared.syncNativeContext(
                userId: userId,
                events: [event.dictionary]
            )
            #if DEBUG
            print("[HouseholdSound] submitted id=\(event.id) accepted=\(accepted)")
            #endif
        }
    }

    private func microphonePermission() async -> AVAudioApplication.recordPermission {
        let permission = AVAudioApplication.shared.recordPermission
        guard permission == .undetermined else { return permission }
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted ? .granted : .denied)
            }
        }
    }
}
