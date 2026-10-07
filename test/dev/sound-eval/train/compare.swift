// Scores our household sound model against Apple's built-in one, both run the way the app runs them
// (half-overlapping windows, a confidence threshold, N windows in a row), on clips neither was trained on.
//
//   xcrun coremlcompiler compile Household.mlmodel /tmp      # gives /tmp/Household.mlmodelc
//   swiftc -O test/dev/sound-eval/train/compare.swift -o /tmp/sound-compare
//   /tmp/sound-compare /tmp/Household.mlmodelc <folder with one subfolder per sound> [ESC-50 folder]
//
// For each sound it prints how many real clips each model caught and how many other clips it fired on,
// over a range of thresholds for our model, so the app's threshold can be picked from the numbers.
import AVFoundation
import CoreML
import Foundation
import SoundAnalysis

let sounds = ["glass_breaking", "knock", "doorbell", "baby_crying"]
// Apple's labels for the same sounds, and the app's current settings for them.
let appleRules: [String: (labels: [String], threshold: Double, hits: Int)] = [
    "glass_breaking": (["glass_breaking"], 0.7, 1),
    "knock": (["knock"], 0.8, 1),
    "doorbell": (["door_bell"], 0.7, 2),
    "baby_crying": (["baby_crying"], 0.72, 2)
]
let escCategory = ["glass_breaking": "glass_breaking", "knock": "door_wood_knock", "baby_crying": "crying_baby"]

typealias Windows = [[String: Double]]

final class Collector: NSObject, SNResultsObserving {
    var windows: Windows = []
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        var scores: [String: Double] = [:]
        for item in result.classifications { scores[item.identifier.lowercased()] = item.confidence }
        windows.append(scores)
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

let model = try MLModel(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))

func analyse(_ url: URL) -> (apple: Windows, ours: Windows)? {
    guard let analyzer = try? SNAudioFileAnalyzer(url: url),
          let apple = try? SNClassifySoundRequest(classifierIdentifier: .version1),
          let ours = try? SNClassifySoundRequest(mlModel: model) else { return nil }
    apple.overlapFactor = 0.5
    ours.overlapFactor = 0.5
    let appleCollector = Collector(), oursCollector = Collector()
    guard (try? analyzer.add(apple, withObserver: appleCollector)) != nil,
          (try? analyzer.add(ours, withObserver: oursCollector)) != nil else { return nil }
    analyzer.analyze()
    return (appleCollector.windows, oursCollector.windows)
}

/// True if `labels` scored at least `threshold` in `hits` windows in a row.
func fires(_ windows: Windows, labels: [String], threshold: Double, hits: Int) -> Bool {
    var run = 0
    for window in windows {
        run = (labels.compactMap { window[$0] }.max() ?? 0) >= threshold ? run + 1 : 0
        if run >= hits { return true }
    }
    return false
}

struct Clip { let truth: String; let apple: Windows; let ours: Windows }

func load(folder: URL) -> [Clip] {
    var clips: [Clip] = []
    let labels = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    for label in labels.sorted() where !label.hasPrefix(".") {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent(label).path)) ?? []
        for file in files where file.hasSuffix(".wav") {
            autoreleasepool {
                if let result = analyse(folder.appendingPathComponent(label).appendingPathComponent(file)) {
                    clips.append(Clip(truth: label, apple: result.apple, ours: result.ours))
                }
            }
        }
        print("  read \(label): \(files.count) clips", to: &standardError)
    }
    return clips
}

func report(_ title: String, _ clips: [Clip], sounds: [String]) {
    print("\n\(title) (\(clips.count) clips)")
    for sound in sounds {
        let positives = clips.filter { $0.truth == sound }, negatives = clips.filter { $0.truth != sound }
        guard !positives.isEmpty else { continue }
        func line(_ name: String, _ windows: (Clip) -> Windows, _ labels: [String], _ threshold: Double, _ hits: Int) -> String {
            let caught = positives.filter { fires(windows($0), labels: labels, threshold: threshold, hits: hits) }.count
            let falseAlarms = negatives.filter { fires(windows($0), labels: labels, threshold: threshold, hits: hits) }
            let sources = Dictionary(grouping: falseAlarms, by: \.truth).mapValues(\.count).sorted { $0.value > $1.value }.prefix(3)
            let percent = Int((Double(caught) / Double(positives.count) * 100).rounded())
            return "  \(name.padding(toLength: 22, withPad: " ", startingAt: 0)) caught \(caught)/\(positives.count) (\(percent)%), false alarms \(falseAlarms.count)/\(negatives.count)"
                + (sources.isEmpty ? "" : "  [\(sources.map { "\($0.key) ×\($0.value)" }.joined(separator: ", "))]")
        }
        print(sound)
        let rule = appleRules[sound]!
        print(line("Apple, app settings", \.apple, rule.labels, rule.threshold, rule.hits))
        for hits in [1, 2] {
            for threshold in [0.5, 0.7, 0.8, 0.9, 0.95] {
                print(line("ours \(threshold), \(hits) hit\(hits == 1 ? "" : "s")", \.ours, [sound], threshold, hits))
            }
        }
    }
}

var standardError = FileHandle.standardError
extension FileHandle: @retroactive TextOutputStream {
    public func write(_ string: String) { write(string.data(using: .utf8)!) }
}

report("Held-out test clips", load(folder: URL(fileURLWithPath: CommandLine.arguments[2])), sounds: sounds)

if CommandLine.arguments.count > 3 {
    // ESC-50: a different collection entirely, recorded by different people. Test only (CC BY-NC).
    let root = URL(fileURLWithPath: CommandLine.arguments[3])
    let rows = try String(contentsOf: root.appendingPathComponent("meta/esc50.csv"), encoding: .utf8)
        .split(separator: "\n").dropFirst().map { $0.split(separator: ",").map(String.init) }
    var clips: [Clip] = []
    for row in rows {
        autoreleasepool {
            guard let result = analyse(root.appendingPathComponent("audio/\(row[0])")) else { return }
            let truth = escCategory.first { $0.value == row[3] }?.key ?? row[3]
            clips.append(Clip(truth: truth, apple: result.apple, ours: result.ours))
        }
    }
    report("ESC-50, never seen in training", clips, sounds: Array(escCategory.keys).sorted())
}
