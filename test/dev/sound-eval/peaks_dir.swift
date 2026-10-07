// Scores every Apple label on every wav in some folders. Same output as peaks.swift but for any folder, in shards
// so several can run at once.
//
//   swiftc -O peaks_dir.swift -o /tmp/sound-peaks-dir
//   /tmp/sound-peaks-dir <out.json> <shard> <shards> <folder> [folder...]
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

let arguments = CommandLine.arguments
let shard = Int(arguments[2])!, shards = Int(arguments[3])!
var files: [URL] = []
for folder in arguments.dropFirst(4) {
    let url = URL(fileURLWithPath: folder)
    files += try FileManager.default.contentsOfDirectory(atPath: folder).filter { $0.hasSuffix(".wav") }.sorted().map { url.appendingPathComponent($0) }
}
struct Clip: Codable { let file: String; let peak1: [String: Double]; let peak2: [String: Double] }
var clips: [Clip] = []
for (index, url) in files.enumerated() where index % shards == shard {
    autoreleasepool {
        guard let analyzer = try? SNAudioFileAnalyzer(url: url),
              let request = try? SNClassifySoundRequest(classifierIdentifier: .version1) else { return }
        request.overlapFactor = 0.5
        let collector = Collector()
        guard (try? analyzer.add(request, withObserver: collector)) != nil else { return }
        analyzer.analyze()
        var peak1: [String: Double] = [:], peak2: [String: Double] = [:]
        for (i, window) in collector.windows.enumerated() {
            for (label, score) in window {
                peak1[label] = max(peak1[label] ?? 0, score)
                if i + 1 < collector.windows.count, let next = collector.windows[i + 1][label] { peak2[label] = max(peak2[label] ?? 0, min(score, next)) }
            }
        }
        clips.append(Clip(file: url.deletingPathExtension().lastPathComponent, peak1: peak1, peak2: peak2))
    }
}
try JSONEncoder().encode(clips).write(to: URL(fileURLWithPath: arguments[1]))
print("shard \(shard): \(clips.count) clips")
