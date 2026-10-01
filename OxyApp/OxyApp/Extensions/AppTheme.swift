import SwiftUI
import UIKit

// MARK: - Color tokens

private func appDynamicColor(dark: Color, light: Color) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
}

extension Color {
    static let appBackground = Color(UIColor { trait in
        if let chosen = ThreadBackground.current.uiColor { return chosen }
        return trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.035, green: 0.035, blue: 0.035, alpha: 1)   // #090909
            : UIColor(red: 0.965, green: 0.976, blue: 0.992, alpha: 1)   // #F6F9FD
    })

    static let appSurface = appDynamicColor(
        dark: Color(red: 0.082, green: 0.082, blue: 0.082),   // #151515
        light: Color.white
    )

    static let appSurface2 = appDynamicColor(
        dark: Color(red: 0.114, green: 0.114, blue: 0.114),   // #1D1D1D
        light: Color(red: 0.945, green: 0.945, blue: 0.937)   // #F1F1EF
    )

    static let appHairline = appDynamicColor(
        dark: Color.white.opacity(0.08),
        light: Color.black.opacity(0.07)
    )

    static let appInk = appDynamicColor(
        dark: Color(red: 0.961, green: 0.961, blue: 0.961),   // #F5F5F5
        light: Color(red: 0.067, green: 0.067, blue: 0.067)   // #111111
    )

    static let appMuted = appDynamicColor(
        dark: Color(red: 0.580, green: 0.580, blue: 0.580),
        light: Color(red: 0.420, green: 0.420, blue: 0.420)
    )

    static let appAccent = appDynamicColor(
        dark: Color(red: 0.302, green: 0.557, blue: 1.000),   // #4D8EFF
        light: Color(red: 0.075, green: 0.369, blue: 0.882)   // #135EE1
    )

    /// The two accents sit on opposite sides of mid-luminance, so a single fixed
    /// foreground can't serve both: near-black on the light-mode antique gold is
    /// 3.5:1. Pairing each accent with its own ink gives 7.8:1 dark / 5.0:1 light.
    static let appOnAccent = appDynamicColor(
        dark: Color.white,
        light: Color.white
    )

    // MARK: - Semantic (for trust and safety)
    static let appSuccess = appDynamicColor(
        dark: Color(red: 0.30, green: 0.75, blue: 0.50),
        light: Color(red: 0.11, green: 0.52, blue: 0.32)
    )
    static let appWarning = appDynamicColor(
        dark: Color(red: 0.95, green: 0.70, blue: 0.25),
        light: Color(red: 0.72, green: 0.48, blue: 0.05)
    )
    static let appAttention = appWarning
    static let appLive = appDynamicColor(
        dark: Color(red: 0.20, green: 0.85, blue: 0.55),
        light: Color(red: 0.08, green: 0.58, blue: 0.36)
    )

    static let appScrim = Color.black.opacity(0.5)
    static let appFillSubtle = appDynamicColor(dark: Color.white.opacity(0.08), light: Color.black.opacity(0.06))
    static let appFillScrim = appScrim
    static let appObsidian = appBackground
    static let appTitanium = appMuted

    /// The user's own messages: the strongest surface, like a sent message.
    static let appUserBubble = appInk

    /// Adam's side of the conversation: message bubbles and cards.
    static let appReceivedBubble = appDynamicColor(
        dark: Color(red: 0.137, green: 0.149, blue: 0.172),   // #23262C
        light: Color(red: 0.914, green: 0.925, blue: 0.945)   // #E9ECF1
    )

    // MARK: - Roles (thread and cards)
    /// The strongest surface against the current background: the button to press.
    static let appAction = appInk
    /// Text on `appAction`.
    static let appOnAction = appBackground
    /// Adam is doing something (progress, live watches).
    static let appWorking = appAccent
    /// Something is waiting on the user.
    static let appNeedsYou = appWarning
    /// Finished.
    static let appDone = appSuccess
    /// Thin outline for thread cards.
    static let appCardOutline = appDynamicColor(
        dark: Color.white.opacity(0.14),
        light: Color(red: 0.063, green: 0.090, blue: 0.129).opacity(0.13)
    )
}

