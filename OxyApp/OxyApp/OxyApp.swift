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
    @State private var motionIsLive = false
    @State private var controlsVisible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let pages = [
        OxyOnboardingPage(
            imageName: "oxy_onboarding_hero",
            eyebrow: "OXY",
            title: "A personal AI you can wear.",
            subtitle: "Voice, memory, and action, close enough to be useful.",
            primaryAction: "Start",
            motion: .hero,
            imageAnchor: .center,
            baseScale: 1.06,
            drift: CGSize(width: -10, height: -18),
            glowPosition: UnitPoint(x: 0.48, y: 0.62)
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_glow",
            eyebrow: "Always With You",
            title: "The brain stays near.",
            subtitle: "Ask for what you need. Oxy keeps the thread, handles the follow-up, and moves with your day.",
            primaryAction: "Next",
            motion: .glow,
            imageAnchor: .center,
            baseScale: 1.08,
            drift: CGSize(width: 12, height: -14),
            glowPosition: UnitPoint(x: 0.48, y: 0.55)
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_anatomy",
            eyebrow: "Context",
            title: "Built to understand the back and forth.",
            subtitle: "It remembers what you meant, not just the exact words you typed.",
            primaryAction: "Next",
            motion: .signal,
            imageAnchor: .trailing,
            baseScale: 1.03,
            drift: CGSize(width: -14, height: 10),
            glowPosition: UnitPoint(x: 0.63, y: 0.23)
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_daily",
            eyebrow: "Connected",
            title: "Music, places, rides, messages, health, plans.",
            subtitle: "You choose the access. Oxy earns the trust screen by screen.",
            primaryAction: "Next",
            motion: .connected,
            imageAnchor: .center,
            baseScale: 1.04,
            drift: CGSize(width: 8, height: -12),
            glowPosition: UnitPoint(x: 0.52, y: 0.60)
        ),
        OxyOnboardingPage(
            imageName: "oxy_onboarding_sun",
            eyebrow: "Ready",
            title: "Use the app now. Pair hardware later.",
            subtitle: "When the device is ready, Oxy will become the thing you talk to without reaching for your phone.",
            primaryAction: "Continue",
            motion: .sun,
            imageAnchor: .center,
            baseScale: 1.05,
            drift: CGSize(width: -8, height: -16),
            glowPosition: UnitPoint(x: 0.47, y: 0.42)
        )
    ]

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.ignoresSafeArea()

                TabView(selection: $pageIndex) {
                    ForEach(pages.indices, id: \.self) { index in
                        OnboardingPageView(
                            page: pages[index],
                            size: geometry.size,
                            isSelected: pageIndex == index,
                            motionIsLive: motionIsLive,
                            reduceMotion: reduceMotion
                        )
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
                        .opacity(controlsVisible ? 1 : 0)
                        .offset(y: controlsVisible ? 0 : 18)
                        .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.30), value: controlsVisible)
                    }
                    .padding(.horizontal, 26)
                    .padding(.bottom, 42)
                }
                .ignoresSafeArea(edges: .top)
            }
        }
        .onAppear {
            motionIsLive = true
            controlsVisible = true
        }
        .onChange(of: pageIndex) { _, _ in
            controlsVisible = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                controlsVisible = true
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
    let isSelected: Bool
    let motionIsLive: Bool
    let reduceMotion: Bool
    @State private var copyVisible = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || !motionIsLive || !isSelected)) { context in
            let phase = CGFloat(context.date.timeIntervalSinceReferenceDate)
            let pulse = reduceMotion || !isSelected ? 0 : (sin(phase * page.motion.speed) + 1) / 2
            let drift = reduceMotion || !isSelected ? 0 : sin(phase * 0.34)

            ZStack(alignment: .bottomLeading) {
                Image(page.imageName)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
                    .scaleEffect(page.baseScale + pulse * page.motion.zoomRange, anchor: page.imageAnchor)
                    .offset(
                        x: page.drift.width * drift,
                        y: page.drift.height * drift
                    )
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

                motionOverlay(pulse: pulse, phase: phase)

                VStack(alignment: .leading, spacing: 16) {
                    Text(page.eyebrow)
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(2.2)
                        .foregroundStyle(.white.opacity(0.72))
                        .opacity(isSelected ? 1 : 0.45)

                    Text(page.title)
                        .font(.system(size: 44, weight: .light))
                        .lineSpacing(2)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                        .opacity(copyVisible && isSelected ? 1 : 0)
                        .offset(y: copyVisible && isSelected ? 0 : 22)
                        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: copyVisible)

                    Text(page.subtitle)
                        .font(.system(size: 16, weight: .regular))
                        .lineSpacing(4)
                        .foregroundStyle(.white.opacity(0.78))
                        .fixedSize(horizontal: false, vertical: true)
                        .opacity(copyVisible && isSelected ? 1 : 0)
                        .offset(y: copyVisible && isSelected ? 0 : 18)
                        .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.15), value: copyVisible)
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 210)
                .offset(y: isSelected && !reduceMotion ? -pulse * 5 : 0)
                .opacity(isSelected ? 1 : 0.72)
                .animation(.easeOut(duration: 0.45), value: isSelected)
            }
        }
        .onAppear { updateCopyVisibility() }
        .onChange(of: isSelected) { _, _ in updateCopyVisibility() }
    }

    private func updateCopyVisibility() {
        guard !reduceMotion else {
            copyVisible = isSelected
            return
        }
        copyVisible = false
        guard isSelected else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            copyVisible = true
        }
    }

    @ViewBuilder
    private func motionOverlay(pulse: CGFloat, phase: CGFloat) -> some View {
        if let glowPosition = page.glowPosition {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.cyan.opacity(0.36 + pulse * 0.18),
                            Color.cyan.opacity(0.12 + pulse * 0.12),
                            Color.clear
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: size.width * 0.34
                    )
                )
                .frame(width: size.width * 0.72, height: size.width * 0.72)
                .blur(radius: 22 + pulse * 10)
                .blendMode(.screen)
                .position(x: size.width * glowPosition.x, y: size.height * glowPosition.y)
                .allowsHitTesting(false)
        }

        switch page.motion {
        case .hero:
            LightSweepView(phase: phase, active: isSelected && !reduceMotion)
                .frame(width: size.width, height: size.height)
                .allowsHitTesting(false)
        case .signal:
            SignalTraceView(progress: traceProgress(phase))
                .stroke(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.22),
                            Color.cyan.opacity(0.92),
                            Color.white.opacity(0.16)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round)
                )
                .shadow(color: Color.cyan.opacity(0.72), radius: 18)
                .frame(width: size.width, height: size.height)
                .allowsHitTesting(false)
        case .connected:
            UtilityChipCloud(phase: phase, active: isSelected && !reduceMotion)
                .padding(.horizontal, 28)
                .padding(.bottom, 360)
                .frame(width: size.width, height: size.height, alignment: .bottomLeading)
                .allowsHitTesting(false)
        case .glow, .sun:
            EmptyView()
        }
    }

    private func traceProgress(_ phase: CGFloat) -> CGFloat {
        guard isSelected && !reduceMotion else { return 0.82 }
        let cycle = phase.truncatingRemainder(dividingBy: 3.8) / 3.8
        if cycle < 0.18 {
            return 0
        } else if cycle < 0.72 {
            return min(1, (cycle - 0.18) / 0.54)
        } else {
            return 1
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
    let motion: OxyOnboardingMotionStyle
    let imageAnchor: UnitPoint
    let baseScale: CGFloat
    let drift: CGSize
    let glowPosition: UnitPoint?
}

private enum OxyOnboardingMotionStyle {
    case hero
    case glow
    case signal
    case connected
    case sun

    var speed: CGFloat {
        switch self {
        case .hero:
            return 0.22
        case .glow:
            return 0.72
        case .signal:
            return 0.42
        case .connected:
            return 0.32
        case .sun:
            return 0.46
        }
    }

    var zoomRange: CGFloat {
        switch self {
        case .glow:
            return 0.026
        case .signal:
            return 0.018
        default:
            return 0.022
        }
    }
}

private struct SignalTraceView: Shape {
    let progress: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.width * 0.58, y: rect.height * 0.18))
        path.addCurve(
            to: CGPoint(x: rect.width * 0.66, y: rect.height * 0.38),
            control1: CGPoint(x: rect.width * 0.70, y: rect.height * 0.20),
            control2: CGPoint(x: rect.width * 0.70, y: rect.height * 0.30)
        )
        path.addCurve(
            to: CGPoint(x: rect.width * 0.58, y: rect.height * 0.62),
            control1: CGPoint(x: rect.width * 0.61, y: rect.height * 0.48),
            control2: CGPoint(x: rect.width * 0.56, y: rect.height * 0.54)
        )
        path.addCurve(
            to: CGPoint(x: rect.width * 0.70, y: rect.height * 0.84),
            control1: CGPoint(x: rect.width * 0.61, y: rect.height * 0.71),
            control2: CGPoint(x: rect.width * 0.67, y: rect.height * 0.76)
        )
        return path.trimmedPath(from: 0, to: progress)
    }
}

