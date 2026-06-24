import SwiftUI

/// The pendant's vitals as a single flat, full-width status ribbon — no pills,
/// no battery icons, no card. Purely typographic monospace metrics with a micro
/// green dot for the live BLE link, closed by a 0.5px titanium rule beneath.
/// Backed by `PendantTelemetryMonitor`, currently fed by mock telemetry.
struct DeviceStatusCard: View {
    var telemetry: PendantTelemetryMonitor

    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    liveState
                    Spacer(minLength: 8)
                    metrics
                }

                VStack(alignment: .leading, spacing: 9) {
                    liveState
                    metrics
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 11)

            Rectangle()
                .fill(Color.nmlHairline)
                .frame(height: 0.5)
        }
    }

    private var liveState: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(telemetry.isStreaming ? Color.nmlLive : Color.nmlMuted.opacity(0.5))
                .frame(width: 6, height: 6)
            Text(telemetry.isStreaming ? "BLE STREAMING" : "BLE IDLE")
                .font(.nmlMono(10, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(telemetry.isStreaming ? Color.nmlInk : Color.nmlMuted)
                .fixedSize()
        }
    }

    private var metrics: some View {
        HStack(spacing: 12) {
            metric(String(format: "%.1fMS", telemetry.routingLatencyMillis))
            metric("CORE \(telemetry.coreBatteryPercent)%")
            metric("CLASP \(telemetry.claspBatteryPercent)%")
        }
    }

    private func metric(_ text: String) -> some View {
        Text(text)
            .font(.nmlMono(10, weight: .medium))
            .tracking(0.4)
            .foregroundStyle(Color.nmlTitanium)
            .fixedSize()
            // Live telemetry rolls its digits instead of popping.
            .contentTransition(.numericText())
            .animation(.nmlStandard, value: text)
    }
}

#Preview {
    ZStack(alignment: .top) {
        Color.nmlObsidian.ignoresSafeArea()
        DeviceStatusCard(telemetry: {
            let monitor = PendantTelemetryMonitor()
            monitor.start()
            return monitor
        }())
    }
}
