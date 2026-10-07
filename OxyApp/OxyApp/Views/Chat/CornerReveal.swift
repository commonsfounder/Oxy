import SwiftUI

private struct RevealCloseKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Set while a screen is open from the menu button; calling it pulls the screen back into the button.
    var revealClose: (() -> Void)? {
        get { self[RevealCloseKey.self] }
        set { self[RevealCloseKey.self] = newValue }
    }
}

/// Ways the screen can leave the button. Kept switchable (Preferences > Opening style) until one is chosen.
enum RevealStyle: String, CaseIterable, Identifiable {
    case bounce, swing, ripple, drop
    var id: String { rawValue }
    static let storageKey = "adam_reveal_style"

    var title: String {
        switch self {
        case .bounce: return "Bounce"
        case .swing: return "Swing"
        case .ripple: return "Ripple"
        case .drop: return "Drop"
        }
    }
}

/// A screen the menu button throws open from the top right. The screen is drawn once at full size and only
/// scaled, moved, turned or revealed, so the opening stays smooth even while the screen is still loading.
struct CornerReveal<Content: View>: View {
    /// The button's centre in the overlay's own coordinates.
    let origin: CGPoint
    var incognito = false
    var onClosed: () -> Void
    @ViewBuilder var content: () -> Content

    @AppStorage(RevealStyle.storageKey) private var styleRaw = RevealStyle.bounce.rawValue
    @State private var out = false
    @State private var closing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var style: RevealStyle { RevealStyle(rawValue: styleRaw) ?? .bounce }

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack {
                Color.black.opacity(out ? 0.12 : 0)
                    .allowsHitTesting(false)

                card(size)
                    .allowsHitTesting(out && !closing)

                WheelHub(progress: out ? 1 : 0, incognito: incognito)
                    .position(origin)
                    .onTapGesture(perform: close)
                    .accessibilityLabel("Close")
                    .accessibilityAddTraits(.isButton)
            }
        }
        .ignoresSafeArea()
        .task {
            // Let the screen build itself while it is still out of sight, so building never lands inside the motion.
            try? await Task.sleep(for: .milliseconds(80))
            open()
        }
    }

    /// The phone's own safe-area insets: the overlay runs edge to edge, so the screen is given them back.
    private static var insets: EdgeInsets {
        let raw = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets }.first ?? .zero
        return EdgeInsets(top: raw.top, leading: raw.left, bottom: raw.bottom, trailing: raw.right)
    }

    private var screen: some View {
        ZStack {
            Color.appBackground
            content()
                .environment(\.revealClose, close)
                .transaction(value: out) { $0.animation = nil }
                .safeAreaPadding(Self.insets)
        }
    }

    @ViewBuilder
    private func card(_ size: CGSize) -> some View {
        if reduceMotion {
            screen.opacity(out ? 1 : 0)
        } else {
            switch style {
            case .bounce:
                screen
                    .opacity(out ? 1 : 0)
                    .animation(.easeOut(duration: 0.08), value: out)
                    .clipShape(RoundedRectangle(cornerRadius: out ? 52 : 300, style: .continuous))
                    .scaleEffect(out ? 1 : 0.05, anchor: UnitPoint(x: origin.x / max(size.width, 1), y: origin.y / max(size.height, 1)))
            case .swing:
                screen
                    .clipShape(RoundedRectangle(cornerRadius: 52, style: .continuous))
                    .rotationEffect(.degrees(out ? 0 : 100), anchor: .topTrailing)
            case .ripple:
                let reach = max(hypot(origin.x, origin.y), hypot(size.width - origin.x, origin.y),
                                hypot(origin.x, size.height - origin.y), hypot(size.width - origin.x, size.height - origin.y))
                screen
                    .mask {
                        Circle()
                            .frame(width: reach * 2, height: reach * 2)
                            .scaleEffect(out ? 1 : 0.02)
                            .position(origin)
                            .ignoresSafeArea()
                    }
            case .drop:
                screen
                    .clipShape(RoundedRectangle(cornerRadius: 52, style: .continuous))
                    .offset(y: out ? 0 : -(size.height + 80))
            }
        }
    }

    private func open() {
        if reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) { out = true }
            return
        }
        switch style {
        case .bounce: withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) { out = true }
        case .swing: withAnimation(.spring(response: 0.55, dampingFraction: 0.62)) { out = true }
        case .ripple: withAnimation(.spring(response: 0.5, dampingFraction: 1)) { out = true }
        case .drop: withAnimation(.spring(response: 0.46, dampingFraction: 0.86)) { out = true }
        }
    }

    private func close() {
        guard !closing else { return }
        closing = true
        HapticManager.shared.impact(.light)
        withAnimation(reduceMotion ? .easeIn(duration: 0.15) : .spring(response: 0.3, dampingFraction: 1)) { out = false }
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 170 : 320))
            onClosed()
        }
    }
}