// MARK: - Spacing
enum AppSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let chatMargin: CGFloat = 20
    static let margin: CGFloat = 20
}

extension Font {
    static var screenTitle: Font { .appBody(20, weight: .semibold) }
    static var rowTitle: Font    { .appBody(16, weight: .regular) }
    static var rowSecondary: Font { .appBody(13, weight: .regular) }
    static func heroDisplay(_ size: CGFloat = 30) -> Font { .appEditorial(size) }
}

// MARK: - Radius
enum AppRadius {
    static let sm: CGFloat = 10
    static let md: CGFloat = 10
    static let lg: CGFloat = 18
    static let xl: CGFloat = 24
    static let bubble: CGFloat = 18
    static let card: CGFloat = 18
}

// MARK: - Motion
extension Animation {
    static let appFast     = Animation.spring(response: 0.15, dampingFraction: 1.0)
    static let appStandard = Animation.spring(response: 0.22, dampingFraction: 1.0)
    static let appRelax    = Animation.spring(response: 0.4,  dampingFraction: 1.0)
    static let appSpring   = Animation.spring(response: 0.28, dampingFraction: 1.0)
    static let appMomentum = Animation.spring(response: 0.3,  dampingFraction: 0.8)
    static let appExpand   = Animation.spring(response: 0.42, dampingFraction: 0.82)
    static let appToggle   = Animation.easeInOut(duration: 0.18)
}

// MARK: - Interaction
extension View {
    func appScale(_ amount: CGFloat = 0.96) -> some View {
        buttonStyle(AppScaleButtonStyle(amount: amount))
    }
}

struct AppScaleButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var amount: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? amount : 1)
            .animation(reduceMotion ? nil : .appFast, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == AppScaleButtonStyle {
    static var appScale: AppScaleButtonStyle { .init() }
    static func appScale(_ amount: CGFloat) -> AppScaleButtonStyle { .init(amount: amount) }
}

private struct AppEntranceModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let appeared: Bool
    let riseOffset: CGFloat
    let delay: Double

    func body(content: Content) -> some View {
        content
            .opacity(appeared ? 1 : 0)
            .offset(y: reduceMotion ? 0 : (appeared ? 0 : riseOffset))
            .animation(
                reduceMotion ? .easeInOut(duration: 0.2).delay(delay) : .appSpring.delay(delay),
                value: appeared
            )
    }
}

extension View {
    func appEntrance(_ appeared: Bool, riseOffset: CGFloat = 14, delay: Double = 0) -> some View {
        modifier(AppEntranceModifier(appeared: appeared, riseOffset: riseOffset, delay: delay))
    }

    func appHeroTracking(_ size: CGFloat) -> some View {
        tracking(-size * 0.02)
    }
}

extension View {
    func appGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        background {
            shape.fill((tint ?? Color.appSurface2).opacity(0.35))
        }
        .background(.ultraThinMaterial, in: shape)
        .overlay(shape.strokeBorder(
            Color.appAdaptive(dark: .white, light: .black).opacity(interactive ? 0.16 : 0.08),
            lineWidth: 0.5
        ))
    }
}

extension Color {
    static func appAdaptive(dark: Color, light: Color) -> Color { appDynamicColor(dark: dark, light: light) }
}

// MARK: - Typography

private func appUIFontWeight(_ w: Font.Weight) -> UIFont.Weight {
    let map: [Font.Weight: UIFont.Weight] = [
        .ultraLight: .ultraLight, .thin: .thin, .light: .light, .regular: .regular,
        .medium: .medium, .semibold: .semibold, .bold: .bold, .heavy: .heavy, .black: .black
    ]
    return map[w] ?? .regular
}

// MARK: - Fraunces variable axes

private enum FrauncesAxis {
    static let opticalSize: UInt32 = 0x6F70_737A  // opsz
    static let weight: UInt32      = 0x7767_6874  // wght
    static let softness: UInt32    = 0x534F_4654  // SOFT
    static let wonk: UInt32        = 0x574F_4E4B  // WONK
}

