import Accelerate
import Foundation

/// Recognises alarms by their beep pattern, not by what a beep sounds like. A smoke alarm and an alarm
/// clock are both high piezo beeps, which is why a general sound model confuses them; the international
/// alarm patterns (ISO 8201) are what tell them apart:
///   smoke: three ~0.5 s beeps, ~0.5 s apart, then ~1.5 s quiet, repeating (T3)
///   carbon monoxide: four short beeps, then a pause, repeating (T4)
/// Rapid steady beeping with neither pattern is only reported once it has kept going for a while,
/// because a clock gets switched off and an alarm does not.
final class AlarmPatternDetector {
    enum Pattern: String {
        case smoke = "smoke_alarm"
        case carbonMonoxide = "co_alarm"
        case sustainedBeeping = "alarm_beeping"
    }

    /// Beeps live here: piezo alarms at roughly 2.3 to 4 kHz, low-frequency (520 Hz) alarms near 500 Hz.
    private static let bands: [ClosedRange<Double>] = [2_200...4_200, 380...680]
    static let sustainedBeepingSeconds = 30.0

    private let sampleRate: Double
    private let frameLength: Int
    private let hop: Int
    private let fft: vDSP.FFT<DSPSplitComplex>
    private let window: [Float]

    private var pending: [Float] = []
    private var clock: Double = 0
    /// The quiet level inside each band, so "louder than the room" is judged where alarms actually sound.
    private var bandFloor: [Float]
    /// The recent beep level in each band. Echo keeps a little sound in the gaps between beeps, so a gap is
    /// any frame that falls well below the beep, not only one that falls all the way to the room's quiet level.
    private var bandPeak: [Float]
    private(set) var runs: [(on: Bool, length: Double, pitch: Double)] = []
    private var currentOn = false
    private var currentLength = 0.0
    private var currentPitches: [Double] = []
    private var previousPitches: [Double] = []
    private var framePitch = 0.0
    private var beepingSince: Double?
    private var reported = Set<Pattern>()

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        // About 15 ms per frame and a 10 ms step: fine enough to see the 50 ms gaps in rapid beeping.
        var length = 128
        while Double(length * 2) <= sampleRate * 0.016 { length *= 2 }
        frameLength = length
        hop = max(1, Int(sampleRate * 0.01))
        bandFloor = Array(repeating: 0, count: Self.bands.count)
        bandPeak = Array(repeating: 0, count: Self.bands.count)
        fft = vDSP.FFT(log2n: vDSP_Length(log2(Double(length))), radix: .radix2, ofType: DSPSplitComplex.self)!
        window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: length, isHalfWindow: false)
    }

    /// Feed mono audio as it arrives. Returns a pattern the first time it is recognised.
    func process(_ samples: [Float]) -> Pattern? {
        pending.append(contentsOf: samples)
        var found: Pattern?
        while pending.count >= frameLength {
            let frame = Array(pending[0..<frameLength])
            pending.removeFirst(hop)
            clock += Double(hop) / sampleRate
            if let pattern = step(isBeep(frame)), found == nil { found = pattern }
        }
        return found
    }

    func reset() {
        pending.removeAll()
        runs.removeAll()
        currentOn = false
        currentLength = 0
        currentPitches.removeAll()
        beepingSince = nil
        reported.removeAll()
    }

    // MARK: - One frame: is a beep sounding?

    private func isBeep(_ frame: [Float]) -> Bool {
        let windowed = vDSP.multiply(frame, window)
        let half = frameLength / 2
        var real = [Float](repeating: 0, count: half)
        var imag = [Float](repeating: 0, count: half)
        var power = [Float](repeating: 0, count: half)
        real.withUnsafeMutableBufferPointer { realPointer in
            imag.withUnsafeMutableBufferPointer { imagPointer in
                var split = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imagPointer.baseAddress!)
                windowed.withUnsafeBufferPointer { input in
                    input.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                    }
                }
                fft.forward(input: split, output: &split)
                vDSP.squareMagnitudes(split, result: &power)
            }
        }
        power[0] = 0
        let total = vDSP.sum(power)
        guard total > 0 else { return false }

        let binWidth = sampleRate / Double(frameLength)
        var beep = false
        var bandEnergies = [Float](repeating: 0, count: Self.bands.count)
        for (index, band) in Self.bands.enumerated() {
            let low = max(1, Int(band.lowerBound / binWidth)), high = min(half - 1, Int(band.upperBound / binWidth))
            guard high > low else { continue }
            let slice = power[low...high]
            let energy = slice.reduce(0, +)
            bandEnergies[index] = energy
            guard energy > 0 else { continue }
            // A tone puts its energy in a few neighbouring bins; noise spreads it across the band.
            let peakIndex = slice.indices.max(by: { power[$0] < power[$1] })!
            let around = power[max(low, peakIndex - 2)...min(high, peakIndex + 2)].reduce(0, +)
            // A peak on the band's edge is a lower or higher sound spilling in, not a tone inside the band.
            let inside = peakIndex > low + 1 && peakIndex < high - 1
            let tonal = inside && around / energy > 0.5
            let dominant = energy / total > 0.3
            let aboveRoom = energy > max(bandFloor[index] * 3, 1e-9)
            if tonal && dominant && aboveRoom { bandPeak[index] = max(bandPeak[index] * 0.995, energy) }
            let nearPeak = energy > bandPeak[index] * 0.125
            if tonal && dominant && aboveRoom && nearPeak, !beep {
                beep = true
                framePitch = Double(peakIndex) * binWidth
            }
        }
        if !beep {
            // Track each band's quiet level so the threshold adapts to each house.
            for index in bandFloor.indices {
                bandFloor[index] = bandFloor[index] == 0 ? bandEnergies[index] : bandFloor[index] * 0.98 + bandEnergies[index] * 0.02
            }
        }
        return beep
    }

    // MARK: - On/off timing

    private func step(_ beep: Bool) -> Pattern? {
        let frameSeconds = Double(hop) / sampleRate
        if beep { currentPitches.append(framePitch) }
        if beep == currentOn {
            currentLength += frameSeconds
            // A long silence ends any pattern in progress.
            if !currentOn, currentLength > 6 { runs.removeAll(); beepingSince = nil }
            return nil
        }
        // Ignore flickers shorter than two frames by folding them back into the previous run.
        if currentLength < frameSeconds * 1.5, let last = runs.popLast() {
            currentOn = last.on
            currentLength = last.length + currentLength + frameSeconds
            currentPitches = last.on ? previousPitches + currentPitches : []
            return nil
        }
        let sorted = currentPitches.sorted()
        let pitch = currentOn && !sorted.isEmpty ? sorted[sorted.count / 2] : 0
        runs.append((currentOn, currentLength, pitch))
        previousPitches = currentPitches
        if runs.count > 40 { runs.removeFirst(runs.count - 40) }
        currentOn = beep
        currentLength = frameSeconds
        currentPitches = beep ? [framePitch] : []
        return match()
    }

    private func match() -> Pattern? {
        if !reported.contains(.smoke), groups(beeps: 3, beep: 0.3...0.85, gap: 0.25...0.8, pause: 1.0...2.4) >= 2 {
            reported.insert(.smoke)
            return .smoke
        }
        if !reported.contains(.carbonMonoxide), groups(beeps: 4, beep: 0.05...0.3, gap: 0.015...0.3, pause: 0.9...6.5) >= 3 {
            reported.insert(.carbonMonoxide)
            return .carbonMonoxide
        }
        if steadyBeeping() {
            if beepingSince == nil { beepingSince = clock }
            if let since = beepingSince, clock - since >= Self.sustainedBeepingSeconds, !reported.contains(.sustainedBeeping) {
                reported.insert(.sustainedBeeping)
                return .sustainedBeeping
            }
        } else {
            beepingSince = nil
        }
        return nil
    }

    /// Counts complete, back-to-back groups of `beeps` beeps followed by a pause, ending at the latest run.
    private func groups(beeps: Int, beep: ClosedRange<Double>, gap: ClosedRange<Double>, pause: ClosedRange<Double>) -> Int {
        let groupLength = beeps * 2
        var count = 0
        var end = runs.count
        // The newest completed run should be the pause that closes a group.
        while end >= groupLength {
            let group = runs[(end - groupLength)..<end]
            var ok = true
            for (offset, run) in group.enumerated() {
                let isLast = offset == groupLength - 1
                if offset % 2 == 0 {
                    ok = ok && run.on && beep.contains(run.length)
                } else {
                    ok = ok && !run.on && (isLast ? pause : gap).contains(run.length)
                }
            }
            // An alarm sounds one fixed note; a voice or bird call slides between notes.
            let pitches = group.filter(\.on).map(\.pitch)
            if let low = pitches.min(), let high = pitches.max(), low <= 0 || high / low > 1.06 { ok = false }
            guard ok else { break }
            count += 1
            end -= groupLength
        }
        return count
    }

    /// Rapid, regular beeping: at least ten recent beeps with a steady rhythm and no long gaps.
    private func steadyBeeping() -> Bool {
        let recent = runs.suffix(20)
        guard recent.count >= 20 else { return false }
        let beeps = recent.filter(\.on).map(\.length)
        let gaps = recent.filter { !$0.on }.map(\.length)
        guard beeps.allSatisfy({ (0.05...0.8).contains($0) }), gaps.allSatisfy({ (0.015...0.9).contains($0) }) else { return false }
        let periods = zip(beeps, gaps).map { $0 + $1 }
        let mean = periods.reduce(0, +) / Double(periods.count)
        let spread = sqrt(periods.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(periods.count))
        return spread / mean < 0.3
    }
}
