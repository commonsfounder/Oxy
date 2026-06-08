import SwiftUI

/// Device screen: a flat HARDWARE CONFIG module and a quiet footer of utility
/// links, in the Nameless language on pitch black.
struct PendantStatusView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    // Persisted hardware configuration.
    @AppStorage("nml_hw_wakeword") private var wakeword = "CHIN TILT"
    @AppStorage("nml_hw_audio") private var audioOutput = "BLE BUDS"
    @AppStorage("nml_hw_haptic") private var hapticForce = "MID"
    @State private var footerTap = 0

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        hardwareConfig
                            .padding(.top, 8)

                        footer
                            .padding(.top, 48)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 28)
                    // Mechanical-switch pulse for each config change.
                    .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: wakeword)
                    .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: audioOutput)
                    .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: hapticForce)
                    // Soft, quiet selection feedback for footer utility taps.
                    .sensoryFeedback(.selection, trigger: footerTap)
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
        }
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

#Preview {
    PendantStatusView()
        .environment(AppState())
}