private func appFrauncesUIFont(size: CGFloat, weight: CGFloat, soft: CGFloat, wonk: Bool) -> UIFont {
    let descriptor = UIFontDescriptor(fontAttributes: [
        .family: "Fraunces",
        kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [
            FrauncesAxis.opticalSize: min(max(size, 9), 144),
            FrauncesAxis.weight: min(max(weight, 100), 900),
            FrauncesAxis.softness: min(max(soft, 0), 100),
            FrauncesAxis.wonk: wonk ? 1 : 0,
        ],
    ])
    return UIFont(descriptor: descriptor, size: size)
}

extension Font {
    static func appTitle(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func appDisplay(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    /// Fraunces is a variable face whose default instance is `opsz 9 / wght 900`,
    /// so `.custom("Fraunces")` resolves to Fraunces-9ptBlack — a heavy caption cut
    /// scaled up. Always drive the axes; optical size tracks the point size.
    static func appEditorial(
        _ size: CGFloat,
        weight: CGFloat = 400,
        soft: CGFloat = 40,
        wonk: Bool = true,
        relativeTo textStyle: UIFont.TextStyle = .title1
    ) -> Font {
        Font(UIFontMetrics(forTextStyle: textStyle).scaledFont(for: appFrauncesUIFont(
            size: size, weight: weight, soft: soft, wonk: wonk
        )))
    }

    /// System text that follows the phone's text-size setting, capped so layouts stay usable.
    static func appBody(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: size)
        return .system(size: min(scaled, size * 1.7), weight: weight)
    }

    static func appMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: appUIFontWeight(weight))
        return Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: base))
    }
}

extension View {
    func appEyebrow() -> some View {
        font(.appBody(12, weight: .medium))
            .foregroundStyle(Color.appMuted)
    }

    func appHairline(radius: CGFloat) -> some View {
        self
    }
}

// MARK: - List primitives

extension Color {
    static let appDanger = Color(red: 235 / 255, green: 118 / 255, blue: 102 / 255)
}

struct AppDivider: View {
    var inset: CGFloat = 0
    var body: some View {
        Rectangle()
            .fill(Color.appHairline)
            .frame(height: 0.5)
            .padding(.leading, inset)
    }
}

struct AppSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.appBody(15, weight: .semibold))
            .foregroundStyle(Color.appInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A single-line text field with no box — just a thin bottom rule that brightens
/// softly while editing. Used for every text input in this language.
struct AppLineField: View {
    let placeholder: String
    @Binding var text: String
    var axis: Axis = .horizontal
    var lineLimit: ClosedRange<Int> = 1...1
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 9) {
            Group {
                if axis == .vertical {
                    TextField(
                        "",
                        text: $text,
                        prompt: Text(placeholder).foregroundStyle(Color.appMuted),
                        axis: .vertical
                    )
                        .lineLimit(lineLimit)
                } else {
                    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Color.appMuted))
                }
            }
            .font(.appBody(15))
            .foregroundStyle(Color.appInk)
            .tint(Color.appMuted)
            .focused($isFocused)

            Rectangle()
                .fill(isFocused ? Color.appInk.opacity(0.55) : Color.appAdaptive(dark: .white, light: .black).opacity(0.08))
                .frame(height: isFocused ? 1 : 0.5)
                .animation(.easeInOut(duration: 0.2), value: isFocused)
        }
    }
}

// Clean shims and new helpers only. Old glass/primary button code burned.
extension Color {
    static let appGlow = appAccent.opacity(0.3)
}

struct AppPrimaryButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(15, weight: .semibold))
                .foregroundStyle(Color.appBackground)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color.appInk, in: RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        }
        .buttonStyle(.appScale(0.97))
    }
}


/// Glassmorphism eliminated per the pure-black minimalist directive — always a plain
/// passthrough, never a Liquid Glass surface, on any iOS version.
@ViewBuilder
func appGlassContainer<Content: View>(spacing: CGFloat = 12, @ViewBuilder content: () -> Content) -> some View {
    content()
}

