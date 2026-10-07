@preconcurrency import AVFoundation
import CoreML
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

    /// The sound's key, e.g. "knock" or "smoke_alarm".
    var sound: String { id.split(separator: ":").dropFirst().first.map(String.init) ?? subject }

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

    /// An alarm recognised by its beep pattern rather than by the sound model.
    static func alarm(_ pattern: AlarmPatternDetector.Pattern, at now: Date, cooldown: TimeInterval) -> HouseholdSoundEventEnvelope {
        let (subject, title, body, urgent): (String, String, String, Bool) = switch pattern {
        case .smoke: ("Smoke alarm", "Smoke alarm heard", "A smoke alarm is sounding nearby.", true)
        case .carbonMonoxide: ("Carbon monoxide alarm", "Carbon monoxide alarm heard", "A carbon monoxide alarm is sounding nearby.", true)
        case .sustainedBeeping: ("Alarm", "An alarm is going off", "Something has been beeping for over half a minute.", false)
        }
        return HouseholdSoundEventEnvelope(
            id: "sound:\(pattern.rawValue):\(Int(now.timeIntervalSince1970 / cooldown))",
            subject: subject,
            title: title,
            body: body,
            confidence: 0.95,
            relevance: 1,
            urgent: urgent,
            requiresNow: true,
            occurredAt: now
        )
    }
}

struct HouseholdSoundEventFilter {
    struct Rule {
        let aliases: [String]
        let threshold: Double
        /// Windows in a row that must agree. Sustained sounds (a crying baby) take two to rule out a blip;
        /// short ones (breaking glass, a knock) are over in a second, so waiting for two means missing them.
        let hitsRequired: Int
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

    private let rules: [Rule]

    init(rules: [Rule] = HouseholdSoundEventFilter.builtIn) {
        self.rules = rules
    }

    /// Rules for Apple's built-in sound model.
    static let builtIn: [Rule] = [
        // The sound model also calls alarm clocks "smoke detector", so on its own it only says an alarm is
        // sounding. Smoke and carbon monoxide alarms are named from their beep pattern (AlarmPatternDetector).
        Rule(
            aliases: ["smoke_detector"],
            threshold: 0.65,
            hitsRequired: 2,
            subject: "Alarm",
            title: "An alarm is going off",
            body: "An alarm may be sounding nearby.",
            relevance: 0.9,
            urgent: false,
            requiresNow: true
        ),
        Rule(
            aliases: ["glass_breaking", "breaking_glass", "glass_shatter"],
            threshold: 0.7,
            hitsRequired: 1,
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
            hitsRequired: 2,
            subject: "Doorbell",
            title: "Doorbell heard",
            body: "Someone may be at the door.",
            relevance: 0.9,
            urgent: false,
            requiresNow: true
        ),
        Rule(
            aliases: ["knock"],
            threshold: 0.8,
            hitsRequired: 1,
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
            hitsRequired: 2,
            subject: "Baby crying",
            title: "Baby crying heard",
            body: "A baby may need attention.",
            relevance: 0.9,
            urgent: false,
            requiresNow: true
        )
    ]

    /// Rules for our own household model (HouseholdSounds.mlmodel, trained in test/dev/sound-eval/train).
    /// The first alias matches the built-in rule's, so the same sound from both models is one event.
    static let ownModel: [Rule] = builtIn.compactMap { rule in
        guard let tuned = ownModelTuning[rule.aliases[0]] else { return nil }
        return Rule(
            aliases: [rule.aliases[0], tuned.label],
            threshold: tuned.threshold,
            hitsRequired: tuned.hits,
            subject: rule.subject,
            title: rule.title,
            body: rule.body,
            relevance: rule.relevance,
            urgent: rule.urgent,
            requiresNow: rule.requiresNow
        )
    }

    /// Chosen from test/dev/sound-eval/train/compare.swift on clips the model never trained on.
    private static let ownModelTuning: [String: (label: String, threshold: Double, hits: Int)] = [
        "glass_breaking": ("glass_breaking", 0.9, 1),
        "door_bell": ("doorbell", 0.8, 1),
        "knock": ("knock", 0.9, 1),
        "baby_crying": ("baby_crying", 0.9, 2)
    ]

    private var evidence: [String: Evidence] = [:]
    private var lastEmittedAt: [String: Date] = [:]
    private let evidenceWindow: TimeInterval = 6
    private let cooldown: TimeInterval = 15 * 60

