import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var userId = ""
    @State private var password = ""
    @State private var isRegistering = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var didAttemptAutoDemoLogin = false

    private let authService = AuthService()

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            // Straight to the sign-in form — no intro carousel, no mic slide.
            LoginFormPage(
                userId: $userId,
                password: $password,
                isRegistering: $isRegistering,
                isLoading: $isLoading,
                errorMessage: $errorMessage,
                showDemoLogin: shouldShowDemoLogin,
                onSubmit: submit,
                onDemoLogin: demoLogin
            )
        }
        .task {
            guard shouldAutoDemoLogin, !didAttemptAutoDemoLogin else { return }
            didAttemptAutoDemoLogin = true
            demoLogin()
        }
    }

    private var shouldShowDemoLogin: Bool {
        #if DEBUG
        return true
        #else
        return UserDefaults.standard.bool(forKey: "oxy_enable_local_dev_auth")
        #endif
    }

    private var shouldAutoDemoLogin: Bool {
        shouldShowDemoLogin && UserDefaults.standard.bool(forKey: "oxy_auto_demo_login")
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
                        // A warm success note as the door opens.
                        HapticManager.shared.success()
                        appState.login(userId: returnedUserId, token: token, isDemo: response.demo == true)
                    }
                } else {
                    await MainActor.run {
                        HapticManager.shared.warning()
                        withAnimation { errorMessage = response.error ?? "Authentication failed" }
                        isLoading = false
                    }
                }
            } catch {
                await MainActor.run {
                    HapticManager.shared.warning()
                    withAnimation { errorMessage = error.localizedDescription }
                    isLoading = false
                }
            }
        }
    }

    private func demoLogin() {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        Task {
            do {
                let response = try await authService.demoLogin()
                if let token = response.token, let returnedUserId = response.userId {
                    await MainActor.run {
                        HapticManager.shared.success()
                        appState.login(userId: returnedUserId, token: token, isDemo: true)
                    }
                } else {
                    await MainActor.run {
                        HapticManager.shared.warning()
                        withAnimation { errorMessage = response.error ?? "Demo login is not available on this backend." }
                        isLoading = false
                    }
                }
            } catch {
                await MainActor.run {
                    HapticManager.shared.warning()
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
    let showDemoLogin: Bool
    let onSubmit: () -> Void
    let onDemoLogin: () -> Void

    @FocusState private var focusedField: Field?
    private enum Field { case userId, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Spacer().frame(height: 96)

                Text(isRegistering ? "Create your account." : "Welcome back.")
                    .font(.appDisplay(30, weight: .light))
                    .foregroundStyle(Color.appInk)
                    .padding(.bottom, 44)

                VStack(alignment: .leading, spacing: 28) {
                    lineField(placeholder: "User ID", text: $userId, secure: false, field: .userId)
                    lineField(placeholder: "Password", text: $password, secure: true, field: .password)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Font.appBody(12, weight: .medium))
                        .foregroundStyle(Color.appDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 20)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                Button(action: onSubmit) {
                    HStack(spacing: 8) {
                        if isLoading {
                            ProgressView()
                                .tint(Color.appBackground)
                                .scaleEffect(0.8)
                        }
                        Text(isRegistering ? "Create Account" : "Sign In")
                            .font(.system(size: 14, weight: .semibold))
                            .tracking(1.5)
                    }
                    // On-ink, not pure black: contrasts with appInk in BOTH finishes (the same
                    // primary button accent. appBackground.
                    // enabled button in light mode rendered black text on a near-black fill —
                    // invisible. appBackground flips with the finish and stays legible.
                    .foregroundStyle(Color.appBackground)
                    .frame(maxWidth: .infinity)
                    .frame(height: 58)
                    .background(Color.appInk)
                    .clipShape(Capsule())
                }
                .buttonStyle(.appScale)
                .disabled(isLoading || userId.isEmpty || password.isEmpty)
                .opacity(userId.isEmpty || password.isEmpty ? 0.4 : 1)
                .animation(.appFast, value: userId.isEmpty || password.isEmpty)
                .padding(.top, 36)

                if showDemoLogin {
                    Button(action: onDemoLogin) {
                        HStack(spacing: 8) {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                                .font(.system(size: 15, weight: .medium))
                            Text("Continue as Test User")
                                .font(.system(size: 13, weight: .semibold))
                                .tracking(1.1)
                        }
                        .foregroundStyle(Color.appInk)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Color.appFillSubtle)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(Color.appHairline, lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.appScale)
                    .disabled(isLoading)
                    .opacity(isLoading ? 0.55 : 1)
                    .padding(.top, 14)

                    Text("Debug demo session")
                        .font(.system(size: 11, weight: .light))
                        .foregroundStyle(Color.appMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 8)
                }

                Button {
                    withAnimation(.appFast) { isRegistering.toggle() }
                } label: {
                    Text(isRegistering ? "Already have an account? Sign in" : "New here? Create account")
                        .font(.system(size: 13, weight: .light))
                        .foregroundStyle(Color.appMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .buttonStyle(.appScale)
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
            .foregroundStyle(Color.appInk)
            .tint(Color.appTitanium)
            .focused($focusedField, equals: field)

            Rectangle()
                .fill(focusedField == field ? Color.appInk.opacity(0.55) : Color.appFillSubtle)
                .frame(height: focusedField == field ? 1 : 0.5)
                .animation(.appFast, value: focusedField)
        }
    }
}

#Preview {
    LoginView()
        .environment(AppState())
}
