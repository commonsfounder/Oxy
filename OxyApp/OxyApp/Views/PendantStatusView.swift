import SwiftUI

/// The home device's home: pairing, live status, and hardware configuration, all
/// in one place. The implementation names stay compatible with the current BLE
/// firmware while the product surface speaks in household-device terms.
struct PendantStatusView: View {
    @Environment(AppState.self) private var appState
    @State private var telemetry = PendantTelemetryMonitor()

    /// The single source of truth for connection state: the BLE manager. Both the
    /// Status row and the Live section derive from this — telemetry is only allowed
    /// to stream while the manager reports `.connected`, so "Not connected" and live
    /// numbers can never render at the same time.
    private var pendant: PendantBLEManager { NativeIntegrationManager.shared.pendant }

    // Persisted hardware configuration.
    @AppStorage("oxy_hw_wakeword") private var wakeword = "CHIN TILT"
    @AppStorage("oxy_hw_audio") private var audioOutput = "BLE BUDS"
    @AppStorage("oxy_hw_haptic") private var hapticForce = "MID"

    var body: some View {
        SettingsPage(title: "Home device") {
            // Pairing: the primary action, getting a device connected.
            PendantPairingSection(pendant: NativeIntegrationManager.shared.pendant)

            // Live numbers and behaviour only mean something once a device is linked.
            if pendant.isConnected {
                SettingsGroup(title: "Live") {
                    DeviceStatusCard(telemetry: telemetry)
                }
                hardwareConfig
            } else {
                SettingsStatement(text: "Connect a device to see its status", solid: false)
                    .padding(.horizontal, 4)
            }
        }
        // Mechanical-switch pulse for each config change.
        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: wakeword)
        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: audioOutput)
        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: hapticForce)
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
        SettingsGroup(title: "Home device behaviour") {
            VStack(alignment: .leading, spacing: 18) {
                configControl(title: "Wake gesture",
                              options: ["CHIN TILT", "TAP"], labels: ["Chin tilt", "Tap"], selection: $wakeword)
                configControl(title: "Audio",
                              options: ["BLE BUDS", "WHISPER HAPTICS"], labels: ["Earbuds", "Whisper"], selection: $audioOutput)
                configControl(title: "Vibration",
                              options: ["LOW", "MID", "HIGH"], labels: ["Light", "Medium", "Strong"], selection: $hapticForce)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface()
        }
    }

    private func configControl(title: String, options: [String], labels: [String], selection: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.rowTitle).foregroundStyle(Color.appInk)
            AppSegmented(options: options, labels: labels, selection: selection)
        }
    }
}

// MARK: - Pairing

/// BLE pairing controls — status, paired device name, and scan / unpair / cancel.
/// Moved here from Settings so the whole device lifecycle lives on one screen.
private struct PendantPairingSection: View {
    var pendant: PendantBLEManager
    @State private var showUnpairConfirm = false

    private var isBusy: Bool { pendant.connectionState == .scanning || pendant.connectionState == .connecting }

    var body: some View {
        SettingsGroup(title: "Pairing") {
            SettingsList {
                SettingsRow(
                    title: "Status",
                    subtitle: isBusy ? "Keep the home device close to your phone" : nil
                ) {
                    HStack(spacing: 8) {
                        if isBusy {
                            ProgressView().scaleEffect(0.7).tint(Color.appMuted)
                        }
                        Text(statusDescription)
                            .font(.appBody(14))
                            .foregroundStyle(statusColor)
                            .animation(.easeInOut(duration: 0.3), value: pendant.connectionState)
                    }
                }

                if let name = pendant.peripheralName, pendant.isConnected {
                    SettingsRule()
                    SettingsRow(title: "Device") {
                        Text(name).font(.appBody(14)).foregroundStyle(Color.appMuted)
                    }
                }

                if pendant.isConnected {
                    SettingsRule()
                    SettingsRow(title: "Doorway presence") {
                        if pendant.isCurrentBeaconTrustedForDoorwayPresence {
                            quietAction("Stop using", color: Color.appDestructive) {
                                pendant.stopUsingConnectedBeaconForDoorwayPresence()
                            }
                        } else {
                            quietAction("Use this device", color: Color.appAccent) {
                                _ = pendant.useConnectedBeaconForDoorwayPresence()
                            }
                        }
                    }
                }
            }

            if let error = pendant.lastError {
                ErrorBanner(message: error)
            }

            if pendant.isConnected {
                pill("Unpair", primary: false, destructive: true) { showUnpairConfirm = true }
            } else if isBusy {
                pill("Cancel", primary: false) { pendant.stopScan() }
            } else {
                pill("Scan for home device", primary: true) { pendant.startScan() }
            }
        }
        .animation(.appSpring, value: pendant.connectionState)
        .alert("Forget home device", isPresented: $showUnpairConfirm) {
            Button("Unpair", role: .destructive) { pendant.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will disconnect and forget the paired home device. You can pair again later.")
        }
    }

    private func quietAction(_ title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            Text(title)
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(color)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
    }

    private func pill(_ title: String, primary: Bool, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            Text(title)
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(primary ? Color.appOnAction : (destructive ? Color.appDestructive : Color.appInk))
                .padding(.horizontal, 22)
                .frame(minHeight: 44)
                .background(Capsule().fill(primary ? Color.appAction : Color.appInk.opacity(0.10)))
        }
        .buttonStyle(.appScale(0.97))
        .padding(.top, 4)
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
        case .connected: return Color.appInk
        case .error: return Color.appDestructive
        default: return Color.appMuted
        }
    }
}

#Preview {
    PendantStatusView()
        .environment(AppState())
}