private struct LightSweepView: View {
    let phase: CGFloat
    let active: Bool

    var body: some View {
        let offset = active ? sin(phase * 0.42) : -1
        Rectangle()
            .fill(
                LinearGradient(
                    colors: [
                        Color.clear,
                        Color.white.opacity(0.12),
                        Color.cyan.opacity(0.18),
                        Color.clear
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(width: 180)
            .rotationEffect(.degrees(-18))
            .offset(x: offset * 160, y: -30)
            .blur(radius: 22)
            .blendMode(.screen)
            .opacity(active ? 1 : 0.35)
    }
}

private struct UtilityChipCloud: View {
    let phase: CGFloat
    let active: Bool

    private let chips = ["Music", "Places", "Rides", "Memory"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(chips.indices, id: \.self) { index in
                Text(chips[index])
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.88))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.white.opacity(0.12), in: Capsule())
                    .overlay(
                        Capsule()
                            .stroke(.white.opacity(0.16), lineWidth: 1)
                    )
                    .offset(x: CGFloat(index % 2) * 34)
                    .opacity(chipOpacity(index: index))
                    .scaleEffect(chipScale(index: index))
            }
        }
    }

    private func chipOpacity(index: Int) -> Double {
        guard active else { return 0.45 }
        let cycle = (phase + CGFloat(index) * 0.24).truncatingRemainder(dividingBy: 2.8) / 2.8
        return Double(0.5 + min(cycle * 2.2, 1) * 0.5)
    }

    private func chipScale(index: Int) -> CGFloat {
        guard active else { return 0.96 }
        let cycle = (phase + CGFloat(index) * 0.22).truncatingRemainder(dividingBy: 2.8) / 2.8
        return 0.96 + min(cycle * 2.4, 1) * 0.04
    }
}