// MARK: - AppCard
//
// The single shared card surface. Every raised container in the product (Today cards,
// More menu, action rows, attachment strips) should use this instead of defining its own
// background + border + radius triple. The content is left-aligned by default; pass a
// different alignment via the view modifier if needed.

// MARK: - BrandWordmark
//
// The supplied architectural mark is rebuilt as live geometry so it remains crisp
// in compact chrome and large identity moments alike.

struct BrandWordmark: View {
    var height: CGFloat = 14
    var color: Color = .appInk

    var body: some View {
        HStack(spacing: height * 0.58) {
            AdamMark()
                .frame(width: height * 1.42, height: height)
            Text("ADAM")
                .font(.appBody(height * 0.78, weight: .bold))
                .tracking(height * 0.16)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Adam")
    }
}

/// The dark frame carries the identity; the blue channels are reserved for
/// activity and action throughout the interface.
struct AdamMark: View {
    var active = true

    var body: some View {
        ZStack {
            AdamEnergyShape()
                .fill(active ? Color.appAccent : Color.appMuted.opacity(0.35))
            AdamFrameShape()
                .fill(Color.appInk)
        }
        .aspectRatio(1.42, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

private struct AdamFrameShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }
        var path = Path()
        path.move(to: point(0.27, 0.08))
        path.addLine(to: point(0.73, 0.08))
        path.addLine(to: point(0.94, 0.92))
        path.addCurve(to: point(0.63, 0.51), control1: point(0.78, 0.92), control2: point(0.69, 0.82))
        path.addLine(to: point(0.63, 0.30))
        path.addLine(to: point(0.56, 0.30))
        path.addLine(to: point(0.56, 0.51))
        path.addLine(to: point(0.51, 0.51))
        path.addLine(to: point(0.51, 0.30))
        path.addLine(to: point(0.44, 0.30))
        path.addLine(to: point(0.44, 0.51))
        path.addLine(to: point(0.37, 0.51))
        path.addCurve(to: point(0.06, 0.92), control1: point(0.31, 0.82), control2: point(0.22, 0.92))
        path.closeSubpath()
        return path
    }
}

private struct AdamEnergyShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }
        var path = Path()

        path.move(to: point(0.37, 0.45))
        path.addLine(to: point(0.42, 0.45))
        path.addCurve(to: point(0.38, 0.92), control1: point(0.42, 0.68), control2: point(0.41, 0.82))
        path.addLine(to: point(0.25, 0.92))
        path.addCurve(to: point(0.37, 0.45), control1: point(0.34, 0.80), control2: point(0.37, 0.65))
        path.closeSubpath()

        path.move(to: point(0.47, 0.45))
        path.addLine(to: point(0.53, 0.45))
        path.addLine(to: point(0.56, 0.92))
        path.addLine(to: point(0.44, 0.92))
        path.closeSubpath()

        path.move(to: point(0.58, 0.45))
        path.addLine(to: point(0.63, 0.45))
        path.addCurve(to: point(0.75, 0.92), control1: point(0.63, 0.65), control2: point(0.66, 0.80))
        path.addLine(to: point(0.62, 0.92))
        path.addCurve(to: point(0.58, 0.45), control1: point(0.59, 0.82), control2: point(0.58, 0.68))
        path.closeSubpath()
        return path
    }
}

