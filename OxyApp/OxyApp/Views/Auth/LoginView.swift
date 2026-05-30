import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var page = 0
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
                TabView(selection: $page) {
                    OnboardingSlide(
                        icon: "mic.fill",
                        subIcon: "waveform",
                        title: "Ask Oxy",
                        content: "Messages, bookings, reminders\n— just say it."
                    )
                    .tag(0)

                    OnboardingSlide(
                        icon: "arrow.triangle.branch",
                        subIcon: nil,
                        title: "Connected",
                        content: "Gmail, Telegram, Uber and more\n— one request, done."
                    )
                    .tag(1)

                    OnboardingSlide(
                        icon: "brain.head.profile",
                        subIcon: nil,
                        title: "Remembers you",
                        content: "Gets better\nthe more you use it."
                    )
                    .tag(2)

                    LoginFormPage(
                        userId: $userId,
                        password: $password,
                        isRegistering: $isRegistering,
                        isLoading: $isLoading,
                        errorMessage: $errorMessage,
                        onSubmit: submit
                    )
                    .tag(3)
                }
                .tabViewStyle(.page(indexDisplayMode: page < 3 ? .always : .never))
                .animation(.easeInOut, value: page)

                if page < 3 {
                    Button(action: { withAnimation { page = min(page + 1, 3) } }) {
                        Text(page == 2 ? "Get Started" : "Next")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .background(Color.oxyStone)
                            .foregroundStyle(Color.oxyOnAccent)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                    .padding(.horizontal, 28)
                    .padding(.bottom, 48)
                    .transition(.opacity)
                }
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

// MARK: - Onboarding Slide

private struct OnboardingSlide: View {
    let icon: String
    let subIcon: String?
    let title: String
    let content: String

    var body: some View {
        VStack(spacing: 36) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.oxyStone.opacity(0.1))
                    .frame(width: 148, height: 148)

                VStack(spacing: 10) {
                    Image(systemName: icon)
                        .font(.system(size: 54, weight: .semibold))
                        .foregroundStyle(Color.oxyStone)

                    if let subIcon {
                        Image(systemName: subIcon)
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(Color.oxyStone.opacity(0.55))
                    }
                }
            }

            VStack(spacing: 14) {
                Text(title)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.oxyText)

                Text(content)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.oxySub)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }

            Spacer()
            Spacer()
        }
        .padding(.horizontal, 36)
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

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer().frame(height: 72)

                Text("Oxy")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.oxyText)
                    .padding(.bottom, 48)

                VStack(spacing: 16) {
                    VStack(spacing: 12) {
                        HStack(spacing: 12) {
                            Image(systemName: "person.fill")
                                .font(.system(size: 15))
                                .foregroundStyle(Color.oxySub)
                                .frame(width: 20)

                            TextField("User ID", text: $userId)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .font(.system(size: 15))
                                .foregroundStyle(Color.oxyText)
                        }
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .background(Color.oxySurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.oxyLine2, lineWidth: 1)
                        )

                        HStack(spacing: 12) {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 15))
                                .foregroundStyle(Color.oxySub)
                                .frame(width: 20)

                            SecureField("Password", text: $password)
                                .font(.system(size: 15))
                                .foregroundStyle(Color.oxyText)
                        }
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .background(Color.oxySurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.oxyLine2, lineWidth: 1)
                        )
                    }

                    if let errorMessage {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.oxyRed)
                            Text(errorMessage)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.oxyRed)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    Button(action: onSubmit) {
                        HStack(spacing: 8) {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                                    .scaleEffect(0.85)
                            } else {
                                Text(isRegistering ? "Create Account" : "Sign In")
                                    .font(.system(size: 16, weight: .semibold))
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 14, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(
                            LinearGradient(
                                colors: [Color.oxyStone, Color.oxyStone.opacity(0.85)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .foregroundStyle(Color.oxyOnAccent)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .shadow(color: Color.oxyStone.opacity(0.3), radius: 8, y: 4)
                    }
                    .disabled(isLoading || userId.isEmpty || password.isEmpty)
                    .opacity(userId.isEmpty || password.isEmpty ? 0.6 : 1)
                    .animation(.easeInOut(duration: 0.2), value: userId.isEmpty || password.isEmpty)

                    Button(action: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            isRegistering.toggle()
                        }
                    }) {
                        Text(isRegistering ? "Already have an account? **Sign in**" : "New to Oxy? **Create account**")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.oxySub)
                    }
                }
                .padding(.horizontal, 28)

                Spacer().frame(height: 60)
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

#Preview {
    LoginView()
        .environment(AppState())
}
