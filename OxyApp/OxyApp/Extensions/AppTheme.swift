import SwiftUI
import UIKit

/// MILGRAIN DESIGN SYSTEM
/// Warm black canvas, restrained surfaces, readable text, and a sparse metal
/// accent. The interface should feel like the software side of an intimate object:
/// useful first, tactile second, decorative last.

/// A color that resolves per the real trait collection (not a manually-threaded
/// `colorScheme` bool) so native chrome (TabView, sheets, keyboard) and every custom
/// token always agree on which finish is active — the prior "empty pill" tab bar bug
/// was exactly this class of mismatch (content pinned dark, chrome following the OS).
private func appDynamicColor(dark: Color, light: Color) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
}

extension Color {
    /// Main canvas. Gleb cool pastel base in light (the app's identity); warm black
    /// retained for dark, though the app is pinned light.
    static let appBackground = appDynamicColor(
        dark: Color(red: 0.047, green: 0.043, blue: 0.043),   // #0C0B0B
        light: Color(red: 0.969, green: 0.969, blue: 0.980)   // #F7F7FA — Gleb wash base
    )

    /// Quiet raised surface — cool glassy near-white.
    static let appSurface = appDynamicColor(
        dark: Color(red: 0.082, green: 0.078, blue: 0.075),   // #151413
        light: Color(red: 0.965, green: 0.967, blue: 0.980)   // #F6F7FA
    )

    /// Raised surface (sheets, prominent rows).
    static let appSurface2 = appDynamicColor(
        dark: Color(red: 0.118, green: 0.110, blue: 0.102),   // #1E1C1A
        light: Color(red: 0.929, green: 0.933, blue: 0.957)   // #EDEEF4
    )

    /// Hairline / divider — soft cool edge that reads on glass.
    static let appHairline = appDynamicColor(
        dark: Color(red: 0.949, green: 0.933, blue: 0.906).opacity(0.10),
        light: Color(red: 0.18, green: 0.19, blue: 0.22).opacity(0.10)
    )

    /// Primary text — Gleb ink.
    static let appInk = appDynamicColor(
        dark: Color(red: 0.949, green: 0.933, blue: 0.906),   // #F2EEE7
        light: Color(red: 0.180, green: 0.192, blue: 0.220)   // #2E313A — Gleb ink
    )

    /// Secondary / captions — Gleb muted.
    static let appMuted = appDynamicColor(
        dark: Color(red: 0.655, green: 0.631, blue: 0.604),   // #A7A19A
        light: Color(red: 0.451, green: 0.471, blue: 0.520)   // #737885 — Gleb muted
    )

    /// Metal accent. Use sparingly: selected detail, status, progress, important moments.
    /// Deepened in light mode — the pale dark-mode gold loses contrast on a white canvas.
    static let appAccent = appDynamicColor(
        dark: Color(red: 0.784, green: 0.663, blue: 0.420),   // #C8A96B
        light: Color(red: 0.612, green: 0.471, blue: 0.188)   // #9C7830
    )

    /// On accent (text/icons on the accent fill). Accent is a mid-tone gold in both
    /// finishes, so this stays a fixed dark ink rather than following appBackground.
    static let appOnAccent = Color(red: 0.106, green: 0.098, blue: 0.086)

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

    // Legacy scrim etc for quick ports
    static let appScrim = Color.black.opacity(0.5)
    static let appFillSubtle = appDynamicColor(dark: Color.white.opacity(0.08), light: Color.black.opacity(0.06))
    static let appFillScrim = appScrim
    static let appObsidian = appBackground
    static let appTitanium = appMuted

    /// User chat bubble fill — a flat neutral, not a translucent accent wash.
    /// Alpha-blending `appAccent` at low opacity directly over the canvas desaturates
    /// warm gold into a muddy tone in either finish (basic alpha-compositing over a
    /// non-neutral backdrop). `appSurface2` is already a tested, legible flat tone, so
    /// the bubble reads as a clean neutral chip instead — the accent stays reserved
    /// for the assistant's voice.
    static let appUserBubble = appSurface2
}

// MARK: - Spacing (consistent rhythm; use these instead of new magic numbers)
enum AppSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    /// Chat's outer content margin — slightly wider than the old 16pt so text
    /// doesn't crowd the screen edges now that assistant replies sit flush.
    static let chatMargin: CGFloat = 20
    /// Canonical outer content margin for non-chat screens (Settings/Memory/etc).
    static let margin: CGFloat = 20
}

