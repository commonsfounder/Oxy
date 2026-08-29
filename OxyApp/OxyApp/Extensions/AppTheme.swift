import SwiftUI
import UIKit

// MARK: - Color tokens

private func appDynamicColor(dark: Color, light: Color) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
}

extension Color {
    static let appBackground = appDynamicColor(
        dark: Color(red: 0.047, green: 0.043, blue: 0.043),   // #0C0B0B
        light: Color(red: 0.965, green: 0.953, blue: 0.933)   // warm paper
    )

    static let appSurface = appDynamicColor(
        dark: Color(red: 0.082, green: 0.078, blue: 0.075),   // #151413
        light: Color(red: 0.988, green: 0.980, blue: 0.963)   // raised paper
    )

    static let appSurface2 = appDynamicColor(
        dark: Color(red: 0.118, green: 0.110, blue: 0.102),   // #1E1C1A
        light: Color(red: 0.918, green: 0.894, blue: 0.858)   // sand inset
    )

    static let appHairline = appDynamicColor(
        dark: Color(red: 0.949, green: 0.933, blue: 0.906).opacity(0.10),
        light: Color(red: 0.18, green: 0.19, blue: 0.22).opacity(0.10)
    )

    static let appInk = appDynamicColor(
        dark: Color(red: 0.949, green: 0.933, blue: 0.906),   // #F2EEE7
        light: Color(red: 0.145, green: 0.133, blue: 0.118)   // deep umber
    )

    /// The quietest tone any *text* is allowed to take — 7.6:1 on the canvas.
    /// Screens had drifted to `appInk.opacity(0.42…0.56)` for secondary copy, which
    /// falls under the legibility floor in DESIGN.md. Secondary text is this colour.
    static let appMuted = appDynamicColor(
        dark: Color(red: 0.655, green: 0.631, blue: 0.604),   // #A7A19A
        light: Color(red: 0.420, green: 0.391, blue: 0.350)   // warm secondary
    )

    /// Non-text only: rules, inactive glyphs, disabled chrome, placeholder shapes.
    /// Never set copy in it — that is what `appMuted` is for.
    static let appFaint = appDynamicColor(
        dark: Color(red: 0.412, green: 0.396, blue: 0.380),   // #696560
        light: Color(red: 0.635, green: 0.616, blue: 0.584)   // #A29D95
    )

    static let appAccent = appDynamicColor(
        dark: Color(red: 0.784, green: 0.663, blue: 0.420),   // #C8A96B
        light: Color(red: 0.575, green: 0.407, blue: 0.145)   // antique gold
    )

    /// The label colour paired with `appAccent`. It has to follow the finish: the
    /// dark-mode gold (#C8A96B) is light enough that near-black reads at 7.7:1 and
    /// white at 2.3:1, and the light-mode antique gold (#93681F) is the other way
    /// round (3.5:1 vs 4.9:1). A single fixed value fails one of the two.
    static let appOnAccent = appDynamicColor(
        dark: Color(red: 0.106, green: 0.098, blue: 0.086),
        light: .white
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

    // MARK: - Elevation
    //
    // Three levels, and the fill is opaque at every one. The screens had ten
    // different `appSurface.opacity(0.62…0.94)` values, so two cards side by side
    // sat at two different heights for no reason.

    /// Level 1 — a card resting on the canvas.
    static let appRaised = appSurface
    /// Level 2 — something lifted above a card: a popover, a focused field, a chip.
    static let appFloating = appSurface2

    static let appScrim = Color.black.opacity(0.5)
    static let appFillSubtle = appDynamicColor(dark: Color.white.opacity(0.08), light: Color.black.opacity(0.06))
    static let appFillScrim = appScrim
    static let appObsidian = appBackground
    static let appTitanium = appMuted

    static let appUserBubble = appSurface2
}

// MARK: - Spacing
//
// A 4pt grid. Padding and stack spacing come from here; an off-grid value is how a
// screen starts reading as hand-placed rather than drawn.
enum AppSpacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
    static let chatMargin: CGFloat = 20
    static let margin: CGFloat = 20
}

