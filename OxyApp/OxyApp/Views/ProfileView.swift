import SwiftUI
import UIKit

/// The account home in the Nameless language — pitch black, flat rows split by
/// 0.5px rules. Identity at the top (editable assistant name + read-only account
/// id), then the account lifecycle actions (export, sign out, delete) that used
/// to be scattered across Settings and the Pendant screen.
struct ProfileView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var settings = OxySettings()

    @State private var showSignOutConfirm = false
    @State private var showSignOutAllConfirm = false
    @State private var showDeleteAccountConfirm = false
    @State private var isExportingData = false
    @State private var isDeletingAccount = false
    @State private var isSigningOutAll = false
    @State private var accountStatusText: String?
    @State private var sharePayload: SharePayload?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Account", onBack: { dismiss() })
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            // Identity
                            section(title: "Identity") {
                                HStack {
                                    Text("Assistant Name")
                                        .font(.system(size: 15, weight: .regular))
                                        .foregroundStyle(Color.nmlInk)
                                    Spacer(minLength: 16)
                                    TextField("Nameless", text: $settings.name)
                                        .font(.system(size: 15, weight: .light))
                                        .foregroundStyle(Color.nmlInk)
                                        .tint(Color.nmlTitanium)
                                        .multilineTextAlignment(.trailing)
                                        .onChange(of: settings.name) { _, _ in saveSettings() }
                                }
                                .padding(.vertical, 18)

                                NamelessDivider()

                                identityRow(label: "Account ID", value: appState.userId)

                                NamelessDivider()

                                identityRow(label: "Status", value: "Active")
                            }

                            // Account lifecycle
                            section(title: "Account") {
                                actionRow(
                                    label: isExportingData ? "Preparing Export…" : "Export My Data",
                                    action: exportMyData
                                )
                                .disabled(isExportingData || isDeletingAccount)

                                NamelessDivider()

                                actionRow(
                                    label: "Sign Out",
                                    destructive: true,
                                    action: { showSignOutConfirm = true }
                                )

                                NamelessDivider()

                                actionRow(
                                    label: isSigningOutAll ? "Signing Out…" : "Sign Out All Devices",
                                    destructive: true,
                                    action: { showSignOutAllConfirm = true }
                                )
                                .disabled(isSigningOutAll)

                                NamelessDivider()

                                actionRow(
                                    label: isDeletingAccount ? "Deleting Account…" : "Delete Account",
                                    destructive: true,
                                    action: { showDeleteAccountConfirm = true }
                                )
                                .disabled(isExportingData || isDeletingAccount)

                                if let accountStatusText {
                                    NamelessDivider()
                                    Text(accountStatusText)
                                        .font(.system(size: 12, weight: .light))
                                        .foregroundStyle(Color.nmlMuted)
                                        .lineSpacing(3)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, 14)
                                }
                            }
                        }
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 40)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear(perform: loadSettings)
            .alert("Sign Out", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
            .alert("Sign Out All Devices", isPresented: $showSignOutAllConfirm) {
                Button("Sign Out All", role: .destructive) { signOutAllDevices() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will invalidate all active sessions on every device. You will be signed out here too.")
            }
            .alert("Delete Account", isPresented: $showDeleteAccountConfirm) {
                Button("Delete", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your account data, including conversations, memories, connectors, preferences, and action history.")
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(activityItems: [payload.url])
            }
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.startLocation.x < 60, value.translation.width > 80 {
                            dismiss()
                        }
                    }
            )
        }
    }

    // MARK: - Rows

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: title)
                .padding(.bottom, 10)
            VStack(spacing: 0) { content() }
        }
    }

    private func identityRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Spacer(minLength: 16)
            Text(value)
                .font(.nmlMono(12))
                .foregroundStyle(Color.nmlMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 18)
    }

    private func actionRow(
        label: String,
        destructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: .regular))
                Spacer()
                Text("›")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .foregroundStyle(destructive ? Color.nmlDanger : Color.nmlInk)
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Settings persistence

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
    }

    private func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
        Task {
            await NativeIntegrationManager.shared.syncNativeContext(userId: appState.userId)
        }
    }

    // MARK: - Account actions

    private func exportMyData() {
        guard !isExportingData else { return }
        accountStatusText = nil
        isExportingData = true
        Task {
            do {
                let data = try await APIClient.shared.exportUserData(userId: appState.userId)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("oxy-data-export-\(Int(Date().timeIntervalSince1970)).json")
                try data.write(to: url, options: .atomic)
                await MainActor.run {
                    isExportingData = false
                    sharePayload = SharePayload(url: url)
                    accountStatusText = "Export ready."
                }
            } catch {
                await MainActor.run {
                    isExportingData = false
                    accountStatusText = "Could not export your data: \(error.localizedDescription)"
                }
            }
        }
    }

    private func signOutAllDevices() {
        guard !isSigningOutAll else { return }
        accountStatusText = nil
        isSigningOutAll = true
        Task {
            do {
                _ = try await APIClient.shared.request(path: "/auth/logout-all", method: "POST")
                await MainActor.run {
                    isSigningOutAll = false
                    appState.logout()
                }
            } catch {
                await MainActor.run {
                    isSigningOutAll = false
                    accountStatusText = "Could not sign out all devices: \(error.localizedDescription)"
                }
            }
        }
    }

    private func deleteAccount() {
        guard !isDeletingAccount else { return }
        accountStatusText = nil
        isDeletingAccount = true
        Task {
            do {
                try await APIClient.shared.deleteAccount(userId: appState.userId)
                await MainActor.run {
                    isDeletingAccount = false
                    appState.logout()
                }
            } catch {
                await MainActor.run {
                    isDeletingAccount = false
                    accountStatusText = "Could not delete your account: \(error.localizedDescription)"
                }
            }
        }
    }
}

// MARK: - Share sheet

struct SharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

struct ShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

#Preview {
    ProfileView()
        .environment(AppState())
}