extension Font {
    static var screenTitle: Font { .appBody(20, weight: .semibold) }
    static var rowTitle: Font    { .appBody(16, weight: .regular) }
    static var rowSecondary: Font { .appBody(13, weight: .regular) }
    static func heroDisplay(_ size: CGFloat = 30) -> Font { .appEditorial(size) }
}

// MARK: - Radius (concentric friendly)
enum AppRadius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 16
    static let xl: CGFloat = 22
    static let bubble: CGFloat = 18
    static let card: CGFloat = lg
}

// MARK: - Animation tokens
// Critically-damped springs (dampingFraction 1.0 = zero overshoot) rather than fixed-duration
// eases: interruptible and velocity-aware on retrigger, but visually still "no bounce" —
// the house style is unchanged, only the underlying curve is more physically honest.
// appMomentum is the one deliberate exception, reserved for gesture-driven motion that
// carries momentum (drag-to-dismiss, flicks) — nothing wires to it yet.
extension Animation {
    static let appFast     = Animation.spring(response: 0.15, dampingFraction: 1.0)
    static let appStandard = Animation.spring(response: 0.22, dampingFraction: 1.0)
    static let appRelax    = Animation.spring(response: 0.4,  dampingFraction: 1.0)
    static let appSpring   = Animation.spring(response: 0.28, dampingFraction: 1.0)
    static let appMomentum = Animation.spring(response: 0.3,  dampingFraction: 0.8)
}

// MARK: - Helpers (scale on press, glass where it still fits)
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

/// Staggered fade+rise entrance for first-appearance content (cards, headers, list rows).
/// Under Reduce Motion the rise drops out and only a plain cross-fade remains — reduced
/// motion means gentler feedback, not none.
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

    /// Large display/editorial headings (Fraunces, ~26–31pt) read too airy with system
    /// tracking at that size — tighten proportionally. Body and eyebrow text are unaffected.
    func appHeroTracking(_ size: CGFloat) -> some View {
        tracking(-size * 0.02)
    }
}

// Legacy shims removed during full app migration.
// All code must use the primary app* tokens (appBackground, appSurface, appAccent, appInk, appMuted, AppRadius, appBody, appDisplay, etc.).
// Remove any remaining nml*, NML*, ed* or Nameless references.

extension View {
    /// Light material chrome for small interactive chips (nav icons, composer buttons).
    /// Thin blur + a warm tint keeps it a "small surface" per the materials weight rule —
    /// TodayCard uses the heavier `.regularMaterial` for the same reason, being structural.
    /// `interactive` elements get a brighter edge, as if catching light, since they invite touch.
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
    /// One-off adaptive value for call sites that need a color the shared tokens
    /// don't cover. Most styling should use the `app*` tokens directly — they're
    /// already dynamic — reach for this only for something genuinely local.
    static func appAdaptive(dark: Color, light: Color) -> Color { appDynamicColor(dark: dark, light: light) }
}

// MARK: - Typography rule (serif vs sans)
//
// Decide which face a new label takes by its SEMANTIC ROLE, not by taste:
//
//   • appDisplay (Fraunces, serif) — warm / identity / emotional moments ONLY:
//     greetings ("Good afternoon", "Welcome back."), empty-state prompts, and
//     Memory content category headers ("People", "Places"). The voice of the app.
//
//   • appBody (Inter, sans) — ALL functional/navigational/control UI: screen and
//     nav titles, settings rows, buttons, field labels, status text, captions.
//
//   • appMono — technical readouts only (battery, latency, ids, timestamps).
//
// If a label is something the user operates (a control, a title, a status), it's
// sans. If it's the product speaking to the user, it's serif. No other use of serif.
/// Maps a SwiftUI `Font.Weight` to its `UIFont.Weight` twin. `Font.Weight` isn't a
/// switchable enum, so a small lookup is the cleanest bridge for the metrics-scaled
/// monospace font below.
private func appUIFontWeight(_ w: Font.Weight) -> UIFont.Weight {
    let map: [Font.Weight: UIFont.Weight] = [
        .ultraLight: .ultraLight, .thin: .thin, .light: .light, .regular: .regular,
        .medium: .medium, .semibold: .semibold, .bold: .bold, .heavy: .heavy, .black: .black
    ]
    return map[w] ?? .regular
}