// MARK: - Type scale
//
// Eight steps and nothing between them. The app had grown 26 distinct sizes —
// including 11.5, 12.5, 13.5, 14.5 and 15.5 — which is what makes a screen look
// assembled instead of drawn. Every `appBody` / `appDisplay` / `appMono` call
// passes one of these; `test/smoke/ios-design-system.test.js` enforces it.
enum AppText {
    /// Eyebrows and tracked micro-labels. Never a full sentence.
    static let micro: CGFloat = 11
    /// Timestamps, metric captions, chips.
    static let caption: CGFloat = 12
    /// Secondary lines under a title.
    static let footnote: CGFloat = 13
    /// The default. Body copy, rows, fields, buttons.
    static let body: CGFloat = 15
    /// Row titles and emphasis inside a card.
    static let callout: CGFloat = 17
    /// Card and section titles.
    static let title: CGFloat = 20
    /// Screen headers and metric figures.
    static let display: CGFloat = 28
    /// The one greeting on the home screen.
    static let hero: CGFloat = 40

    static let all: [CGFloat] = [micro, caption, footnote, body, callout, title, display, hero]
}

extension Font {
    static var screenTitle: Font  { .appDisplay(AppText.title, weight: .semibold) }
    static var rowTitle: Font     { .appBody(AppText.callout) }
    static var rowSecondary: Font { .appBody(AppText.footnote) }
    static func heroDisplay(_ size: CGFloat = AppText.display) -> Font {
        .appDisplay(size, weight: .semibold)
    }
}

// MARK: - Radius
//
// 4pt steps, matching the spacing grid. Nest with `inner(_:inset:)` so a shape
// inside another shape stays concentric instead of drifting a point or two off.
enum AppRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 22
    static let bubble: CGFloat = 18
    static let card: CGFloat = lg

    /// The radius a shape needs to sit concentrically inside an `outer` corner
    /// when it is inset by `inset` on every side.
    static func inner(_ outer: CGFloat, inset: CGFloat) -> CGFloat {
        max(outer - inset, sm / 2)
    }
}

// MARK: - Borders
//
// Two widths. A hairline is a hairline; 0.6 / 0.7 / 0.75 / 0.8 were four ways of
// drawing the same rule slightly differently on adjacent surfaces.
enum AppBorder {
    static let hairline: CGFloat = 0.5
    static let strong: CGFloat = 1
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
    var amount: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? amount : 1)
            .animation(.appFast, value: configuration.isPressed)
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
            lineWidth: AppBorder.hairline
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

extension Font {
    static func appTitle(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func appDisplay(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func appBody(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    static func appMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: appUIFontWeight(weight))
        return Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: base))
    }
}

extension View {
    /// A tracked micro-label above a title. One definition, so every eyebrow in the
    /// app is the same size, weight, tracking and colour.
    func appEyebrow() -> some View {
        font(.appBody(AppText.micro, weight: .semibold))
            .tracking(1.6)
            .textCase(.uppercase)
            .foregroundStyle(Color.appMuted)
    }
}

// MARK: - List primitives

extension Color {
    static let appDanger = Color(red: 235 / 255, green: 118 / 255, blue: 102 / 255)
}

/// The one rule in the app. `MilgrainDivider` is the same thing under its old name.
struct AppDivider: View {
    var inset: CGFloat = 0
    var body: some View {
        Rectangle()
            .fill(Color.appHairline)
            .frame(height: AppBorder.hairline)
            .padding(.leading, inset)
    }
}

/// The one section header. `MilgrainSectionHeader` and `AppSectionTitle` are the
/// same thing under their old names — there were three identical implementations.
struct AppSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.appBody(AppText.body, weight: .semibold))
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
        VStack(spacing: AppSpacing.sm) {
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
            .font(.appBody(AppText.body))
            .foregroundStyle(Color.appInk)
            .tint(Color.appAccent)
            .focused($isFocused)

            Rectangle()
                .fill(isFocused ? Color.appAccent : Color.appHairline)
                .frame(height: isFocused ? AppBorder.strong : AppBorder.hairline)
                .animation(.appToggle, value: isFocused)
        }
    }
}

// MARK: - Buttons
//
// Primary carries the accent, per DESIGN.md — it had drifted to a white `appInk`
// slab, which put the loudest surface in the app on the least important screen.

private let appControlHeight: CGFloat = 50