    mutating func event(
        for classifications: [SNClassification],
        at now: Date = Date()
    ) -> HouseholdSoundEventEnvelope? {
        let candidates = rules.compactMap { rule -> (Rule, Double, String)? in
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
        guard count >= rule.hitsRequired else { return nil }
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
    private let alarms: AlarmPatternDetector
    private let onAlarm: (AlarmPatternDetector.Pattern) -> Void
    private let lock = NSLock()
    /// The last few seconds, in memory only; written out only if an alert fires and the person keeps clips.
    private var recent: [Float] = []
    private let recentLimit: Int

    init(analyzer: SNAudioStreamAnalyzer, sampleRate: Double, onAlarm: @escaping (AlarmPatternDetector.Pattern) -> Void) {
        self.analyzer = analyzer
        self.alarms = AlarmPatternDetector(sampleRate: sampleRate)
        self.onAlarm = onAlarm
        self.recentLimit = Int(sampleRate * SoundClipStore.seconds)
    }

    func recentSamples() -> [Float] {
        lock.lock()
        defer { lock.unlock() }
        return Array(recent.suffix(recentLimit))
    }

    func analyze(_ buffer: AVAudioPCMBuffer, at position: AVAudioFramePosition) {
        lock.lock()
        defer { lock.unlock() }
        analyzer.analyze(buffer, atAudioFramePosition: position)
        guard let channel = buffer.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        recent.append(contentsOf: samples)
        if recent.count > recentLimit * 2 { recent.removeFirst(recent.count - recentLimit) }
        if let pattern = alarms.process(samples) {
            // Start listening afresh so the same alarm can be reported again once the cooldown passes.
            alarms.reset()
            onAlarm(pattern)
        }
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
    private var sampleRate = 0.0
    private var resultsObserver: HouseholdSoundResultsObserver?
    private var ownResultsObserver: HouseholdSoundResultsObserver?
    private var ownFilter = HouseholdSoundEventFilter(rules: HouseholdSoundEventFilter.ownModel)
    /// Our household model, if this build ships one. It listens alongside Apple's.
    private static let ownModel: MLModel? = Bundle.main.url(forResource: "HouseholdSounds", withExtension: "mlmodelc")
        .flatMap { try? MLModel(contentsOf: $0) }
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var filter = HouseholdSoundEventFilter()
    private var lastAlarmAt: [AlarmPatternDetector.Pattern: Date] = [:]
    /// Both models can hear the same knock; their events share an id, so it is sent once.
    private var submittedIds: [String] = []
    private let alarmCooldown: TimeInterval = 15 * 60
    private var activeUserId: String?
    private var pausedListening = false
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

    /// Stops while the microphone or speaker is needed elsewhere: dictation, or playing a clip back.
    func pauseListening() {
        pausedListening = true
        stop()
    }

    func resumeListening() {
        pausedListening = false
        Task { await startIfNeeded() }
    }

    func stopAndForgetUser() {
        activeUserId = nil
        pausedListening = false
        stop()
        SoundClipStore.shared.deleteAll()
    }

    private var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.preferenceKey)
    }

    private func startIfNeeded() async {
        guard isEnabled,
              !pausedListening,
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
        guard isEnabled, !pausedListening else { return }

        do {
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { return }

            let streamAnalyzer = SNAudioStreamAnalyzer(format: format)
            let pipeline = HouseholdSoundAnalysisPipeline(analyzer: streamAnalyzer, sampleRate: format.sampleRate) { pattern in
                Task { @MainActor in HouseholdSoundMonitor.shared.consume(pattern) }
            }
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
            if let model = Self.ownModel {
                let own = try SNClassifySoundRequest(mlModel: model)
                own.overlapFactor = 0.5
                let ownObserver = HouseholdSoundResultsObserver(
                    onResult: { result in
                        Task { @MainActor in HouseholdSoundMonitor.shared.consume(result, fromOwnModel: true) }
                    },
                    onFailure: { _ in }
                )
                try streamAnalyzer.add(own, withObserver: ownObserver)
                ownResultsObserver = ownObserver
            }

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
            sampleRate = format.sampleRate
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
        ownResultsObserver = nil
        filter.resetEvidence()
        ownFilter.resetEvidence()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func consume(_ result: SNClassificationResult, fromOwnModel: Bool = false) {
        if fromOwnModel {
            if let event = ownFilter.event(for: result.classifications) { submit(event) }
            return
        }
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
        guard let event = filter.event(for: result.classifications) else { return }
        submit(event)
    }

    private func consume(_ pattern: AlarmPatternDetector.Pattern) {
        let now = Date()
        guard lastAlarmAt[pattern].map({ now.timeIntervalSince($0) >= alarmCooldown }) ?? true else { return }
        lastAlarmAt[pattern] = now
        submit(.alarm(pattern, at: now, cooldown: alarmCooldown))
    }

    private func submit(_ event: HouseholdSoundEventEnvelope) {
        guard let userId = activeUserId, isEnabled, !pausedListening, !submittedIds.contains(event.id) else { return }
        submittedIds = Array((submittedIds + [event.id]).suffix(20))
        if SoundClipStore.shared.isEnabled, let samples = analysisPipeline?.recentSamples() {
            SoundClipStore.shared.save(samples: samples, sampleRate: sampleRate, sound: event.sound, title: event.subject, at: event.occurredAt)
        }
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
