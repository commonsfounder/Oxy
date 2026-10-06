import SwiftUI
import UIKit

/// Account details and data actions.
struct ProfileView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var showsImport = false

    @State private var showSignOutConfirm = false
    @State private var showSignOutAllConfirm = false
    @State private var showDeleteAccountConfirm = false
    @State private var isExportingData = false
    @State private var isDeletingAccount = false
    @State private var isSigningOutAll = false
    @State private var accountStatusText: String?
    @State private var sharePayload: SharePayload?

    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Account", onBack: { dismiss() })
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            SettingsList {
                                identityRow(label: "Account ID", value: appState.userId)
                            }

                            section(title: "Your data") {
                                actionRow(
                                    label: isExportingData ? "Preparing export…" : "Export my data",
                                    action: exportMyData
                                )
                                .disabled(isExportingData || isDeletingAccount)
                            }

                            section(title: "Import and help") {
                                actionRow(label: "Import from ChatGPT or Claude", action: { showsImport = true })
                                SettingsRule()
                                legalLink(label: "Support", path: "/support")
                                SettingsRule()
                                legalLink(label: "Privacy Policy", path: "/privacy")
                                SettingsRule()
                                legalLink(label: "Terms of Use", path: "/terms")
                            }

                            section(title: "Sign out and delete") {
                                actionRow(
                                    label: "Sign out",
                                    action: { showSignOutConfirm = true }
                                )

                                SettingsRule()

                                actionRow(
                                    label: isSigningOutAll ? "Signing out…" : "Sign out of all devices",
                                    action: { showSignOutAllConfirm = true }
                                )
                                .disabled(isSigningOutAll)

                                SettingsRule()

                                actionRow(
                                    label: isDeletingAccount ? "Deleting account…" : "Delete account",
                                    destructive: true,
                                    action: { showDeleteAccountConfirm = true }
                                )
                                .disabled(isExportingData || isDeletingAccount)

                                if let accountStatusText {
                                    SettingsRule()
                                    Text(accountStatusText)
                                        .font(.appBody(12, weight: .regular))
                                        .foregroundStyle(Color.appMuted)
                                        .lineSpacing(3)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, 14)
                                }
                            }

                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 12)
                        .padding(.bottom, 40)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .fullScreenCover(isPresented: $showsImport) {
                AgentContinuityView().swipeToDismiss().environment(\.colorScheme, colorScheme)
            }
            .alert("Sign out", isPresented: $showSignOutConfirm) {
                Button("Sign out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
            .alert("Sign out of all devices", isPresented: $showSignOutAllConfirm) {
                Button("Sign out everywhere", role: .destructive) { signOutAllDevices() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will invalidate all active sessions on every device. You will be signed out here too.")
            }
            .alert("Delete account", isPresented: $showDeleteAccountConfirm) {
                Button("Delete", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your account data, including chats, memories, connected apps, preferences and history.")
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(activityItems: [payload.url])
            }
        }
    }

    // MARK: - Rows

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        SettingsGroup(title: title) { SettingsList { content() } }
    }

    private func legalLink(label: String, path: String) -> some View {
        SettingsRow(title: label, action: {
            guard let url = URL(string: "\(APIClient.shared.baseURL)\(path)") else { return }
            UIApplication.shared.open(url)
        }) {
            AppIcon("arrow-up-right", size: 12).foregroundStyle(Color.appMuted)
        }
    }

    private func identityRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(Color.appInk)
            Spacer(minLength: 16)
            Text(value)
                .font(.appMono(12))
                .foregroundStyle(Color.appMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(minHeight: 50)
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
                    .font(.appBody(15, weight: .medium))
                Spacer()
                AppIcon("chevron-right", size: 12)
                    .foregroundStyle(Color.appMuted)
            }
            .foregroundStyle(destructive ? Color.appDestructive : Color.appInk)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.98))
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
                    accountStatusText = "Couldn't export your data: \(error.localizedDescription)"
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
                    accountStatusText = "Couldn't sign out all devices: \(error.localizedDescription)"
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
                    accountStatusText = "Couldn't delete your account: \(error.localizedDescription)"
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
