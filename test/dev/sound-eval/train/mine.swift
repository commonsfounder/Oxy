// Runs our model over a folder of clips that contain none of our target sounds and prints the ones it wrongly
// fires on: file, the label, and its best score. Each clip is tried clean and under noise (mine.py builds both).
//
//   swiftc -O mine.swift -o /tmp/sound-mine
//   /tmp/sound-mine <Model.mlmodelc> <folder of wavs> > mistakes.tsv
import CoreML
import Foundation
import SoundAnalysis

final class Collector: NSObject, SNResultsObserving {
    var best: [String: Double] = [:]
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        for item in result.classifications { best[item.identifier] = max(best[item.identifier] ?? 0, item.confidence) }
    }
    func request(_ request: SNRequest, didFailWithError error: Error) {}
    func requestDidComplete(_ request: SNRequest) {}
}

let model = try MLModel(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let folder = URL(fileURLWithPath: CommandLine.arguments[2])
let targets = ["glass_breaking", "knock", "doorbell", "baby_crying"]
for file in try FileManager.default.contentsOfDirectory(atPath: folder.path).filter({ $0.hasSuffix(".wav") }).sorted() {
    autoreleasepool {
        guard let analyzer = try? SNAudioFileAnalyzer(url: folder.appendingPathComponent(file)),
              let request = try? SNClassifySoundRequest(mlModel: model) else { return }
        request.overlapFactor = 0.5
        let collector = Collector()
        guard (try? analyzer.add(request, withObserver: collector)) != nil else { return }
        analyzer.analyze()
        if let worst = targets.map({ ($0, collector.best[$0] ?? 0) }).max(by: { $0.1 < $1.1 }) {
            print("\(file)\t\(worst.0)\t\(String(format: "%.3f", worst.1))")
        }
    }
}
