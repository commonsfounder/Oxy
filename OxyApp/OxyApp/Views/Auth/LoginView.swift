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
            Color.nmlObsidian.ignoresSafeArea()

            // Straight to the sign-in form — no intro carousel, no mic slide.
            LoginFormPage(
                userId: $userId,
                password: $password,
                isRegistering: $isRegistering,
                isLoading: $isLoading,
                errorMessage: $errorMessage,
                onSubmit: submit
            )
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
                        withAnimation { errorMessage = response.error ?? "Authentication failed" }
                        isLoading = false
                    }
                }
            } catch {
                await MainActor.run {
                    withAnimation { errorMessage = error.localizedDescription }
                    isLoading = false
                }
            }
        }
    }
}


// MARK: - Login Form Page

private struct LoginFormPage: View {
    @Binding var userId: String
    @Binding var password: String
    @Binding var isRegistering: Bool
    @Binding var isLoading: Bool
    @Binding var errorMessage: String?
    let onSubmit: () -> Void

    @FocusState private var focusedField: Field?
    private enum Field { case userId, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Spacer().frame(height: 96)

                Text(isRegistering ? "Create your account." : "Welcome back.")
                    .font(.nmlDisplay(30, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                    .padding(.bottom, 44)

                VStack(alignment: .leading, spacing: 28) {
                    lineField(placeholder: "User ID", text: $userId, secure: false, field: .userId)
                    lineField(placeholder: "Password", text: $password, secure: true, field: .password)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.nmlBody(12, weight: .medium))
                        .foregroundStyle(Color.nmlDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 20)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                Button(action: onSubmit) {
                    HStack(spacing: 8) {
                        if isLoading {
                            ProgressView()
                                .tint(Color.nmlObsidian)
                                .scaleEffect(0.8)
                        }
                        Text(isRegistering ? "Create Account" : "Sign In")
                            .font(.system(size: 14, weight: .semibold))
                            .tracking(1.5)
                    }
                    .foregroundStyle(Color.nmlObsidian)
                    .frame(maxWidth: .infinity)
                    .frame(height: 58)
                    .background(Color.nmlInk)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isLoading || userId.isEmpty || password.isEmpty)
                .opacity(userId.isEmpty || password.isEmpty ? 0.4 : 1)
                .animation(.easeInOut(duration: 0.2), value: userId.isEmpty || password.isEmpty)
                .padding(.top, 36)

                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { isRegistering.toggle() }
                } label: {
                    Text(isRegistering ? "Already have an account? Sign in" : "New here? Create account")
                        .font(.system(size: 13, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .buttonStyle(.plain)
                .padding(.top, 20)

                Spacer().frame(height: 60)
            }
            .padding(.horizontal, 28)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func lineField(placeholder: String, text: Binding<String>, secure: Bool, field: Field) -> some View {
        VStack(spacing: 9) {
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .font(.system(size: 16, weight: .light))
            .foregroundStyle(Color.nmlInk)
            .tint(Color.nmlTitanium)
            .focused($focusedField, equals: field)

            Rectangle()
                .fill(focusedField == field ? Color.nmlInk.opacity(0.55) : Color.white.opacity(0.08))
                .frame(height: focusedField == field ? 1 : 0.5)
                .animation(.easeInOut(duration: 0.2), value: focusedField)
        }
    }
}

#Preview {
    LoginView()
        .environment(AppState())
}
