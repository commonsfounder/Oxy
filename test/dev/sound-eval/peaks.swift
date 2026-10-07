// Scores every Apple sound label on every ESC-50 clip, so any sound can be checked without rerunning the model.
// For each clip and label it records the best score in one window ("peak1") and the best score held for two
// windows in a row ("peak2"), which is what a 2-hit rule needs.
//
//   swiftc -O test/dev/sound-eval/peaks.swift -o /tmp/sound-peaks
//   /tmp/sound-peaks <ESC-50 folder> <out.json>
import Foundation
import SoundAnalysis

final class Collector: NSObject, SNResultsObserving {
    var windows: [[String: Double]] = []
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        windows.append(Dictionary(uniqueKeysWithValues: result.classifications.map { ($0.identifier, $0.confidence) }))
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let rows = try String(contentsOf: root.appendingPathComponent("meta/esc50.csv"), encoding: .utf8)
    .split(separator: "\n").dropFirst().map { $0.split(separator: ",").map(String.init) }
struct Clip: Codable { let file: String; let category: String; let peak1: [String: Double]; let peak2: [String: Double] }
var clips: [Clip] = []
for row in rows {
    autoreleasepool {
        guard let analyzer = try? SNAudioFileAnalyzer(url: root.appendingPathComponent("audio/\(row[0])")),
              let request = try? SNClassifySoundRequest(classifierIdentifier: .version1) else { return }
        request.overlapFactor = 0.5
        let collector = Collector()
        guard (try? analyzer.add(request, withObserver: collector)) != nil else { return }
        analyzer.analyze()
        var peak1: [String: Double] = [:], peak2: [String: Double] = [:]
        for (index, window) in collector.windows.enumerated() {
            for (label, score) in window {
                peak1[label] = max(peak1[label] ?? 0, score)
                if index + 1 < collector.windows.count, let next = collector.windows[index + 1][label] {
                    peak2[label] = max(peak2[label] ?? 0, min(score, next))
                }
            }
        }
        clips.append(Clip(file: row[0], category: row[3], peak1: peak1, peak2: peak2))
    }
}
try JSONEncoder().encode(clips).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("scored \(clips.count) clips")
