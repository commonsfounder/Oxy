// Scores Apple's built-in model and one or more of ours on every condition folder stress.py built, using the
// settings the app uses (threshold and windows-in-a-row per sound).
//
//   swiftc -O test/dev/sound-eval/train/stress.swift -o /tmp/sound-stress
//   /tmp/sound-stress <stress folder> name=/path/Model.mlmodelc [name2=/path/Other.mlmodelc ...]
import AVFoundation
import CoreML
import Foundation
import SoundAnalysis

// Keep in step with HouseholdSoundEventFilter in OxyApp/Services/HouseholdSoundMonitor.swift.
let sounds = ["glass_breaking", "knock", "doorbell", "baby_crying"]
let apple: [String: (label: String, threshold: Double, hits: Int)] = [
    "glass_breaking": ("glass_breaking", 0.7, 1), "knock": ("knock", 0.8, 1),
    "doorbell": ("door_bell", 0.7, 2), "baby_crying": ("baby_crying", 0.72, 2)
]
// OURS_DELTA=-0.2 lowers every threshold of ours by 0.2, to compare models at the same false-alarm level.
let delta = Double(ProcessInfo.processInfo.environment["OURS_DELTA"] ?? "") ?? 0
let ours: [String: (label: String, threshold: Double, hits: Int)] = [
    "glass_breaking": ("glass_breaking", 0.9, 1), "knock": ("knock", 0.9, 1),
    "doorbell": ("doorbell", 0.8, 1), "baby_crying": ("baby_crying", 0.9, 2)
]

final class Collector: NSObject, SNResultsObserving {
    var windows: [[String: Double]] = []
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        windows.append(Dictionary(uniqueKeysWithValues: result.classifications.map { ($0.identifier.lowercased(), $0.confidence) }))
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

func fires(_ windows: [[String: Double]], _ rule: (label: String, threshold: Double, hits: Int)) -> Bool {
    var run = 0
    for window in windows {
        run = (window[rule.label] ?? 0) >= rule.threshold ? run + 1 : 0
        if run >= rule.hits { return true }
    }
    return false
}

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let models = try CommandLine.arguments.dropFirst(2).map { argument -> (String, MLModel) in
    let parts = argument.split(separator: "=", maxSplits: 1).map(String.init)
    return (parts[0], try MLModel(contentsOf: URL(fileURLWithPath: parts[1])))
}
let names = ["Apple"] + models.map(\.0)

func analyse(_ url: URL) -> [[[String: Double]]]? {
    guard let analyzer = try? SNAudioFileAnalyzer(url: url) else { return nil }
    var collectors: [Collector] = []
    var requests: [SNClassifySoundRequest] = []
    if let request = try? SNClassifySoundRequest(classifierIdentifier: .version1) { requests.append(request) } else { return nil }
    for (_, model) in models {
        guard let request = try? SNClassifySoundRequest(mlModel: model) else { return nil }
        requests.append(request)
    }
    for request in requests {
        request.overlapFactor = 0.5
        let collector = Collector()
        guard (try? analyzer.add(request, withObserver: collector)) != nil else { return nil }
        collectors.append(collector)
    }
    analyzer.analyze()
    return collectors.map(\.windows)
}

let conditions = try FileManager.default.contentsOfDirectory(atPath: root.path).filter { !$0.hasPrefix(".") }.sorted()
for condition in conditions {
    var clips: [(truth: String, windows: [[[String: Double]]])] = []
    let folder = root.appendingPathComponent(condition)
    for label in try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted() where !label.hasPrefix(".") {
        for file in try FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(label).path) where file.hasSuffix(".wav") {
            autoreleasepool {
                if let windows = analyse(folder.appendingPathComponent(label).appendingPathComponent(file)) { clips.append((label, windows)) }
            }
        }
    }
    print("\n\(condition) (\(clips.count) clips)")
    print("  " + "sound".padding(toLength: 16, withPad: " ", startingAt: 0) + names.map { $0.padding(toLength: 26, withPad: " ", startingAt: 0) }.joined())
    for sound in sounds {
        let positives = clips.filter { $0.truth == sound }, negatives = clips.filter { $0.truth != sound }
        guard !positives.isEmpty else { continue }
        var cells: [String] = []
        for index in names.indices {
            let rule = index == 0 ? apple[sound]! : (ours[sound]!.label, ours[sound]!.threshold + delta, ours[sound]!.hits)
            let caught = positives.filter { fires($0.windows[index], rule) }.count
            let false_ = negatives.filter { fires($0.windows[index], rule) }.count
            cells.append("\(caught)/\(positives.count) caught, \(false_) false".padding(toLength: 26, withPad: " ", startingAt: 0))
        }
        print("  " + sound.padding(toLength: 16, withPad: " ", startingAt: 0) + cells.joined())
    }
}
