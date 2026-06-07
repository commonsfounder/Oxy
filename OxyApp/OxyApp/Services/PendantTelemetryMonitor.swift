import Foundation
import Observation

/// One sampled snapshot of the pendant's hardware and routing health.
struct PendantTelemetryReading: Sendable {
    var isStreaming: Bool
    var coreBatteryPercent: Int
    var claspBatteryPercent: Int
    var routingLatencyMillis: Double
}

/// Anything that can produce a live stream of telemetry readings. The eventual
/// implementation reads CoreBluetooth battery and routing-latency characteristics
/// off the physical pendant; `MockPendantTelemetrySource` simulates plausible
/// values in the meantime so the UI can be built and reviewed today.
protocol PendantTelemetrySource: Sendable {
    func readings() -> AsyncStream<PendantTelemetryReading>
}

/// Live readout of the pendant's two modules — Core (chest unit) and Clasp
/// (the weighted nape-of-neck module) — plus the BLE link and the server-side
/// semantic-routing latency. Backed by a `PendantTelemetrySource`; swap in a
/// CoreBluetooth-backed source once the firmware exposes real characteristics
/// and every view that reads this monitor updates for free.
@MainActor
@Observable
final class PendantTelemetryMonitor {
    private(set) var isStreaming = false
    private(set) var coreBatteryPercent = 0
    private(set) var claspBatteryPercent = 0
    private(set) var routingLatencyMillis: Double = 0

    private let source: PendantTelemetrySource
    private var task: Task<Void, Never>?

    init(source: PendantTelemetrySource = MockPendantTelemetrySource()) {
        self.source = source
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            for await reading in source.readings() {
                await MainActor.run { self.apply(reading) }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func apply(_ reading: PendantTelemetryReading) {
        isStreaming = reading.isStreaming
        coreBatteryPercent = reading.coreBatteryPercent
        claspBatteryPercent = reading.claspBatteryPercent
        routingLatencyMillis = reading.routingLatencyMillis
    }
}

/// Simulates a steady BLE link: batteries drain by a point every minute or so,
/// and routing latency gently jitters just under the 10ms target. Replace this
/// with a CoreBluetooth source once the pendant exposes real characteristics —
/// nothing downstream needs to change.
struct MockPendantTelemetrySource: PendantTelemetrySource {
    func readings() -> AsyncStream<PendantTelemetryReading> {
        AsyncStream { continuation in
            let task = Task {
                var coreBattery = 86
                var claspBattery = 91
                var tick = 0
                while !Task.isCancelled {
                    tick += 1
                    if tick % 30 == 0 { coreBattery = max(coreBattery - 1, 14) }
                    if tick % 42 == 0 { claspBattery = max(claspBattery - 1, 14) }
                    let latency = ((5.4 + Double.random(in: 0...3.4)) * 10).rounded() / 10
                    continuation.yield(
                        PendantTelemetryReading(
                            isStreaming: true,
                            coreBatteryPercent: coreBattery,
                            claspBatteryPercent: claspBattery,
                            routingLatencyMillis: latency
                        )
                    )
                    try? await Task.sleep(for: .seconds(2))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