/// Adds an interactive left-edge swipe-to-dismiss to a screen, which `fullScreenCover`
/// otherwise lacks. Starting the drag near the leading edge keeps it from fighting the
/// vertical scroll views inside the presented screens, and mirrors the native back gesture.
private struct SwipeToDismissModifier: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    @State private var offset: CGFloat = 0
    @State private var dragStarted = false
    private let edgeWidth: CGFloat = 28
    private let dismissThreshold: CGFloat = 110

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            // The drag lives on a narrow leading-edge strip only — a whole-screen
            // highPriorityGesture starves the inner ScrollViews and blocks vertical
            // scrolling (Connectors/Settings/etc. couldn't scroll). This mirrors the
            // native back-swipe and leaves the rest of the screen to the scroll views.
            .overlay(alignment: .leading) {
                Color.clear
                    .frame(width: edgeWidth)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { value in
                                guard value.translation.width > 0 else { return }
                                if !dragStarted {
                                    dragStarted = true
                                    HapticManager.shared.impact(.light)
                                }
                                offset = value.translation.width
                            }
                            .onEnded { value in
                                dragStarted = false
                                if value.translation.width > dismissThreshold {
                                    HapticManager.shared.impact(.medium)
                                    dismiss()
                                } else {
                                    withAnimation(.appSpring) { offset = 0 }
                                }
                            }
                    )
            }
    }
}

extension View {
    /// Edge-swipe-to-dismiss for full-screen covers. Apply to the presented screen's root.
    func swipeToDismiss() -> some View { modifier(SwipeToDismissModifier()) }
}

// MARK: - Settings-family tokens
//
// The settings-family screens (Settings, Connectors, Pendant, Memory) used to carry
// their own pure-black ramp; it failed on-device legibility QA and they now share the
// app-wide `app*` tokens. Only these two values are still their own.

extension Color {
    /// Unselected toggle track.
    static let appToggleOff = Color.appAdaptive(dark: .white, light: .black).opacity(0.25)
    /// System red — reads on black and white alike, unlike the softer `appDanger` coral.
    static let appDestructive = Color(red: 255 / 255, green: 59 / 255, blue: 48 / 255)          // #FF3B30
}

/// Full-bleed dark hairline (#1A1A1A, 0.5pt) — the Adam row separator.
struct SettingsDivider: View {
    var body: some View {
        Rectangle().fill(Color.appHairline).frame(height: 0.5)
    }
}

/// Editorial section header — a Didot title in editorial ink, Title-case, left-aligned,
/// no background. The settings-family counterpart to `AppSectionTitle`.
struct SettingsSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.appBody(15, weight: .semibold))
            .foregroundStyle(Color.appInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// White-on / #333-off capsule toggle, no glow or halo.
struct SettingsToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.appToggle) { isOn.toggle() }
        } label: {
            Capsule()
                .fill(isOn ? Color.appAction : Color.appToggleOff)
                .frame(width: 30, height: 16)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.appOnAction : Color.appMuted)
                        .frame(width: 12, height: 12)
                        .padding(2)
                        .frame(maxWidth: .infinity, alignment: isOn ? .trailing : .leading)
                )
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? [.isSelected, .isButton] : .isButton)
        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: isOn)
    }
}

/// Flat multi-option picker — plain text options side by side, separated by 0.5pt
/// vertical hairlines, the selected one in heading colour and the rest in secondary.
/// No capsule track, no fill, no pill (per the modern spec: zero pill shapes).
/// `options` holds the stored values; pass `labels` when the display text differs.
extension Collection { subscript(safe i: Index) -> Element? { indices.contains(i) ? self[i] : nil } }

/// Mutually-exclusive selection with an unmistakable filled-capsule selected state.
/// Selected = gold accent fill + on-accent text; unselected = muted on clear.
struct AppSegmented: View {
    let options: [String]
    var labels: [String]? = nil
    @Binding var selection: String
    private func label(_ i: Int) -> String { labels?[safe: i] ?? options[i] }
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.element) { i, option in
                let isSel = selection == option
                Button {
                    withAnimation(.appStandard) { selection = option }
                    HapticManager.shared.impact(.light)
                } label: {
                    Text(label(i))
                        .font(.appBody(14, weight: isSel ? .semibold : .regular))
                        .foregroundStyle(isSel ? Color.appOnAccent : Color.appMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .frame(maxWidth: .infinity).frame(minHeight: 40)
                        .background(Capsule().fill(isSel ? Color.appAccent : Color.clear))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSel ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(4)
        .background(Capsule().fill(Color.appAdaptive(dark: .white, light: .black).opacity(0.06)))
    }
}

typealias SettingsSegmentedControl = AppSegmented

/// Shared raised surface for grouped content.
struct TodayCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(shape.fill(Color.appAdaptive(dark: Color.appSurface2, light: .white.opacity(0.88))))
            .overlay(shape.strokeBorder(Color.appHairline, lineWidth: 0.6))
            .shadow(color: .black.opacity(0.035), radius: 6, y: 2)
    }
}

