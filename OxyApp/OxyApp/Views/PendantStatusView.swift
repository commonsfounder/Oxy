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
    @AppStorage("oxy_hw_wakeword") private var wakeword = "CHIN TILT"
    @AppStorage("oxy_hw_audio") private var audioOutput = "BLE BUDS"
    @AppStorage("oxy_hw_haptic") private var hapticForce = "MID"

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Pendant", onBack: { dismiss() })
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            // Pairing — the primary action: get a device connected.
                            PendantPairingSection(pendant: NativeIntegrationManager.shared.pendant)

                            // Live vitals — only meaningful once a device is linked.
                            // Collapses entirely while disconnected instead of showing
                            // a dead "no data" placeholder.
                            if pendant.isConnected {
                                VStack(alignment: .leading, spacing: 4) {
                                    AppSectionHeader(title: "Live")
                                        .padding(.bottom, 12)
                                    DeviceStatusCard(telemetry: telemetry)
                                }
                            }

                            // Hardware behaviour — only relevant once a pendant is paired.
                            if pendant.isConnected {
                                hardwareConfig
                            } else {
                                Text("Pair your pendant to configure it and see live status.")
                                    .font(.rowSecondary)
                                    .foregroundStyle(Color.appMuted)
                            }
                        }
                        .padding(.horizontal, AppSpacing.margin)
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
            // Edge-swipe-to-dismiss comes from `.swipeToDismiss()` on the presenting
            // fullScreenCover (MoreView); no per-screen recognizer needed.
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
        VStack(alignment: .leading, spacing: 20) {
            AppSectionHeader(title: "Pendant behaviour")
            configControl(title: "Wake gesture",
                          options: ["CHIN TILT", "TAP"], labels: ["Chin tilt", "Tap"], selection: $wakeword)
            configControl(title: "Audio",
                          options: ["BLE BUDS", "WHISPER HAPTICS"], labels: ["Earbuds", "Whisper"], selection: $audioOutput)
            configControl(title: "Vibration",
                          options: ["LOW", "MID", "HIGH"], labels: ["Light", "Medium", "Strong"], selection: $hapticForce)
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
/// Moved here from Settings so the whole pendant lifecycle lives on one screen.
private struct PendantPairingSection: View {
    var pendant: PendantBLEManager
    @State private var showUnpairConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MilgrainSectionHeader(title: "Pairing")
                .padding(.bottom, 10)

            VStack(spacing: 0) {
                HStack {
                    Text("Status")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.mgHeading)
                    Spacer()
                    if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                        ProgressView()
                            .scaleEffect(0.7)
                            .tint(Color.appMuted)
                            .padding(.trailing, 6)
                    }
                    // Static sans label — no status dot, no pulse (Milgrain spec).
                    Text(statusDescription)
                        .font(.appBody(15, weight: .semibold))
                        .foregroundStyle(statusColor)
                        .animation(.easeInOut(duration: 0.3), value: pendant.connectionState)
                }
                .padding(.vertical, 16)

                if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                    Text("Hold the pendant close to your phone.")
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                        .padding(.bottom, 12)
                        .transition(.opacity)
                }

                if let name = pendant.peripheralName, pendant.isConnected {
                    MilgrainDivider()
                    HStack {
                        Text("Device")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.mgHeading)
                        Spacer()
                        Text(name)
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(Color.mgCaption)
                    }
                    .padding(.vertical, 16)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if let error = pendant.lastError {
                    MilgrainDivider()
                    Text(error)
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(Color.mgDestructive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 16)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                MilgrainDivider()

                HStack(spacing: 12) {
                    if pendant.isConnected {
                        Button("Unpair") {
                            showUnpairConfirm = true
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.mgDestructive)
                        .transition(.opacity)
                    } else if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                        Button("Cancel") {
                            pendant.stopScan()
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .transition(.opacity)
                    } else {
                        Button("Scan for pendant") {
                            pendant.startScan()
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.mgHeading)
                        .transition(.opacity)
                    }
                    Spacer()
                }
                .padding(.vertical, 16)
                .animation(.appStandard, value: pendant.connectionState)
            }
        }
        .animation(.appSpring, value: pendant.connectionState)
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
        case .connected: return Color.mgHeading
        case .error: return Color.mgDestructive
        default: return Color.mgSecondary
        }
    }
}

#Preview {
    PendantStatusView()
        .environment(AppState())
}
