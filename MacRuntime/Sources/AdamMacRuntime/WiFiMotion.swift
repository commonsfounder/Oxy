import CoreWLAN
import Foundation

public struct WiFiMotionSample: Codable, Equatable, Sendable {
    public let elapsedSeconds: Double
    public let rssiDBm: Int
    public let noiseDBm: Int
    public let transmitMbps: Double

    public init(elapsedSeconds: Double, rssiDBm: Int, noiseDBm: Int, transmitMbps: Double) {
        self.elapsedSeconds = elapsedSeconds
        self.rssiDBm = rssiDBm
        self.noiseDBm = noiseDBm
        self.transmitMbps = transmitMbps
    }
}

public struct WiFiMotionFeatures: Equatable, Sendable {
    public let sampleCount: Int
    public let meanRSSI: Double
    public let standardDeviation: Double
    public let meanAbsoluteStep: Double
    public let range: Int

    public init(samples: [WiFiMotionSample]) {
        let values = samples.map { Double($0.rssiDBm) }
        sampleCount = values.count
        meanRSSI = values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
        let mean = meanRSSI
        standardDeviation = values.isEmpty
            ? 0
            : sqrt(values.map { pow($0 - mean, 2) }.reduce(0, +) / Double(values.count))
        meanAbsoluteStep = values.count < 2
            ? 0
            : zip(values, values.dropFirst()).map { abs($0 - $1) }.reduce(0, +) / Double(values.count - 1)
        range = values.isEmpty ? 0 : Int(values.max()! - values.min()!)
    }
}

public enum WiFiMotionState: String, Equatable, Sendable {
    case insufficientData = "insufficient_data"
    case quiet
    case motionLikely = "motion_likely"
}

public struct WiFiMotionClassifier: Equatable, Sendable {
    public let minimumSamples: Int
    public let standardDeviationMultiplier: Double
    public let stepMultiplier: Double

    public init(minimumSamples: Int = 20, standardDeviationMultiplier: Double = 1.5, stepMultiplier: Double = 1.75) {
        self.minimumSamples = minimumSamples
        self.standardDeviationMultiplier = standardDeviationMultiplier
        self.stepMultiplier = stepMultiplier
    }

    public func classify(baseline: WiFiMotionFeatures, window: WiFiMotionFeatures) -> WiFiMotionState {
        guard baseline.sampleCount >= minimumSamples, window.sampleCount >= minimumSamples else { return .insufficientData }
        // A quiet room can produce a zero-variance baseline. Keep a small absolute
        // floor so a perfectly stable baseline does not make the detector inert.
        let stdMotion = window.standardDeviation >= max(0.75, baseline.standardDeviation * standardDeviationMultiplier)
        let stepMotion = window.meanAbsoluteStep >= max(0.5, baseline.meanAbsoluteStep * stepMultiplier)
        return stdMotion || stepMotion ? .motionLikely : .quiet
    }
}

public enum WiFiMotionSampler {
    public static func currentInterface() -> CWInterface? {
        CWWiFiClient.shared().interface()
    }

    public static func sample(interface wifi: CWInterface, elapsedSeconds: Double) -> WiFiMotionSample {
        WiFiMotionSample(
            elapsedSeconds: elapsedSeconds,
            rssiDBm: wifi.rssiValue(),
            noiseDBm: wifi.noiseMeasurement(),
            transmitMbps: wifi.transmitRate()
        )
    }
}