// MARK: - Scroll-aware tab bar (legacy no-op)
//
// Previously drove a custom floating tab bar. The app now uses the system liquid-glass
// TabView bar only. Keep the type + modifier so call sites and previews still compile;
// they no longer hide anything.

private struct HidesTabBarOnScroll: ViewModifier {
    func body(content: Content) -> some View { content }
}

extension View {
    /// No-op: system liquid-glass tab bar stays visible for reachability.
    /// Kept so existing `.hidesTabBarOnScroll()` call sites remain valid.
    func hidesTabBarOnScroll() -> some View { modifier(HidesTabBarOnScroll()) }
}

/// The quiet counterpart: border-only, muted titanium text, no fill.
struct AppOutlineButton: View {
    let title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(Color.appMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
        }
        .buttonStyle(.appScale)
    }
}

// Duplicate editorial ed shims removed to avoid redeclaration. Use the ones earlier in the file.

/// A Didot section title — the editorial counterpart to a small-caps header.
struct AppSectionTitle: View {
    let text: String
    // size retained for source compat; all section headers now share one canonical scale.
    var size: CGFloat = 22
    init(_ text: String, size: CGFloat = 22) { self.text = text; self.size = size }
    var body: some View {
        Text(text)
            .font(.appBody(15, weight: .semibold))
            .foregroundStyle(Color.appInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The one row primitive for list-style screens (Memory/Settings/Connections/Pendant/Account/More).
/// Title + optional subtitle on the left; an optional trailing view (chevron/status/toggle) on the right.
struct AppRow<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    var onTap: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        let content = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.rowTitle).foregroundStyle(Color.appInk)
                if let subtitle { Text(subtitle).font(.rowSecondary).foregroundStyle(Color.appMuted) }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 16)
        .frame(minHeight: 44)
        .contentShape(Rectangle())

        if let onTap {
            Button { HapticManager.shared.impact(.light); onTap() } label: { content }
                .buttonStyle(.appScale(0.98))
        } else {
            content
        }
    }
}
extension AppRow where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, onTap: (() -> Void)? = nil) {
        self.init(title: title, subtitle: subtitle, onTap: onTap) { EmptyView() }
    }
}


// MARK: - Chosen background

/// The background the user picks for the whole app. Each tone forces the light or dark
/// palette that reads best on it, so text and buttons stay legible without extra work.
enum ThreadBackground: String, CaseIterable, Identifiable {
    case automatic, warm, sea, night

    static let storageKey = "adam_thread_background"

    static var current: ThreadBackground {
        ThreadBackground(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .automatic
    }

    var id: String { rawValue }

    var title: String {
        switch self {
        case .automatic: return "Automatic"
        case .warm: return "Warm"
        case .sea: return "Sea"
        case .night: return "Night"
        }
    }

    /// nil follows the phone's light or dark setting.
    var scheme: ColorScheme? {
        switch self {
        case .automatic: return nil
        case .warm, .sea: return .light
        case .night: return .dark
        }
    }

    var uiColor: UIColor? {
        switch self {
        case .automatic: return nil
        case .warm: return UIColor(red: 0.973, green: 0.945, blue: 0.898, alpha: 1)   // #F8F1E5
        case .sea: return UIColor(red: 0.914, green: 0.953, blue: 0.937, alpha: 1)    // #E9F3EF
        case .night: return UIColor(red: 0.059, green: 0.090, blue: 0.188, alpha: 1)  // #0F1730
        }
    }

    /// A preview colour for the picker (automatic shows the current system look).
    var swatch: Color {
        if let uiColor { return Color(uiColor) }
        return Color.appBackground
    }
}