extension Font {
    // Every face below opts into Dynamic Type: custom fonts via `relativeTo:` and the
    // monospace readout via `UIFontMetrics`. A fixed-size font ignores the user's text-size
    // setting entirely, so the passed `size` is the point size at the Large default and
    // scales from there.

    static func appTitle(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    /// Display face — composed sans, not rounded. Functional headings use this.
    static func appDisplay(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    /// Editorial face — Fraunces only for short identity and greeting moments.
    static func appEditorial(_ size: CGFloat) -> Font {
        .custom("Fraunces", size: size, relativeTo: .title)
    }

    /// Body / UI face — system SF at regular weight. The old Inter-light body was
    /// a major legibility failure on device; never default below .regular.
    static func appBody(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// Clean monospace for technical readouts — battery, latency, connection state.
    /// Scaled with Dynamic Type via UIFontMetrics (a fixed-size `.system` mono otherwise
    /// stays pinned no matter the user's text-size setting).
    static func appMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: appUIFontWeight(weight))
        return Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: base))
    }
}

extension View {
    /// Label: 11pt uppercase Inter, +1.5 tracking, muted. Use above a title to let the
    /// layout breathe instead of stacking bold headers.
    func appEyebrow() -> some View {
        font(.appBody(11, weight: .regular))
            .tracking(1.5)
            .textCase(.uppercase)
            .foregroundStyle(Color.appMuted)
    }

    /// Borders eliminated per the pure-black minimalist directive. No-op,
    /// kept only so existing call sites don't need touching.
    func appHairline(radius: CGFloat) -> some View {
        self
    }
}

/// A small status dot whose colour carries meaning (see the token table in the
/// semantic-status section above). A soft halo only appears for the `.live` state,
/// so "live" reads differently from a merely "enabled" row at a glance.
struct AppStatusDot: View {
    enum Kind {
        case live      // green — active / streaming
        case enabled   // silver — enabled, idle
        case off       // gray — disabled / off
        case error     // coral — error / disconnected-with-a-problem
        case degraded  // amber — attention-needed

        var color: Color {
            switch self {
            case .live:     return .appLive
            case .enabled:  return .appGlow
            case .off:      return .appMuted.opacity(0.4)
            case .error:    return .appDanger
            case .degraded: return .appAttention
            }
        }
        var halo: Bool { self == .live }
    }

    var kind: Kind
    var diameter: CGFloat = 6

    /// Back-compat shorthand: live link vs. idle. Prefer `kind:` for full semantics.
    init(isLive: Bool, diameter: CGFloat = 6) {
        self.kind = isLive ? .live : .off
        self.diameter = diameter
    }

    init(kind: Kind, diameter: CGFloat = 6) {
        self.kind = kind
        self.diameter = diameter
    }

    var body: some View {
        ZStack {
            if kind.halo {
                Circle()
                    .fill(kind.color.opacity(0.35))
                    .frame(width: diameter * 2.4, height: diameter * 2.4)
                    .blur(radius: diameter * 0.5)
            }
            Circle()
                .fill(kind.color)
                .frame(width: diameter, height: diameter)
        }
        .frame(width: diameter * 2.4, height: diameter * 2.4)
    }
}

// MARK: - Unified "App" list primitives
//
// Stock `List`/`Form` rows, grouped insets and the green system `Toggle` are
// banned across Settings, Connectors and Memory. These primitives replace them:
// flat rows on pure black, separated by ultra-thin titanium dividers, with raw
// typography instead of colourful SF-symbol tiles.

extension Color {
    /// Luminous coral for destructive actions and overdue states — warm rather than
    /// neon, but bright enough to clear contrast against the pure-black canvas.
    static let appDanger = Color(red: 235 / 255, green: 118 / 255, blue: 102 / 255)
}

/// An ultra-thin, low-opacity horizontal divider — the only separator the
/// language allows between rows.
struct AppDivider: View {
    var inset: CGFloat = 0
    var body: some View {
        Rectangle()
            // The spec separator: 0.5px ≈ #222222, tinted subtly by the active finish.
            .fill(Color.appHairline)
            .frame(height: 0.5)
            .padding(.leading, inset)
    }
}

