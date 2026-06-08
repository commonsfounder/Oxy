import SwiftUI

/// Standalone pendant / device-status screen pulled to the root of More. Shows
/// the live telemetry ribbon plus flat connection rows and a single text action
/// (scan / cancel / unpair), all in the Nameless language.
struct PendantStatusView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var telemetry = PendantTelemetryMonitor()
    @State private var showUnpairConfirm = false

    private let pendant = NativeIntegrationManager.shared.pendant

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        DeviceStatusCard(telemetry: telemetry)
                            .padding(.bottom, 4)

                        statusRow(label: "Status", value: statusDescription)

                        if let name = pendant.peripheralName, pendant.isConnected {
                            NamelessDivider()
                            statusRow(label: "Device", value: name)
                        }

                        if let error = pendant.lastError {
                            NamelessDivider()
                            HStack {
                                Text("Last Error")
                                    .font(.system(size: 15, weight: .regular))
                                    .foregroundStyle(Color.nmlInk)
                                Spacer(minLength: 16)
                                Text(error)
                                    .font(.nmlMono(11))
                                    .foregroundStyle(Color.nmlDanger)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                            .padding(.vertical, 22)
                        }

                        NamelessDivider()

                        actionRow
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .animation(.easeInOut(duration: 0.25), value: pendant.connectionState)
                }
            }
            .navigationTitle("Pendant")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Text("Back")
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(Color.nmlMuted)
                    }
                }
            }
            .alert("Unpair Pendant", isPresented: $showUnpairConfirm) {
                Button("Unpair", role: .destructive) { pendant.unpair() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will disconnect and forget the paired pendant. You can pair again later.")
            }
        }
        .onAppear { telemetry.start() }
        .onDisappear { telemetry.stop() }
    }

    private func statusRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Spacer(minLength: 16)
            Text(value)
                .font(.nmlMono(12))
                .foregroundStyle(Color.nmlMuted)
        }
        .padding(.vertical, 22)
    }

    @ViewBuilder
    private var actionRow: some View {
        Button {
            if pendant.isConnected {
                showUnpairConfirm = true
            } else if pendant.connectionState == .scanning || pendant.connectionState == .connecting {
                pendant.stopScan()
            } else {
                pendant.startScan()
            }
        } label: {
            HStack {
                Text(actionLabel)
                    .font(.nmlMono(11, weight: .medium))
                    .tracking(1.4)
                    .foregroundStyle(pendant.isConnected ? Color.nmlDanger : Color.nmlTitanium)
                Spacer()
            }
            .padding(.vertical, 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var actionLabel: String {
        if pendant.isConnected { return "UNPAIR" }
        if pendant.connectionState == .scanning || pendant.connectionState == .connecting { return "CANCEL" }
        return "SCAN FOR PENDANT"
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
}

#Preview {
    PendantStatusView()
}