struct AppPrimaryButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(AppText.body, weight: .semibold))
                .foregroundStyle(Color.appOnAccent)
                .frame(maxWidth: .infinity)
                .frame(height: appControlHeight)
                .background(Color.appAccent, in: Capsule())
        }
        .buttonStyle(.appScale(0.97))
    }
}

// MARK: - Surfaces
//
// One treatment at three heights. The product had four competing card definitions
// (`AppCard`, `TodayCard`, `MissionGlassPlate`, `EditorialPlate`) and ten different
// `appSurface.opacity(0.62…0.94)` fills, so two cards on the same screen could sit
// at two different heights for no reason. They all route through here now.

enum AppElevation {
    /// In the canvas — no fill, hairline only. Grouping without a card.
    case flat
    /// On the canvas — the default card.
    case raised
    /// Above a card — popovers, focused fields, chips, the composer.
    case floating

    var fill: Color {
        switch self {
        case .flat:     return .clear
        case .raised:   return .appRaised
        case .floating: return .appFloating
        }
    }

    /// Dark mode reads lift from the fill stepping away from the canvas; light mode
    /// reads it from the shadow. Both need to be right, so both are specified.
    var shadow: (radius: CGFloat, y: CGFloat, opacity: Double) {
        switch self {
        case .flat:     return (0, 0, 0)
        case .raised:   return (10, 4, 0.10)
        case .floating: return (20, 8, 0.16)
        }
    }
}

/// The one raised surface: opaque fill, one hairline, one soft shadow.
struct AppSurfaceBackground: View {
    var elevation: AppElevation = .raised
    var radius: CGFloat = AppRadius.card

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let lift = elevation.shadow
        shape
            .fill(elevation.fill)
            .overlay(shape.strokeBorder(Color.appHairline, lineWidth: AppBorder.hairline))
            .shadow(color: .black.opacity(lift.opacity), radius: lift.radius, y: lift.y)
    }
}

extension View {
    /// Put this view on a raised surface. Use instead of hand-rolling a
    /// background + strokeBorder + shadow triple. (Named `plate` rather than
    /// `surface` so it never reads as the `Color.appSurface` token.)
    func appPlate(_ elevation: AppElevation = .raised,
                  radius: CGFloat = AppRadius.card) -> some View {
        background { AppSurfaceBackground(elevation: elevation, radius: radius) }
    }
}

/// The container form of the same surface: content, padding, card.
struct AppCard<Content: View>: View {
    var padding: CGFloat = AppSpacing.lg
    var elevation: AppElevation = .raised
    var radius: CGFloat = AppRadius.card
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .appPlate(elevation, radius: radius)
    }
}

// MARK: - BrandWordmark
//
// The Milgrain wordmark asset, template-rendered so it adapts to any tint on the
// obsidian canvas. Default: muted titanium at 14pt height (as used in the More tab
// identity header). Pass a different height or color for alternate contexts.

struct BrandWordmark: View {
    var height: CGFloat = 14
    var color: Color = .appMuted

