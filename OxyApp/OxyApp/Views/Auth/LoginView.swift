import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var userId = ""
    @State private var password = ""
    @State private var isRegistering = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    private let authService = AuthService()

    var body: some View {
        ZStack {
            Color.oxyBg.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                VStack(spacing: 8) {
                    Text("Oxy")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(Color.oxyText)

                    Text("Your AI assistant")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(Color.oxyDim)
                }
                .padding(.bottom, 48)

                // Form
                VStack(spacing: 16) {
                    OxyTextField(
                        placeholder: "User ID",
                        text: $userId,
                        isSecure: false
                    )

                    OxyTextField(
                        placeholder: "Password",
                        text: $password,
                        isSecure: true
                    )

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.oxyRed)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }

                    Button(action: submit) {
                        Group {
                            if isLoading {
                                ProgressView()
                                    .tint(Color.oxyBg)
                            } else {
                                Text(isRegistering ? "Create Account" : "Log In")
                                    .font(.system(size: 14, weight: .medium))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background(Color.oxyText)
                        .foregroundStyle(Color.oxyBg)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(isLoading || userId.isEmpty || password.isEmpty)
                    .opacity(userId.isEmpty || password.isEmpty ? 0.5 : 1)

                    Button(action: { isRegistering.toggle(); errorMessage = nil }) {
                        Text(isRegistering ? "Already have an account? Log in" : "Don't have an account? Register")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.oxySub)
                    }
                }
                .padding(.horizontal, 32)

                Spacer()
                Spacer()
            }
        }
    }

    private func submit() {
        guard !userId.isEmpty, !password.isEmpty else { return }
        isLoading = true
        errorMessage = nil

        Task {
            do {
                let response: AuthResponse
                if isRegistering {
                    response = try await authService.register(userId: userId, password: password)
                } else {
                    response = try await authService.login(userId: userId, password: password)
                }

                if let token = response.token, let returnedUserId = response.userId {
                    await MainActor.run {
                        appState.login(userId: returnedUserId, token: token)
                    }
                } else {
                    await MainActor.run {
                        errorMessage = response.error ?? "Authentication failed"
                        isLoading = false
                    }
                }
            } catch let error as APIError {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }
}

// MARK: - Custom Text Field

private struct OxyTextField: View {
    let placeholder: String
    @Binding var text: String
    let isSecure: Bool

    var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        }
        .font(.system(size: 14))
        .foregroundStyle(Color.oxyText)
        .padding(.horizontal, 16)
        .frame(height: 48)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.oxyLine, lineWidth: 1)
        )
    }
}

#Preview {
    LoginView()
        .environment(AppState())
}
