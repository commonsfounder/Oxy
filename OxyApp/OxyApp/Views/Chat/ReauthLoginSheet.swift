import SwiftUI

/// Presented from MessageBubble's "Sign in" recovery button when a task hits a login wall
/// it can't get past (reauth_login recoveryAction). Posts straight to POST
/// /browser-task/reauth-login — the credential is typed here and never touches chat or a
/// model prompt, matching the vault's existing safe pattern (see fillReauthLogin,
/// api/services/browser-task.js). On success, resumes the task the same way "Keep going"
/// already does.
struct ReauthLoginSheet: View {
    @Environment(\.dismiss) private var dismiss
    let site: String
    let onSignedIn: () -> Void

    @State private var username = ""
    @State private var password = ""
    @State private var saveToVault = true
    @State private var isSigningIn = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username or email", text: $username)
                        .textInputAutocapitalization(.never)
                        .textContentType(.username)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                } header: {
                    Text("Sign in to \(site)")
                } footer: {
                    Text("Typed straight into the site's own sign-in form — never sent through chat or seen by the model.")
                }
                Section {
                    Toggle("Save to Vault for next time", isOn: $saveToVault)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSigningIn {
                        ProgressView()
                    } else {
                        Button("Sign in") { Task { await signIn() } }
                            .disabled(!isFormPlausible)
                    }
                }
            }
        }
    }

    private var isFormPlausible: Bool {
        !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func signIn() async {
        isSigningIn = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.request(
                path: "/browser-task/reauth-login",
                method: "POST",
                body: [
                    "username": username.trimmingCharacters(in: .whitespaces),
                    "password": password,
                    "saveToVault": saveToVault,
                    "label": site
                ]
            )
            let response = try JSONDecoder().decode(ReauthLoginResponse.self, from: data)
            if response.type == "error" {
                errorMessage = response.error ?? "Sign-in failed."
            } else {
                dismiss()
                onSignedIn()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSigningIn = false
    }
}

private struct ReauthLoginResponse: Codable {
    let type: String?
    let text: String?
    let error: String?
}

#Preview {
    ReauthLoginSheet(site: "sainsburys.co.uk", onSignedIn: {})
}