    var body: some View {
        Image("wordmark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .foregroundStyle(color)
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

// MARK: - Milgrain tokens (settings family)
//
// A harder, purer greyscale for the settings-family screens (Settings, Connectors,
// Pendant, Memory) per the Milgrain spec: a flat #0A0A0A canvas, dark #1A1A1A
// hairlines, pure-white headings, and a #888/#555/#333 grey ramp. Kept separate from
// the softer app-wide `app*` tokens (off-black canvas, warm off-white ink, translucent
// titanium hairlines) so Chat / Today / Onboarding are left untouched.

extension Color {
    // The settings-family screens now share the app-wide tokens; the old pure-black
    // + dim grey ramp (#0A0A0A / #888 / #555 / #333) failed on-device legibility QA.
    static let mgBg = Color.appBackground
    static let mgDivider = Color.appHairline
    static let mgHeading = Color.appInk
    static let mgSecondary = Color.appMuted
    static let mgCaption = Color.appMuted
    static let mgOff = Color.appAdaptive(dark: .white, light: .black).opacity(0.25)
    /// Fixed both finishes — system red reads on black and white alike.
    static let mgDestructive = Color(red: 255 / 255, green: 59 / 255, blue: 48 / 255)          // #FF3B30
}

extension Font {
    /// Legacy alias — settings-family headers now use the app-wide display face.
    static func mgDidot(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .appDisplay(size, weight: .semibold)
    }
}

/// Full-bleed dark hairline (#1A1A1A, 0.5pt) — the Milgrain row separator.
struct MilgrainDivider: View {
    var body: some View { AppDivider() }
}

/// Editorial section header — a Didot title in editorial ink, Title-case, left-aligned,
/// no background. The settings-family counterpart to `AppSectionTitle`.
struct MilgrainSectionHeader: View {
    let title: String
    var body: some View { AppSectionHeader(title: title) }
}

/// White-on / #333-off capsule toggle, no glow or halo.
struct MilgrainToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.appToggle) { isOn.toggle() }
        } label: {
            // 30×16 with a 12pt knob was too small to read state at a glance and
            // put a white knob on gold at ~2:1. Bigger, and the knob now uses the
            // accent's paired ink like every other on-accent element.
            Capsule()
                .fill(isOn ? Color.appAccent : Color.mgOff)
                .frame(width: 40, height: 22)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.appOnAccent : Color.appMuted)
                        .frame(width: 16, height: 16)
                        .padding(3)
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
                        .font(.appBody(AppText.body, weight: isSel ? .semibold : .regular))
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

typealias MilgrainSegmentedControl = AppSegmented

/// The Today board's card — the shared surface under its own name.
struct TodayCard<Content: View>: View {
    var padding: CGFloat = AppSpacing.lg
    @ViewBuilder let content: Content

    var body: some View {
        AppCard(padding: padding) { content }
    }
}

// MARK: - Scroll-aware tab bar (legacy no-op)
//
// Previously drove a custom floating tab bar. The app now uses the system liquid-glass
// TabView bar only. Keep the type + modifier so call sites and previews still compile;
// they no longer hide anything.

@Observable final class TabBarVisibility {
    var hidden = false
}

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
                .font(.appBody(AppText.body, weight: .medium))
                .foregroundStyle(Color.appMuted)
                .frame(maxWidth: .infinity)
                .frame(height: appControlHeight)
                // It is called an outline button; it had no outline, so it read as
                // floating text next to the primary capsule with no edge to press.
                .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: AppBorder.strong))
                .contentShape(Capsule())
        }
        .buttonStyle(.appScale)
    }
}

// Duplicate editorial ed shims removed to avoid redeclaration. Use the ones earlier in the file.

/// A tiny deterministic RNG so the paper grain is stable across redraws (no per-frame
/// shimmer). Splitmix64 — good enough for scattering specks.
struct EditorialSeededRNG: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

/// Faint paper-grain overlay for materiality — dark specks multiplied onto a light
/// canvas, light specks screened onto a dark one. Static (seeded), never animated.
struct AppGrain: View {
    @Environment(\.colorScheme) private var scheme
    var intensity: Double = 0.05

    var body: some View {
        Canvas { ctx, size in
            var rng = EditorialSeededRNG(seed: 0x5EED_1234)
            let speck = scheme == .dark ? Color.white : Color.black
            let count = Int((size.width * size.height) / 700)
            for _ in 0..<max(count, 0) {
                let x = Double.random(in: 0...size.width, using: &rng)
                let y = Double.random(in: 0...size.height, using: &rng)
                let o = Double.random(in: 0.2...1.0, using: &rng) * intensity
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.1, height: 1.1)),
                         with: .color(speck.opacity(o)))
            }
        }
        .blendMode(scheme == .dark ? .screen : .multiply)
        .allowsHitTesting(false)
    }
}

/// A Didot section title — the editorial counterpart to a small-caps header.
struct AppSectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { AppSectionHeader(title: text) }
}

/// Hairline rule with a small centred dot — the only divider ornament the language uses.
struct AppRule: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color.appHairline).frame(height: AppBorder.hairline)
            Circle().fill(Color.appFaint).frame(width: 3, height: 3)
            Rectangle().fill(Color.appHairline).frame(height: AppBorder.hairline)
        }
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
        let content = HStack(spacing: AppSpacing.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.rowTitle).foregroundStyle(Color.appInk)
                if let subtitle { Text(subtitle).font(.rowSecondary).foregroundStyle(Color.appMuted) }
            }
            Spacer(minLength: AppSpacing.sm)
            trailing()
        }
        .padding(.vertical, AppSpacing.lg)
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
