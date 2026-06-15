import SwiftUI

/// The pendant's vitals as a single flat, full-width status ribbon — no pills,
/// no battery icons, no card. Purely typographic monospace metrics with a micro
/// green dot for the live BLE link, closed by a 0.5px titanium rule beneath.
/// Backed by `PendantTelemetryMonitor`, currently fed by mock telemetry.
struct DeviceStatusCard: View {
    var telemetry: PendantTelemetryMonitor

    /// The one permitted spot of colour: a micro indicator for a live link.
    private let liveGreen = Color(red: 0.30, green: 0.80, blue: 0.46)

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(telemetry.isStreaming ? liveGreen : Color.nmlMuted.opacity(0.5))
                        .frame(width: 6, height: 6)
                    Text(telemetry.isStreaming ? "BLE STREAMING" : "BLE IDLE")
                        .font(.nmlMono(10, weight: .medium))
                        .tracking(0.6)
                        .foregroundStyle(telemetry.isStreaming ? Color.nmlInk : Color.nmlMuted)
                }

                Spacer(minLength: 8)

                metric(String(format: "%.1fMS", telemetry.routingLatencyMillis))
                metric("CORE \(telemetry.coreBatteryPercent)%")
                metric("CLASP \(telemetry.claspBatteryPercent)%")
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 11)

            Rectangle()
                .fill(Color.nmlHairline)
                .frame(height: 0.5)
        }
    }

    private func metric(_ text: String) -> some View {
        Text(text)
            .font(.nmlMono(10, weight: .medium))
            .tracking(0.4)
            .foregroundStyle(Color.nmlTitanium)
            .fixedSize()
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
