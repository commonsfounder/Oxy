import SwiftUI
import LocalAuthentication

struct VaultView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var credentials: [VaultCredentialSummary] = []
    @State private var isLoading = true
    @State private var isUnlocked = false
    @State private var errorMessage: String?
    @State private var showEntrySheet = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Vault", onBack: { dismiss() })

                    if !isUnlocked {
                        lockedState
                    } else if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 72)
                            OxySkeletonCard(height: 72)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage)
                                }
                                credentialsSection
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await authenticateAndLoad() }
            .refreshable { await loadCredentials() }
            .sheet(isPresented: $showEntrySheet) {
                VaultCredentialEntrySheet { saved in
                    credentials.removeAll { $0.site == saved.site }
                    credentials.insert(saved, at: 0)
                }
            }
        }
    }

    // MARK: - Sections

    private var lockedState: some View {
        VStack(spacing: 12) {
            Text(errorMessage ?? "Unlock with Face ID to view your saved credentials.")
                .font(.rowSecondary)
                .foregroundStyle(Color.appMuted)
                .multilineTextAlignment(.center)
            Button("Unlock") { Task { await authenticateAndLoad() } }
                .font(.rowTitle)
        }
        .padding(.horizontal, AppSpacing.margin)
        .padding(.top, 48)
    }

    private var credentialsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                AppSectionHeader(title: "Saved credentials")
                Spacer()
                Button("Add") { showEntrySheet = true }
                    .font(.rowSecondary)
            }
            .padding(.bottom, 12)

            if credentials.isEmpty {
                Text("No saved credentials. The agent will only use one when a task explicitly asks to sign in to that site.")
                    .font(.rowSecondary)
                    .foregroundStyle(Color.appMuted)
                    .padding(.vertical, 14)
            } else {
                ForEach(credentials) { credential in
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(credential.label)
                                .font(.rowTitle)
                                .foregroundStyle(Color.appInk)
                            Text("\(credential.site) · \(credential.username.isEmpty ? "no username saved" : credential.username)")
                                .font(.rowSecondary)
                                .foregroundStyle(Color.appMuted)
                        }
                        Spacer(minLength: 8)
                        Button("Remove", role: .destructive) {
                            Task { await removeCredential(credential) }
                        }
                        .font(.rowSecondary)
                    }
                    .padding(.vertical, 14)
                    .frame(minHeight: 44)
                }
            }
        }
    }

    // MARK: - Face ID gate

    private func authenticateAndLoad() async {
        let context = LAContext()
        var evalError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evalError) else {
            await MainActor.run {
                errorMessage = "Face ID isn't available on this device."
                isUnlocked = false
                isLoading = false
            }
            return
        }
        do {
            let success = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock your Vault"
            )
            await MainActor.run { isUnlocked = success }
            if success { await loadCredentials() }
        } catch {
            await MainActor.run {
                errorMessage = "Face ID unlock failed."
                isUnlocked = false
                isLoading = false
            }
        }
    }

    // MARK: - Networking

    private func loadCredentials() async {
        await MainActor.run { isLoading = true }
        do {
            let data = try await APIClient.shared.request(path: "/vault/credentials")
            let response = try JSONDecoder().decode(VaultCredentialsResponse.self, from: data)
            await MainActor.run {
                credentials = response.credentials
                errorMessage = nil
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    private func removeCredential(_ credential: VaultCredentialSummary) async {
        do {
            _ = try await APIClient.shared.request(path: "/vault/credentials/\(credential.id)", method: "DELETE")
            await MainActor.run { credentials.removeAll { $0.id == credential.id } }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
}

// MARK: - Credential entry

private struct VaultCredentialEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSaved: (VaultCredentialSummary) -> Void

    @State private var site = ""
    @State private var label = ""
    @State private var username = ""
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Site (e.g. delta.com)", text: $site)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Label (e.g. Delta SkyMiles)", text: $label)
                    TextField("Username or email", text: $username)
                        .textInputAutocapitalization(.never)
                        .textContentType(.username)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                } footer: {
                    Text("Stored encrypted. Only used when a task explicitly asks to sign in to this site, after you confirm.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add credential")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!isFormPlausible)
                    }
                }
            }
        }
    }

    private var isFormPlausible: Bool {
        !site.trimmingCharacters(in: .whitespaces).isEmpty
            && !label.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.request(
                path: "/vault/credentials",
                method: "POST",
                body: [
                    "site": site.trimmingCharacters(in: .whitespaces),
                    "label": label.trimmingCharacters(in: .whitespaces),
                    "username": username.trimmingCharacters(in: .whitespaces),
                    "password": password
                ]
            )
            let response = try JSONDecoder().decode(VaultCredentialSaveResponse.self, from: data)
            if let saved = response.credential {
                onSaved(saved)
                dismiss()
            } else {
                errorMessage = "The credential couldn't be saved."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

// MARK: - Models

struct VaultCredentialSummary: Codable, Equatable, Identifiable {
    let id: String
    let site: String
    let label: String
    let username: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, site, label, username
        case updatedAt = "updated_at"
    }
}

private struct VaultCredentialsResponse: Codable {
    let credentials: [VaultCredentialSummary]
}

private struct VaultCredentialSaveResponse: Codable {
    let saved: Bool
    let credential: VaultCredentialSummary?
}

#Preview {
    VaultView()
}
