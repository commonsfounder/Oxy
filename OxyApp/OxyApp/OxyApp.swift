import SwiftUI

@main
struct OxyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    @AppStorage("oxy_appTheme") private var appTheme = "dark"

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(preferredColorScheme)
                .tint(Color.oxyStone)
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch appTheme {
        case "light":
            return .light
        case "system":
            return nil
        default:
            return .dark
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_hasCompletedOnboarding") private var hasCompletedOnboarding = false

    var body: some View {
        Group {
            if appState.isAuthenticated {
                MainTabView()
            } else if hasCompletedOnboarding {
                LoginView()
            } else {
                OnboardingView {
                    hasCompletedOnboarding = true
                }
            }
        }
        .animation(.easeInOut(duration: 0.35), value: appState.isAuthenticated)
        .animation(.easeInOut(duration: 0.35), value: hasCompletedOnboarding)
        .task {
            appState.restoreSession()
        }
    }
}

private struct OnboardingView: View {
    let onFinish: () -> Void
    @State private var pageIndex = 0

    private let pages = [
        OxyOnboardingPage(
            imageName: "oxy_onboarding_hero",
            eyebrow: "OXY",
            title: "A personal AI you can wear.",
            subtitle: "Voice, memory, and action, close enough to be useful.",
            primaryAction: "Start"
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_glow",
            eyebrow: "Always With You",
            title: "The brain stays near.",
            subtitle: "Ask for what you need. Oxy keeps the thread, handles the follow-up, and moves with your day.",
            primaryAction: "Next"
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_anatomy",
            eyebrow: "Context",
            title: "Built to understand the back and forth.",
            subtitle: "It remembers what you meant, not just the exact words you typed.",
            primaryAction: "Next"
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_daily",
            eyebrow: "Connected",
            title: "Music, places, rides, messages, health, plans.",
            subtitle: "You choose the access. Oxy earns the trust screen by screen.",
            primaryAction: "Next"
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_sun",
            eyebrow: "Ready",
            title: "Use the app now. Pair hardware later.",
            subtitle: "When the device is ready, Oxy will become the thing you talk to without reaching for your phone.",
            primaryAction: "Continue"
        )
    ]

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.ignoresSafeArea()

                TabView(selection: $pageIndex) {
                    ForEach(pages.indices, id: \.self) { index in
                        OnboardingPageView(page: pages[index], size: geometry.size)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .ignoresSafeArea()

                VStack {
                    HStack {
                        Text(pageIndex == 0 ? "Oxy" : pages[pageIndex].eyebrow)
                            .font(.system(size: pageIndex == 0 ? 34 : 13, weight: pageIndex == 0 ? .medium : .semibold))
                            .tracking(pageIndex == 0 ? 0 : 2.4)
                            .foregroundStyle(.white)

                        Spacer()

                        Button("Skip") {
                            onFinish()
                        }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.82))
                    }
                    .padding(.horizontal, 32)
                    .padding(.top, 68)

                    Spacer()

                    VStack(spacing: 22) {
                        PageDots(count: pages.count, currentIndex: pageIndex)

                        VStack(spacing: 12) {
                            Button {
                                advance()
                            } label: {
                                Text(pages[pageIndex].primaryAction)
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(Color.black)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 62)
                                    .background(Color.white)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)

                            Button {
                                if pageIndex == pages.count - 1 {
                                    onFinish()
                                } else {
                                    withAnimation(.easeInOut(duration: 0.35)) {
                                        pageIndex = pages.count - 1
                                    }
                                }
                            } label: {
                                Text(pageIndex == pages.count - 1 ? "I do not have hardware yet" : "Explore")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 58)
                                    .overlay(
                                        Capsule()
                                            .stroke(.white.opacity(0.72), lineWidth: 1.2)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 26)
                    .padding(.bottom, 42)
                }
                .ignoresSafeArea(edges: .top)
            }
        }
    }

    private func advance() {
        if pageIndex >= pages.count - 1 {
            onFinish()
            return
        }
        withAnimation(.easeInOut(duration: 0.35)) {
            pageIndex += 1
        }
    }
}

private struct OnboardingPageView: View {
    let page: OxyOnboardingPage
    let size: CGSize

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Image(page.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height)
                .clipped()
                .overlay(
                    LinearGradient(
                        stops: [
                            .init(color: .black.opacity(0.18), location: 0.0),
                            .init(color: .black.opacity(0.05), location: 0.36),
                            .init(color: .black.opacity(0.68), location: 0.74),
                            .init(color: .black.opacity(0.88), location: 1.0)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    LinearGradient(
                        colors: [.black.opacity(0.34), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )

            VStack(alignment: .leading, spacing: 16) {
                Text(page.eyebrow)
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2.2)
                    .foregroundStyle(.white.opacity(0.72))

                Text(page.title)
                    .font(.system(size: 44, weight: .light))
                    .lineSpacing(2)
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)

                Text(page.subtitle)
                    .font(.system(size: 16, weight: .regular))
                    .lineSpacing(4)
                    .foregroundStyle(.white.opacity(0.78))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 210)
        }
    }
}

private struct PageDots: View {
    let count: Int
    let currentIndex: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == currentIndex ? Color.white : Color.white.opacity(0.32))
                    .frame(width: index == currentIndex ? 28 : 8, height: 8)
                    .animation(.easeInOut(duration: 0.22), value: currentIndex)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct OxyOnboardingPage {
    let imageName: String
    let eyebrow: String
    let title: String
    let subtitle: String
    let primaryAction: String
}
