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
    @State private var statusAction: AccountAction?
    private enum AccountAction { case export, signOut, delete }
    private var isBusy: Bool { isExportingData || isDeletingAccount || isSigningOutAll }
    @State private var sharePayload: SharePayload?

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Account", onBack: { dismiss() })
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            identityRow(label: "Account ID", value: appState.userId)

                            section(title: "Your data") {
                                actionRow(
                                    label: isExportingData ? "Preparing export…" : "Export data",
                                    action: exportMyData
                                )
                                .disabled(isBusy)
                                status(for: .export)
                                SettingsRule()
                                actionRow(label: "Import from ChatGPT or Claude", action: { showsImport = true })
                                    .disabled(isBusy)
                            }

                            section(title: "Help and policies") {
                                legalLink(label: "Support", path: "/support")
                                SettingsRule()
                                legalLink(label: "Privacy Policy", path: "/privacy")
                                SettingsRule()
                                legalLink(label: "Terms of Use", path: "/terms")
                            }

                            section(title: "Sign out") {
                                actionRow(label: "Sign out", action: { showSignOutConfirm = true })
                                    .disabled(isBusy)
                                SettingsRule()
                                actionRow(
                                    label: isSigningOutAll ? "Signing out…" : "Sign out of all devices",
                                    action: { showSignOutAllConfirm = true }
                                )
                                .disabled(isBusy)
                                status(for: .signOut)
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                actionRow(
                                    label: isDeletingAccount ? "Deleting account…" : "Delete account",
                                    destructive: true,
                                    action: { showDeleteAccountConfirm = true }
                                )
                                .disabled(isBusy)
                                status(for: .delete)
                            }


                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 12)
                        .padding(.bottom, 40)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            #if DEBUG
            .task {
                guard PreviewData.isIsolated, let state = ProcessInfo.processInfo.environment["OXY_DEBUG_ACCOUNT"] else { return }
                try? await Task.sleep(for: .milliseconds(900))
                switch state {
                case "delete": showDeleteAccountConfirm = true
                case "signout": showSignOutConfirm = true
                case "signout-all": showSignOutAllConfirm = true
                case "export-failure":
                    statusAction = .export
                    accountStatusText = "Couldn't export your data. Try again."
                case "import": showsImport = true
                default: break
                }
            }
            #endif
            .fullScreenCover(isPresented: $showsImport) {
                AgentContinuityView().swipeToDismiss().environment(\.colorScheme, colorScheme)
            }
            .alert("Sign out", isPresented: $showSignOutConfirm) {
                Button("Sign out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You can sign in again with the same account.")
            }
            .alert("Sign out of all devices", isPresented: $showSignOutAllConfirm) {
                Button("Sign out everywhere", role: .destructive) { signOutAllDevices() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need to sign in again on every device, including this one.")
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

    @ViewBuilder
    private func status(for action: AccountAction) -> some View {
        if statusAction == action, let accountStatusText {
            Text(accountStatusText)
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 10)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private func identityRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.appBody(14)).foregroundStyle(Color.appMuted)
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
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
        guard !isBusy else { return }
        statusAction = .export
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
                    accountStatusText = "Couldn't export your data. Try again."
                }
            }
        }
    }

    private func signOutAllDevices() {
        guard !isBusy else { return }
        statusAction = .signOut
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
                    accountStatusText = "Couldn't sign out all devices. Try again."
                }
            }
        }
    }

    private func deleteAccount() {
        guard !isBusy else { return }
        statusAction = .delete
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
                    accountStatusText = "Couldn't delete your account. Try again."
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