/// Title Case, wide-tracked sans-serif section header in muted detail colour.
/// Elegant spacing instead of a loud uppercase monospace grid.
struct AppSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.appBody(15, weight: .semibold))
            .foregroundStyle(Color.appInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Minimalist custom toggle: a 30×16 capsule that slides between muted gray
/// (off) and soft silver (on). Replaces the stock green `Toggle`.
struct AppToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isOn.toggle() }
        } label: {
            Capsule()
                .fill(isOn ? Color.appInk : Color.appAdaptive(dark: .white, light: .black).opacity(0.12))
                .frame(width: 30, height: 16)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.appObsidian : Color.appMuted)
                        .frame(width: 12, height: 12)
                        .padding(2)
                        .frame(maxWidth: .infinity, alignment: isOn ? .trailing : .leading)
                )
                // Extend hit area to 44×44 without growing the visual
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? [.isSelected, .isButton] : .isButton)
        // A precise, mechanical-switch pulse on every state change.
        .sensoryFeedback(.impact(weight: .light, intensity: 1.0), trigger: isOn)
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
                    TextField(placeholder, text: $text, axis: .vertical)
                        .lineLimit(lineLimit)
                } else {
                    TextField(placeholder, text: $text)
                }
            }
            .font(.system(size: 15, weight: .light))
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
                .font(.appBody(13, weight: .semibold))
                .tracking(1.8)
                .textCase(.uppercase)
                .foregroundStyle(Color.appBackground)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(Color.appInk)
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

struct AppCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content

    // No background fill, border, or shadow — content sits directly on the pure-black
    // canvas per the minimalist directive. Separation comes from hairline dividers only.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
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
                                offset = value.translation.width
                            }
                            .onEnded { value in
                                if value.translation.width > dismissThreshold {
                                    dismiss()
                                } else {
                                    withAnimation(.easeOut(duration: 0.2)) { offset = 0 }
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
    var body: some View {
        Rectangle().fill(Color.mgDivider).frame(height: 0.5)
    }
}

/// Editorial section header — a Didot title in editorial ink, Title-case, left-aligned,
/// no background. The settings-family counterpart to `AppSectionTitle`.
struct MilgrainSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.appBody(15, weight: .semibold))
            .foregroundStyle(Color.appInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// White-on / #333-off capsule toggle, no glow or halo.
struct MilgrainToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isOn.toggle() }
        } label: {
            Capsule()
                .fill(isOn ? Color.appAccent : Color.mgOff)
                .frame(width: 30, height: 16)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.appOnAccent : Color.mgSecondary)
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

typealias MilgrainSegmentedControl = AppSegmented

// MARK: - Today tab: light/dark glass language
//
// The Today tab is the one screen that breaks the fixed-black rule: it has a
// living aurora gradient with glass cards floating over it, in two finishes.
// `TodayPalette` swaps the text/line colours between the dark aurora and the
// light pastel finish; cards read `p.ink` / `p.muted` etc. so a single bool
// flips the whole screen.

/// The user's chosen appearance, persisted in UserDefaults. Drives `.preferredColorScheme`
/// at the app root; every screen then reads the resolved `\.colorScheme` from the
/// environment rather than computing its own finish. `.system` follows the iOS setting.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light:  return "Light"
        case .dark:   return "Dark"
        }
    }

    /// nil = follow the system (the `.preferredColorScheme` "no preference" value).
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light:  return .light
        case .dark:   return .dark
        }
    }

    static let storageKey = "oxy_appearance"
}

struct TodayPalette {
    let ink: Color       // primary editorial text
    let muted: Color     // captions, eyebrows, secondary
    let titanium: Color  // icons, quiet emphasis
    let hairline: Color  // 0.5pt rules

    static let dark = TodayPalette(
        ink:      Color(red: 240 / 255, green: 239 / 255, blue: 235 / 255),
        muted:    Color(red: 152 / 255, green: 152 / 255, blue: 158 / 255),
        titanium: Color(red: 199 / 255, green: 202 / 255, blue: 206 / 255),
        hairline: Color.white.opacity(0.14)
    )
    static let light = TodayPalette(
        ink:      Color(red: 0.13, green: 0.13, blue: 0.15),
        muted:    Color(red: 0.42, green: 0.42, blue: 0.46),
        titanium: Color(red: 0.30, green: 0.30, blue: 0.34),
        hairline: Color.black.opacity(0.10)
    )
}

