// Runs Apple's model and ours over the long recordings stream.py built, the way the app does: one continuous
// stream, the app's thresholds and windows-in-a-row rule, fires merged within 30 s. A sound counts as found if
// the right fire lands from 1 s before it starts to 3 s after it ends. Any other fire is a false alarm.
//
//   swiftc -O test/dev/sound-eval/train/stream.swift -o /tmp/sound-stream
//   /tmp/sound-stream <stream folder> name=/path/Model.mlmodelc [...]
import AVFoundation
import CoreML
import Foundation
import SoundAnalysis

let sounds = ["glass_breaking", "knock", "doorbell", "baby_crying"]
let apple: [String: (label: String, threshold: Double, hits: Int)] = [
    "glass_breaking": ("glass_breaking", 0.7, 1), "knock": ("knock", 0.8, 1),
    "doorbell": ("door_bell", 0.7, 2), "baby_crying": ("baby_crying", 0.72, 2)
]
let ours: [String: (label: String, threshold: Double, hits: Int)] = [
    "glass_breaking": ("glass_breaking", 0.9, 1), "knock": ("knock", 0.9, 1),
    "doorbell": ("doorbell", 0.8, 1), "baby_crying": ("baby_crying", 0.9, 2)
]

final class Collector: NSObject, SNResultsObserving {
    var windows: [(end: Double, scores: [String: Double])] = []
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        windows.append((result.timeRange.start.seconds + result.timeRange.duration.seconds,
                        Dictionary(uniqueKeysWithValues: result.classifications.map { ($0.identifier.lowercased(), $0.confidence) })))
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

func fireTimes(_ windows: [(end: Double, scores: [String: Double])], _ rule: (label: String, threshold: Double, hits: Int)) -> [Double] {
    var times: [Double] = [], run = 0
    for window in windows {
        run = (window.scores[rule.label] ?? 0) >= rule.threshold ? run + 1 : 0
        if run >= rule.hits, times.last.map({ window.end - $0 > 30 }) ?? true { times.append(window.end) }
    }
    return times
}

struct Truth: Decodable { let sound: String; let start: Double; let end: Double }
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let models = try CommandLine.arguments.dropFirst(2).map { argument -> (String, MLModel) in
    let parts = argument.split(separator: "=", maxSplits: 1).map(String.init)
    return (parts[0], try MLModel(contentsOf: URL(fileURLWithPath: parts[1])))
}
let names = ["Apple"] + models.map(\.0)
var found = [[String: Int]](repeating: [:], count: names.count), total: [String: Int] = [:]
var falseFires = [[String: Int]](repeating: [:], count: names.count)
var delays = [[String: [Double]]](repeating: [:], count: names.count)
var hours = 0.0

for file in try FileManager.default.contentsOfDirectory(atPath: root.path).filter({ $0.hasSuffix(".wav") }).sorted() {
    let url = root.appendingPathComponent(file)
    let truth = try JSONDecoder().decode([Truth].self, from: Data(contentsOf: root.appendingPathComponent(file.replacingOccurrences(of: ".wav", with: ".json"))))
    let analyzer = try SNAudioFileAnalyzer(url: url)
    var collectors: [Collector] = []
    var requests = [try SNClassifySoundRequest(classifierIdentifier: .version1)]
    for (_, model) in models { requests.append(try SNClassifySoundRequest(mlModel: model)) }
    for request in requests {
        request.overlapFactor = 0.5
        let collector = Collector()
        try analyzer.add(request, withObserver: collector)
        collectors.append(collector)
    }
    analyzer.analyze()
    hours += (collectors[0].windows.last?.end ?? 0) / 3600
    for event in truth { total[event.sound, default: 0] += 1 }
    for index in names.indices {
        for sound in sounds {
            let rule = index == 0 ? apple[sound]! : ours[sound]!
            let fires = fireTimes(collectors[index].windows, rule)
            let events = truth.filter { $0.sound == sound }
            for event in events {
                if let hit = fires.first(where: { $0 >= event.start - 1 && $0 <= event.end + 3 }) {
                    found[index][sound, default: 0] += 1
                    delays[index][sound, default: []].append(max(0, hit - event.start))
                }
            }
            falseFires[index][sound, default: 0] += fires.filter { fire in !events.contains { fire >= $0.start - 1 && fire <= $0.end + 3 } }.count
        }
    }
}

print(String(format: "%.1f hours of audio\n", hours))
print("sound".padding(toLength: 16, withPad: " ", startingAt: 0) + names.map { $0.padding(toLength: 40, withPad: " ", startingAt: 0) }.joined())
for sound in sounds {
    var cells: [String] = []
    for index in names.indices {
        let sorted = (delays[index][sound] ?? []).sorted()
        let delay = sorted.isEmpty ? "-" : String(format: "%.1fs", sorted[sorted.count / 2])
        cells.append("found \(found[index][sound] ?? 0)/\(total[sound] ?? 0), \(String(format: "%.1f", Double(falseFires[index][sound] ?? 0) / hours)) false/h, delay \(delay)".padding(toLength: 40, withPad: " ", startingAt: 0))
    }
    print(sound.padding(toLength: 16, withPad: " ", startingAt: 0) + cells.joined())
}
