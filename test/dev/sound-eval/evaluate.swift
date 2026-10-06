// Scores Apple's built-in sound classifier the way Adam uses it: same labels, same thresholds,
// same per-sound "hits in a row" rule as HouseholdSoundEventFilter. Run it over a labelled dataset.
//
//   swiftc -O evaluate.swift -o /tmp/sound-eval
//   /tmp/sound-eval /path/to/ESC-50-master /tmp/sound-eval.json
//
// ESC-50 has no doorbell or smoke detector clips, so those two rows report "no test clips".
import AVFoundation
import Foundation
import SoundAnalysis

struct Rule { let key: String; let aliases: [String]; let threshold: Double; let hits: Int }

// Keep in step with HouseholdSoundEventFilter.rules in OxyApp/Services/HouseholdSoundMonitor.swift.
let rules: [Rule] = [
    Rule(key: "smoke_detector", aliases: ["smoke_detector"], threshold: 0.65, hits: 2),
    Rule(key: "glass_breaking", aliases: ["glass_breaking", "breaking_glass", "glass_shatter"], threshold: 0.7, hits: 1),
    Rule(key: "door_bell", aliases: ["door_bell"], threshold: 0.7, hits: 2),
    Rule(key: "knock", aliases: ["knock"], threshold: 0.8, hits: 1),
    Rule(key: "baby_crying", aliases: ["baby_crying", "baby_cry", "infant_cry"], threshold: 0.72, hits: 2)
]
let evidenceWindow = 6.0

// Which ESC-50 category is a true example of each rule.
let positiveCategory: [String: String] = [
    "baby_crying": "crying_baby",
    "glass_breaking": "glass_breaking",
    "knock": "door_wood_knock"
]

func normalized(_ value: String) -> String {
    value.lowercased().replacingOccurrences(of: "-", with: "_").replacingOccurrences(of: " ", with: "_")
}

final class Collector: NSObject, SNResultsObserving {
    var windows: [(time: Double, confidence: [String: Double])] = []
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        var scores: [String: Double] = [:]
        for classification in result.classifications { scores[normalized(classification.identifier)] = classification.confidence }
        windows.append((result.timeRange.start.seconds, scores))
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

/// The app's filter, replayed over one clip. With `forceOneHit` every sound fires on its first window, to show what the hit rule costs.
func firedKeys(_ windows: [(time: Double, confidence: [String: Double])], forceOneHit: Bool) -> Set<String> {
    var fired = Set<String>()
    var currentKey: String?
    var count = 0
    var lastSeen = -Double.infinity
    for window in windows {
        var best: (rule: Rule, confidence: Double)?
        for rule in rules {
            guard let match = rule.aliases.compactMap({ window.confidence[$0] }).max(), match >= rule.threshold else { continue }
            if best == nil || match > best!.confidence { best = (rule, match) }
        }
        guard let best else { currentKey = nil; count = 0; continue }
        let continues = currentKey == best.rule.key && window.time - lastSeen <= evidenceWindow
        count = continues ? count + 1 : 1
        currentKey = best.rule.key
        lastSeen = window.time
        if count >= (forceOneHit ? 1 : best.rule.hits) { fired.insert(best.rule.key) }
    }
    return fired
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    print("usage: sound-eval <ESC-50 folder> <output.json>")
    exit(2)
}
let root = URL(fileURLWithPath: arguments[1])
let csv = try String(contentsOf: root.appendingPathComponent("meta/esc50.csv"), encoding: .utf8)
let rows = csv.split(separator: "\n").dropFirst().map { $0.split(separator: ",").map(String.init) }

let probe = try SNClassifySoundRequest(classifierIdentifier: .version1)
let known = Set(probe.knownClassifications.map(normalized))
print("Built-in labels the app waits for:")
for rule in rules {
    let present = rule.aliases.filter { known.contains($0) }
    print("  \(rule.key): \(present.isEmpty ? "NONE of \(rule.aliases) exist in Apple's list" : present.joined(separator: ", "))")
}

struct Clip: Codable { let file: String; let category: String; let fired: [String]; let firedSingle: [String]; let peak: [String: Double] }
var clips: [Clip] = []
let started = Date()

for (index, row) in rows.enumerated() {
    let file = row[0], category = row[3]
    autoreleasepool {
        do {
            let analyzer = try SNAudioFileAnalyzer(url: root.appendingPathComponent("audio/\(file)"))
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            request.overlapFactor = 0.5
            let collector = Collector()
            try analyzer.add(request, withObserver: collector)
            analyzer.analyze()
            var peak: [String: Double] = [:]
            for rule in rules {
                peak[rule.key] = collector.windows.compactMap { w in rule.aliases.compactMap { w.confidence[$0] }.max() }.max() ?? 0
            }
            clips.append(Clip(
                file: file, category: category,
                fired: firedKeys(collector.windows, forceOneHit: false).sorted(),
                firedSingle: firedKeys(collector.windows, forceOneHit: true).sorted(),
                peak: peak
            ))
        } catch {
            print("skipped \(file): \(error.localizedDescription)")
        }
    }
    if (index + 1) % 200 == 0 { print("  \(index + 1)/\(rows.count) clips, \(Int(Date().timeIntervalSince(started)))s") }
}

try JSONEncoder().encode(clips).write(to: URL(fileURLWithPath: arguments[2]))

print("\nResult at the app's own settings, \(clips.count) clips")
print("rule             real clips  caught   missed  false alarms (of other clips)")
for rule in rules {
    guard let category = positiveCategory[rule.key] else {
        print("\(rule.key.padding(toLength: 16, withPad: " ", startingAt: 0)) no test clips in ESC-50")
        continue
    }
    let positives = clips.filter { $0.category == category }
    let negatives = clips.filter { $0.category != category }
    let caught = positives.filter { $0.fired.contains(rule.key) }.count
    let falseAlarms = negatives.filter { $0.fired.contains(rule.key) }
    let single = positives.filter { $0.firedSingle.contains(rule.key) }.count
    print("\(rule.key.padding(toLength: 16, withPad: " ", startingAt: 0)) \(String(positives.count).padding(toLength: 11, withPad: " ", startingAt: 0)) \(String(caught).padding(toLength: 7, withPad: " ", startingAt: 0)) \(String(positives.count - caught).padding(toLength: 8, withPad: " ", startingAt: 0)) \(falseAlarms.count) of \(negatives.count)   (if every sound needed only one hit: \(single))")
    let byCategory = Dictionary(grouping: falseAlarms, by: \.category).mapValues(\.count).sorted { $0.value > $1.value }.prefix(4)
    if !byCategory.isEmpty { print("                 false alarms came from: \(byCategory.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))") }
}
// Anything else the app's rules would have fired on (e.g. smoke detector / doorbell on non-test clips).
for key in ["smoke_detector", "door_bell"] {
    let hits = clips.filter { $0.fired.contains(key) }
    if !hits.isEmpty {
        let byCategory = Dictionary(grouping: hits, by: \.category).mapValues(\.count).sorted { $0.value > $1.value }.prefix(5)
        print("\(key): fired on \(hits.count) clips, all of them false alarms here: \(byCategory.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))")
    }
}
