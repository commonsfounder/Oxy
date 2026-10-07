// Tests AlarmPatternDetector (OxyApp/Services/AlarmPatternDetector.swift) on real alarm recordings,
// synthetic alarms in noise, and every ESC-50 clip as a non-alarm.
//
//   swiftc -O OxyApp/OxyApp/Services/AlarmPatternDetector.swift test/dev/sound-eval/alarm/main.swift -o /tmp/alarm-eval
//   /tmp/alarm-eval <folder of real alarm wavs> <ESC-50 folder>
//
// Real alarms keep sounding for minutes, so each recording is looped to 45 s. ESC-50 clips are also
// looped to 45 s, which turns every sound into a repeating one: a harsh test for false patterns.
import AVFoundation
import Foundation

func load(_ url: URL) -> (samples: [Float], rate: Double)? {
    guard let file = try? AVAudioFile(forReading: url),
          let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
          (try? file.read(into: buffer)) != nil,
          let channel = buffer.floatChannelData?[0] else { return nil }
    return (Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))), file.processingFormat.sampleRate)
}

func looped(_ samples: [Float], rate: Double, seconds: Double) -> [Float] {
    var out: [Float] = []
    let target = Int(rate * seconds)
    while out.count < target { out.append(contentsOf: samples) }
    return Array(out.prefix(target))
}

func detect(_ samples: [Float], rate: Double) -> Set<String> {
    let detector = AlarmPatternDetector(sampleRate: rate)
    var found = Set<String>()
    var index = 0
    let chunk = Int(rate * 0.1)
    while index < samples.count {
        if let pattern = detector.process(Array(samples[index..<min(samples.count, index + chunk)])) { found.insert(pattern.rawValue) }
        index += chunk
    }
    return found
}

/// A tone switched on and off in a pattern of (seconds on, seconds off), repeated, with white noise at a given loudness.
func synthetic(frequency: Double, pattern: [(Double, Double)], seconds: Double, noise: Float, square: Bool = false, rate: Double = 16_000) -> [Float] {
    var out: [Float] = []
    var phase = 0.0
    var generator = SystemRandomNumberGenerator()
    while Double(out.count) < seconds * rate {
        for (on, off) in pattern {
            for _ in 0..<Int(on * rate) {
                let s = sin(phase)
                out.append(Float(square ? (s >= 0 ? 0.5 : -0.5) : 0.5 * s) + Float.random(in: -noise...noise, using: &generator))
                phase += 2 * .pi * frequency / rate
            }
            for _ in 0..<Int(off * rate) { out.append(Float.random(in: -noise...noise, using: &generator)) }
        }
    }
    return out
}

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: alarm-eval <alarm wav folder> <ESC-50 folder>"); exit(2) }

print("Real recordings (looped to 45 s):")
// The CO clip holds one full cycle from its first beep at 0.06 s to the next group's first beep at 2.38 s;
// looping the whole 3.3 s file would cut the pause out.
let expected: [String: (String, ClosedRange<Double>?)] = ["0800": ("smoke_alarm", nil), "0925": ("co_alarm", 0.06...2.38), "1153": ("alarm_beeping", nil)]
for (name, (want, cycle)) in expected.sorted(by: { $0.key < $1.key }) {
    guard let audio = load(URL(fileURLWithPath: args[1]).appendingPathComponent("\(name).wav")) else { print("  \(name): missing"); continue }
    let source = cycle.map { Array(audio.samples[Int($0.lowerBound * audio.rate)..<Int($0.upperBound * audio.rate)]) } ?? audio.samples
    let found = detect(looped(source, rate: audio.rate, seconds: 45), rate: audio.rate)
    print("  \(name): expected \(want), got \(found.sorted())  \(found == [want] ? "OK" : "WRONG")")
}

print("\nSynthetic alarms in noise (45 s):")
let t3: [(Double, Double)] = [(0.5, 0.5), (0.5, 0.5), (0.5, 1.5)]
let t4: [(Double, Double)] = [(0.1, 0.1), (0.1, 0.1), (0.1, 0.1), (0.1, 5.0)]
let cases: [(String, [Float], String)] = [
    ("smoke 3.1 kHz, quiet room", synthetic(frequency: 3_100, pattern: t3, seconds: 45, noise: 0.02), "smoke_alarm"),
    ("smoke 3.1 kHz, noisy room", synthetic(frequency: 3_100, pattern: t3, seconds: 45, noise: 0.25), "smoke_alarm"),
    ("smoke 3.1 kHz, very noisy", synthetic(frequency: 3_100, pattern: t3, seconds: 45, noise: 0.6), "smoke_alarm"),
    ("smoke 520 Hz square (low-frequency alarm)", synthetic(frequency: 520, pattern: t3, seconds: 45, noise: 0.05, square: true), "smoke_alarm"),
    ("CO 3 kHz", synthetic(frequency: 3_000, pattern: t4, seconds: 45, noise: 0.05), "co_alarm"),
    ("alarm clock: 4 beeps a second", synthetic(frequency: 2_800, pattern: [(0.12, 0.13)], seconds: 45, noise: 0.05), "alarm_beeping"),
    ("alarm clock, only 20 s then switched off", synthetic(frequency: 2_800, pattern: [(0.12, 0.13)], seconds: 20, noise: 0.05), "")
]
for (label, samples, want) in cases {
    let found = detect(samples, rate: 16_000)
    let ok = want.isEmpty ? found.isEmpty : found == [want]
    print("  \(label): got \(found.sorted())  \(ok ? "OK" : "WRONG")")
}

print("\nESC-50 clips as non-alarms (each looped to 45 s):")
let root = URL(fileURLWithPath: args[2])
let csv = try String(contentsOf: root.appendingPathComponent("meta/esc50.csv"), encoding: .utf8)
var falseSmoke: [String] = [], falseCO: [String] = [], beeping: [String: Int] = [:]
var total = 0
for row in csv.split(separator: "\n").dropFirst().map({ $0.split(separator: ",").map(String.init) }) {
    autoreleasepool {
        guard let audio = load(root.appendingPathComponent("audio/\(row[0])")) else { return }
        total += 1
        let found = detect(looped(audio.samples, rate: audio.rate, seconds: 45), rate: audio.rate)
        if found.contains("smoke_alarm") { falseSmoke.append(row[3]) }
        if found.contains("co_alarm") { falseCO.append(row[3]) }
        if found.contains("alarm_beeping") { beeping[row[3], default: 0] += 1 }
    }
}
func tally(_ list: [String]) -> String {
    Dictionary(grouping: list, by: { $0 }).mapValues(\.count).sorted { $0.value > $1.value }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", ")
}
print("  \(total) clips. Called a smoke alarm: \(falseSmoke.count) \(falseSmoke.isEmpty ? "" : "(\(tally(falseSmoke)))")")
print("  Called a CO alarm: \(falseCO.count) \(falseCO.isEmpty ? "" : "(\(tally(falseCO)))")")
print("  Called sustained beeping: \(beeping.values.reduce(0, +)) \(beeping.isEmpty ? "" : "(\(beeping.sorted { $0.value > $1.value }.prefix(6).map { "\($0.key) ×\($0.value)" }.joined(separator: ", ")))")")
