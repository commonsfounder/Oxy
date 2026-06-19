import SwiftUI

/// The pendant's home: pairing, live status, and hardware configuration, all in
/// one place. Pairing (scan / connect / unpair) used to live in Settings, which
/// is why "pendant settings weren't under Pendant" — it's here now.
struct PendantStatusView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var telemetry = PendantTelemetryMonitor()

    /// The single source of truth for connection state: the BLE manager. Both the
    /// Status row and the Live section derive from this — telemetry is only allowed
    /// to stream while the manager reports `.connected`, so "Not connected" and live
    /// numbers can never render at the same time.
    private var pendant: PendantBLEManager { NativeIntegrationManager.shared.pendant }

    // Persisted hardware configuration.
    @AppStorage("nml_hw_wakeword") private var wakeword = "CHIN TILT"
    @AppStorage("nml_hw_audio") private var audioOutput = "BLE BUDS"
    @AppStorage("nml_hw_haptic") private var hapticForce = "MID"

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlObsidian.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Pendant", onBack: { dismiss() })
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            // Pairing — the primary action: get a device connected.
                            PendantPairingSection(pendant: NativeIntegrationManager.shared.pendant)

                            // Live vitals — only meaningful once a device is linked.
                            VStack(alignment: .leading, spacing: 4) {
                                NamelessSectionHeader(title: "Live")
                                    .padding(.bottom, 12)
                                if pendant.isConnected {
                                    DeviceStatusCard(telemetry: telemetry)
                                } else {
                                    Text("No live data — pendant not connected.")
                                        .font(.nmlBody(13))
                                        .foregroundStyle(Color.nmlMuted)
                                        .padding(.vertical, 11)
                                }
                            }

                            // Hardware behaviour.
                            hardwareConfig
                        }
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 40)
                        // Mechanical-switch pulse for each config change.
                        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: wakeword)
                        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: audioOutput)
                        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: hapticForce)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.startLocation.x < 60, value.translation.width > 80 {
                            dismiss()
                        }
                    }
            )
        }
        .onAppear { syncTelemetry() }
        .onDisappear { telemetry.stop() }
        .onChange(of: pendant.connectionState) { _, _ in syncTelemetry() }
    }

    /// Telemetry streams only while the BLE link is up, so the Live section can
    /// never show numbers for a disconnected pendant.
    private func syncTelemetry() {
        if pendant.isConnected { telemetry.start() } else { telemetry.stop() }
    }

    // MARK: - Hardware config

    private var hardwareConfig: some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: "Hardware Config")
                .padding(.bottom, 10)

            VStack(spacing: 0) {
                configRow(label: "WAKEWORD", options: ["CHIN TILT", "TAP"], selection: $wakeword)
                NamelessDivider()
                configRow(label: "AUDIO OUTPUT", options: ["BLE BUDS", "WHISPER HAPTICS"], selection: $audioOutput)
                NamelessDivider()
                configRow(label: "HAPTIC FORCE", options: ["LOW", "MID", "HIGH"], selection: $hapticForce)
            }
        }
    }

    private func configRow(label: String, options: [String], selection: Binding<String>) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 16) {
                configLabel(label)
                NamelessSegmentedControl(options: options, selection: selection)
            }

            VStack(alignment: .leading, spacing: 10) {
                configLabel(label)
                NamelessSegmentedControl(options: options, selection: selection)
            }
        }
        .padding(.vertical, 14)
    }

    private func configLabel(_ text: String) -> some View {
        Text(text)
            .font(.nmlMono(11, weight: .medium))
            .tracking(1.0)
            .foregroundStyle(Color.nmlMuted)
            .fixedSize()
    }
}

// MARK: - Pairing

/// BLE pairing controls — status, paired device name, and scan / unpair / cancel.
/// Moved here from Settings so the whole pendant lifecycle lives on one screen.
private struct PendantPairingSection: View {
    var pendant: PendantBLEManager
    @State private var showUnpairConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: "Pairing")
                .padding(.bottom, 10)

            VStack(spacing: 0) {
                HStack {
                    Text("Status")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Spacer()
                    HStack(spacing: 10) {
                        Text(statusDescription)
                            .font(.nmlMono(12))
                            .foregroundStyle(statusColor)
                            .contentTransition(.numericText())
                            .animation(.easeInOut(duration: 0.3), value: pendant.connectionState)
                        statusIndicator
                            .animation(.nmlSpring, value: pendant.connectionState)
                    }
                }
                .padding(.vertical, 16)

                if let name = pendant.peripheralName, pendant.isConnected {
                    NamelessDivider()
                    HStack {
                        Text("Device")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(Color.nmlInk)
                        Spacer()
                        Text(name)
                            .font(.nmlMono(12))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    .padding(.vertical, 16)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if let error = pendant.lastError {
                    NamelessDivider()
                    Text(error)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 16)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                NamelessDivider()

                HStack(spacing: 12) {
                    if pendant.isConnected {
                        Button("UNPAIR") {
                            showUnpairConfirm = true
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlDanger)
                        .transition(.opacity)
                    } else if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                        Button("CANCEL") {
                            pendant.stopScan()
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlMuted)
                        .transition(.opacity)
                    } else {
                        Button("SCAN FOR PENDANT") {
                            pendant.startScan()
                        }
                        .font(.nmlMono(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(Color.nmlTitanium)
                        .transition(.opacity)
                    }
                    Spacer()
                }
                .padding(.vertical, 16)
                .animation(.nmlStandard, value: pendant.connectionState)
            }
        }
        .animation(.nmlSpring, value: pendant.connectionState)
        .alert("Unpair Pendant", isPresented: $showUnpairConfirm) {
            Button("Unpair", role: .destructive) { pendant.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will disconnect and forget the paired pendant. You can pair again later.")
        }
    }

    private var statusDescription: String {
        switch pendant.connectionState {
        case .disconnected: return "Not connected"
        case .scanning: return "Scanning…"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .error: return "Error"
        }
    }

    private var statusColor: Color {
        switch pendant.connectionState {
        case .connected: return Color.nmlTitanium
        case .error: return Color.nmlDanger
        case .scanning, .connecting: return Color.nmlMuted
        default: return Color.nmlMuted
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch pendant.connectionState {
        case .connected:
            NamelessStatusDot(kind: .live, diameter: 6)
        case .scanning, .connecting:
            ScanPulseView()
        case .error:
            NamelessStatusDot(kind: .error, diameter: 6)
        case .disconnected:
            NamelessStatusDot(kind: .off, diameter: 6)
        }
    }
}

private struct ScanPulseView: View {
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.nmlTitanium.opacity(pulse ? 0 : 0.4), lineWidth: 2)
                .frame(width: pulse ? 24 : 12, height: pulse ? 24 : 12)
                .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulse)

            Circle()
                .fill(Color.nmlTitanium)
                .frame(width: 8, height: 8)
        }
        .onAppear { pulse = true }
    }
}

#Preview {
    PendantStatusView()
        .environment(AppState())
}
