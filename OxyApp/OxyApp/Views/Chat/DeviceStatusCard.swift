import SwiftUI

/// The pendant's vitals, rendered the way a well-made object's status should
/// read — quiet, exact, no dashboards. A single hairline-bordered card showing
/// the BLE link, the <10ms semantic-routing latency, and battery for both
/// modules: Core (the chest unit) and Clasp (the weighted nape-of-neck module).
/// Backed by `PendantTelemetryMonitor`, currently fed by mock telemetry.
struct DeviceStatusCard: View {
    var telemetry: PendantTelemetryMonitor

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 10) {
                NamelessStatusDot(isLive: telemetry.isStreaming)
                Text(telemetry.isStreaming ? "BLE streaming" : "BLE idle")
                    .nmlEyebrow()
                Spacer()
                Text("ROUTING")
                    .nmlEyebrow()
                Text(String(format: "%.1fms", telemetry.routingLatencyMillis))
                    .font(.nmlMono(12, weight: .medium))
                    .foregroundStyle(Color.nmlTitanium)
            }

            HStack(spacing: 0) {
                moduleReadout(label: "Core", percent: telemetry.coreBatteryPercent)
                Rectangle()
                    .fill(Color.nmlHairline)
                    .frame(width: 0.5)
                moduleReadout(label: "Clasp", percent: telemetry.claspBatteryPercent)
            }
        }
        .padding(24)
        .background(Color.nmlSurface)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .nmlHairline(radius: 18)
    }

    private func moduleReadout(label: String, percent: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .nmlEyebrow()
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(percent)")
                    .font(.nmlMono(24, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                Text("%")
                    .font(.nmlMono(13))
                    .foregroundStyle(Color.nmlMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }
}

#Preview {
    ZStack {
        Color.nmlObsidian.ignoresSafeArea()
        DeviceStatusCard(telemetry: {
            let monitor = PendantTelemetryMonitor()
            monitor.start()
            return monitor
        }())
        .padding(24)
    }
}
