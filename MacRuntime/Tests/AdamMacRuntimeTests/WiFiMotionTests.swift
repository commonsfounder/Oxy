import XCTest
@testable import AdamMacRuntime

final class WiFiMotionTests: XCTestCase {
    private func samples(_ values: [Int]) -> [WiFiMotionSample] {
        values.enumerated().map { WiFiMotionSample(elapsedSeconds: Double($0.offset), rssiDBm: $0.element, noiseDBm: -92, transmitMbps: 130) }
    }

    func testFeaturesMatchRSSIWindow() {
        let features = WiFiMotionFeatures(samples: samples([-47, -47, -46, -48]))
        XCTAssertEqual(features.sampleCount, 4)
        XCTAssertEqual(features.meanRSSI, -47, accuracy: 0.001)
        XCTAssertEqual(features.range, 2)
        XCTAssertEqual(features.meanAbsoluteStep, 1.0, accuracy: 0.001)
    }

    func testMotionClassifierUsesRoomBaselineRatherThanAbsoluteRSSI() {
        let classifier = WiFiMotionClassifier()
        let baseline = WiFiMotionFeatures(samples: samples(Array(repeating: -47, count: 20)))
        XCTAssertEqual(classifier.classify(baseline: baseline, window: WiFiMotionFeatures(samples: samples(Array(repeating: -47, count: 20)))), .quiet)
        XCTAssertEqual(classifier.classify(baseline: baseline, window: WiFiMotionFeatures(samples: samples((0..<20).map { $0.isMultiple(of: 2) ? -44 : -50 }))), .motionLikely)
    }

    func testInsufficientDataDoesNotInterruptAdam() {
        let classifier = WiFiMotionClassifier()
        let short = WiFiMotionFeatures(samples: samples([-47, -48, -47]))
        XCTAssertEqual(classifier.classify(baseline: short, window: short), .insufficientData)
    }
}
