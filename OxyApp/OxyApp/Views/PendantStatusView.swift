import SwiftUI

/// High-end hardware integration screen: a central device visual flanked by the
/// CORE and SHELL battery gauges, a flat HARDWARE CONFIG module, and a quiet
/// footer of utility links — all in the Nameless language on pitch black.
struct PendantStatusView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var telemetry = PendantTelemetryMonitor()
    @State private var footerTap = 0

    // Persisted hardware configuration.
    @AppStorage("nml_pendant_finish") private var finishRaw = PendantFinish.obsidian.rawValue
    @AppStorage("nml_hw_wakeword") private var wakeword = "CHIN TILT"
    @AppStorage("nml_hw_audio") private var audioOutput = "BLE BUDS"
    @AppStorage("nml_hw_haptic") private var hapticForce = "MID"

    private var finish: PendantFinish { PendantFinish(rawValue: finishRaw) ?? .obsidian }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        // Device + dual battery gauges
                        HStack(alignment: .center, spacing: 22) {
                            VerticalBatteryGauge(label: "CORE", percent: telemetry.coreBatteryPercent)

                            DeviceVisual(finish: finish)
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.25)) {
                                        finishRaw = finish.next.rawValue
                                    }
                                }

                            VerticalBatteryGauge(label: "SHELL", percent: telemetry.claspBatteryPercent)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 16)
                        .padding(.bottom, 36)

                        // Hardware config
                        hardwareConfig

                        // Footer utility
                        footer
                            .padding(.top, 48)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 28)
                    .animation(.easeInOut(duration: 0.2), value: telemetry.coreBatteryPercent)
                }
                // Mechanical-switch pulse for each config change.
                .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: wakeword)
                .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: audioOutput)
                .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: hapticForce)
                // Crisp mechanical click when the hardware finish is changed.
                .sensoryFeedback(.impact(weight: .medium, intensity: 0.8), trigger: finishRaw)
                // Soft, quiet selection feedback for footer utility taps.
                .sensoryFeedback(.selection, trigger: footerTap)
            }
            .navigationTitle("Device")
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
        }
        .onAppear { telemetry.start() }
        .onDisappear { telemetry.stop() }
    }

    // MARK: - Hardware config

    private var hardwareConfig: some View {
        VStack(spacing: 0) {
            HStack {
                Text("HARDWARE CONFIG")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Color.gray)
                Spacer()
            }
            .padding(.bottom, 6)

            NamelessDivider()

            configRow(label: "WAKEWORD", options: ["CHIN TILT", "TAP"], selection: $wakeword)
            NamelessDivider()
            configRow(label: "AUDIO OUTPUT", options: ["BLE BUDS", "WHISPER HAPTICS"], selection: $audioOutput)
            NamelessDivider()
            configRow(label: "HAPTIC FORCE", options: ["LOW", "MID", "HIGH"], selection: $hapticForce)
        }
    }

    private func configRow(label: String, options: [String], selection: Binding<String>) -> some View {
        HStack(alignment: .center) {
            Text(label)
                .font(.nmlMono(11, weight: .medium))
                .tracking(1.0)
                .foregroundStyle(Color.nmlMuted)

            Spacer(minLength: 12)

            HStack(spacing: 12) {
                ForEach(options, id: \.self) { option in
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { selection.wrappedValue = option }
                    } label: {
                        Text("[ \(option) ]")
                            .font(.nmlMono(11, weight: .medium))
                            .foregroundStyle(selection.wrappedValue == option ? Color.nmlInk : Color(white: 0.27))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 18)
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5)

            HStack {
                footerButton("Sign Out Of All Devices") {
                    footerTap += 1
                    signOutAllDevices()
                }
                Spacer(minLength: 8)
                footerButton("Privacy Policy") {
                    footerTap += 1
                    open("/privacy")
                }
                Spacer(minLength: 8)
                footerButton("Get Support") {
                    footerTap += 1
                    open("/support")
                }
            }
            .padding(.top, 18)
        }
    }

    private func footerButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: .regular))
                .foregroundStyle(Color(white: 0.27)) // ~#444, melts into black
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .buttonStyle(.plain)
    }

    private func open(_ path: String) {
        guard let url = URL(string: "\(APIClient.shared.baseURL)\(path)") else { return }
        openURL(url)
    }

    private func signOutAllDevices() {
        Task {
            _ = try? await APIClient.shared.request(path: "/auth/logout-all", method: "POST")
            await MainActor.run { appState.logout() }
        }
    }
}

// MARK: - Vertical battery gauge

private struct VerticalBatteryGauge: View {
    let label: String
    let percent: Int

    private let trackHeight: CGFloat = 120
    private let width: CGFloat = 12

    private var fillColor: Color {
        percent <= 15 ? Color.nmlDanger : Color.nmlTitanium
    }

    var body: some View {
        VStack(spacing: 12) {
            Text(label)
                .font(.nmlMono(9, weight: .medium))
                .tracking(1.4)
                .foregroundStyle(Color.nmlMuted)

            ZStack(alignment: .bottom) {
                Capsule()
                    .fill(fillColor)
                    .frame(width: width, height: max(4, trackHeight * CGFloat(min(max(percent, 0), 100)) / 100))
                Capsule()
                    .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                    .frame(width: width, height: trackHeight)
            }
            .frame(width: width, height: trackHeight)

            Text("\(percent)%")
                .font(.nmlMono(11, weight: .medium))
                .foregroundStyle(Color.nmlInk)
        }
    }
}

// MARK: - Device visual

/// Placeholder for the eventual high-end 3D model / vector render of the pendant.
/// Tinted to the selected finish; tap to cycle. Swap the silhouette below for a
/// real model view (e.g. SceneKit/RealityKit or a layered vector) when ready.
private struct DeviceVisual: View {
    let finish: PendantFinish

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                VStack(spacing: -10) {
                    // Bail loop
                    Circle()
                        .strokeBorder(Color.white.opacity(0.3), lineWidth: 1.5)
                        .frame(width: 22, height: 22)
                        .zIndex(1)

                    // Core body — placeholder for the 3D render
                    RoundedRectangle(cornerRadius: 44, style: .continuous)
                        .fill(finish.gradient)
                        .overlay(
                            RoundedRectangle(cornerRadius: 44, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                        )
                        .frame(width: 92, height: 132)
                }
            }
            .frame(width: 130, height: 168)

            Text(finish.label)
                .font(.nmlMono(9, weight: .medium))
                .tracking(2)
                .foregroundStyle(Color.nmlMuted)
        }
    }
}

// MARK: - Finish

enum PendantFinish: String, CaseIterable {
    case obsidian, silver, titanium

    var label: String {
        switch self {
        case .obsidian: return "OBSIDIAN"
        case .silver: return "STERLING SILVER"
        case .titanium: return "TITANIUM"
        }
    }

    var next: PendantFinish {
        let all = PendantFinish.allCases
        let idx = all.firstIndex(of: self) ?? 0
        return all[(idx + 1) % all.count]
    }

    var gradient: LinearGradient {
        let colors: [Color]
        switch self {
        case .obsidian:
            colors = [Color(white: 0.10), Color(white: 0.04)]
        case .silver:
            colors = [Color(red: 0.86, green: 0.87, blue: 0.89), Color(red: 0.62, green: 0.64, blue: 0.67)]
        case .titanium:
            colors = [Color(red: 0.64, green: 0.66, blue: 0.69), Color(red: 0.40, green: 0.42, blue: 0.45)]
        }
        return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

#Preview {
    PendantStatusView()
        .environment(AppState())
}