/// A glass card for the Today tab — same silhouette as `AppCard` but with a
/// refractive Liquid Glass surface instead of an opaque fill, so it picks up the
/// aurora gradient behind it. Group these in `appGlassContainer` to get the fluid
/// morph between cards on iOS 26.
struct TodayCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            // Structural surface — heavier material than the small appGlass() chips,
            // per the materials weight rule (bigger surfaces read as thicker).
            .background(shape.fill(Color.appSurface.opacity(0.55)))
            .background(.regularMaterial, in: shape)
            .overlay(shape.strokeBorder(Color.appAdaptive(dark: .white, light: .black).opacity(0.08), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.25), radius: 16, y: 8)
    }
}

/// The living background for the Today tab: a slowly-drifting 3×3 mesh gradient.
/// Dark finish is a muted aurora that stays mostly black (text stays readable);
/// light finish is the soft pastel wash. Falls back to a static linear gradient
/// before iOS 18 where `MeshGradient` doesn't exist.
struct TodayAuroraBackground: View {
    let light: Bool

    private var colors: [Color] { light ? Self.lightColors : Self.darkColors }

    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                // ponytail: 20fps drift — slow enough to barely cost battery, smooth
                // enough to read as "alive". Drop the interval if it ever feels jerky.
                TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { ctx in
                    let t = ctx.date.timeIntervalSinceReferenceDate
                    MeshGradient(width: 3, height: 3, points: Self.points(t), colors: colors)
                }
            } else {
                LinearGradient(colors: [colors.first!, colors.last!],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.5), value: light)
    }

    /// 3×3 control points; corners pinned, interior + edge-mids wobble on sine
    /// waves at different speeds so the gradient never visibly loops.
    static func points(_ t: Double) -> [SIMD2<Float>] {
        func w(_ base: Double, _ speed: Double, _ amp: Double) -> Float {
            Float(base + sin(t * speed) * amp)
        }
        return [
            [0, 0],                         [w(0.5, 0.6, 0.06), 0],                  [1, 0],
            [0, w(0.5, 0.5, 0.06)],         [w(0.5, 0.4, 0.08), w(0.5, 0.7, 0.08)], [1, w(0.5, 0.55, 0.06)],
            [0, 1],                         [w(0.5, 0.65, 0.06), 1],                 [1, 1]
        ]
    }

    // Dark: stays mostly true-black with a faint cool lift in the middle band — a
    // quiet depth, not a purple haze.
    private static let darkColors: [Color] = {
        let lift  = Color(red: 0.09, green: 0.10, blue: 0.13)
        let lift2 = Color(red: 0.11, green: 0.12, blue: 0.15)
        return [.black, .black, .black,
                lift,   lift2,  lift,
                .black, .black, .black]
    }()

    // Light: near-white overall with only a whisper of colour in the middle band —
    // clean white top AND bottom (no coloured blob hanging at the edges). Subtle on
    // purpose; the reference is a faint holographic sheen on white, not a wash.
    private static let lightColors: [Color] = {
        let white = Color(red: 0.98, green: 0.975, blue: 0.965)
        let lilac = Color(red: 0.91, green: 0.89,  blue: 0.97)
        let peach = Color(red: 0.99, green: 0.93,  blue: 0.89)
        let sky   = Color(red: 0.89, green: 0.94,  blue: 0.99)
        return [white, white, white,
                lilac, peach, sky,
                white, white, white]
    }()
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

    // No border — affordance comes from tracked-out uppercase type, not a stroked pill.
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .tracking(1.5)
                .textCase(.uppercase)
                .foregroundStyle(Color.appMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
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

/// The painterly weather sky that fades into the canvas — replaces the old boxed
/// `HeroSky`. Light mode is a warm day wash with drifting mist; dark mode is a deep
/// night that falls to black with a soft moon-glow and a few quiet stars. The bottom
/// of the gradient is clear so the page canvas shows through beneath it. No icons.
struct AtmosphereSky: View {
    @Environment(\.colorScheme) private var scheme
    /// OxyWeatherService symbolName, e.g. "cloud.rain" — only used to cool the palette.
    var condition: String?

    private var isRain: Bool { (condition ?? "").contains("rain") || (condition ?? "").contains("drizzle") }
    private var light: Bool { scheme != .dark }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12.0, paused: false)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            ZStack(alignment: .top) {
                LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom)

                if light {
                    // Two soft mist banks drifting at different speeds.
                    mist(width: 220, y: 150, phase: t * 0.05, amp: 22, opacity: 0.55)
                    mist(width: 180, y: 104, phase: -t * 0.04 + 2, amp: 18, opacity: 0.4)
                } else {
                    // A low moon glow + a scatter of faint, slowly breathing stars.
                    Circle()
                        .fill(RadialGradient(colors: [Color(white: 0.96), Color(white: 0.96).opacity(0)],
                                             center: .center, startRadius: 1, endRadius: 60))
                        .frame(width: 120, height: 120)
                        .offset(x: 96, y: 30)
                    ForEach(0..<7, id: \.self) { i in
                        let p = Double(i)
                        Circle()
                            .fill(Color.white)
                            .frame(width: 1.6, height: 1.6)
                            .opacity(0.25 + 0.55 * (0.5 + 0.5 * sin(t * 0.6 + p * 1.3)))
                            .offset(x: [-120, -40, 40, 120, -90, 70, 10][i],
                                    y: [40, 70, 52, 86, 120, 96, 150][i])
                    }
                }
            }
        }
        .ignoresSafeArea()
    }

    private func mist(width: CGFloat, y: CGFloat, phase: Double, amp: CGFloat, opacity: Double) -> some View {
        Ellipse()
            .fill(RadialGradient(colors: [Color.white.opacity(opacity), Color.white.opacity(0)],
                                 center: .center, startRadius: 1, endRadius: width / 2))
            .frame(width: width, height: width * 0.3)
            .offset(x: CGFloat(sin(phase)) * amp, y: y)
    }

    private var stops: [Gradient.Stop] {
        if light {
            if isRain {
                return [.init(color: Color(red: 0.79, green: 0.80, blue: 0.82), location: 0),
                        .init(color: Color(red: 0.91, green: 0.90, blue: 0.88), location: 0.34),
                        .init(color: .clear, location: 0.72)]
            }
            return [.init(color: Color(red: 0.95, green: 0.76, blue: 0.42), location: 0),
                    .init(color: Color(red: 0.96, green: 0.86, blue: 0.71), location: 0.32),
                    .init(color: Color(red: 0.98, green: 0.94, blue: 0.88), location: 0.55),
                    .init(color: .clear, location: 0.78)]
        }
        if isRain {
            return [.init(color: Color(red: 0.06, green: 0.09, blue: 0.13), location: 0),
                    .init(color: Color(red: 0.03, green: 0.05, blue: 0.08), location: 0.4),
                    .init(color: .clear, location: 0.74)]
        }
        return [.init(color: Color(red: 0.055, green: 0.114, blue: 0.188), location: 0),
                .init(color: Color(red: 0.043, green: 0.082, blue: 0.141), location: 0.34),
                .init(color: Color(red: 0.027, green: 0.043, blue: 0.078), location: 0.6),
                .init(color: .clear, location: 0.82)]
    }
}

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

/// Hairline rule with a small centred dot — the only divider ornament the language uses.
struct AppRule: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color.appHairline).frame(height: 0.5)
            Circle().fill(Color.appMuted.opacity(0.55)).frame(width: 3, height: 3)
            Rectangle().fill(Color.appHairline).frame(height: 0.5)
        }
    }
}

/// A tonal, grained plate for featured blocks (e.g. "This evening"). No border, no
/// shadow — it reads as a different stock of paper laid on the canvas.
struct EditorialPlate<Content: View>: View {
    var padding: CGFloat = 22
    @ViewBuilder var content: Content
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background {
                ZStack {
                    Color.appSurface
                    AppGrain(intensity: 0.06)
                }
            }
            .clipShape(shape)
    }
}

/// Editorial body text with a raised Didot initial (a versal). Not a true wrapping
/// drop cap — SwiftUI has no `::first-letter` — but it gives the paragraph an
/// editorial opening. `dropSize` is the initial's point size.
struct DropCapText: View {
    let text: String
    var bodySize: CGFloat = 16
    var dropSize: CGFloat = 38
    var color: Color = .appMuted

    private var attributed: AttributedString {
        var a = AttributedString(text)
        a.font = .system(size: bodySize, weight: .regular)
        a.foregroundColor = color
        if !a.characters.isEmpty {
            let end = a.index(a.startIndex, offsetByCharacters: 1)
            a[a.startIndex..<end].font = .custom("Didot", size: dropSize)
            a[a.startIndex..<end].foregroundColor = .appInk
        }
        return a
    }

    var body: some View {
        Text(attributed)
            .lineSpacing(4)
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
