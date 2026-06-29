import SwiftUI
import UIKit

/// "Silent Luxury" design tokens for the Nameless companion experience —
/// deep obsidian, titanium hairlines, soft white editorial type. Intentionally
/// fixed rather than light/dark-adaptive: this aesthetic doesn't bend to system
/// appearance, the same way a well-made object looks the same in any room.
// MARK: - Fixed pure-black palette
//
// One aesthetic, no finishes, no accents. Pure black canvas, titanium/silver
// hairlines, soft-white editorial type. Every view reads the `nml*` tokens
// below; there's nothing to switch.

extension Color {
    /// Resolves to `dark` under a dark colour scheme and `light` otherwise. Most of
    /// the app is pinned dark (OxyApp sets `.preferredColorScheme(.dark)`), so these
    /// stay on their dark values everywhere except the Today/Chat subtrees, which
    /// override `colorScheme` to flip the whole language to the light finish.
    static func nmlAdaptive(dark: Color, light: Color) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }

    /// Pure black background — the single canvas colour across the app. Stays black
    /// in both finishes (it doubles as the contrast colour on titanium fills); the
    /// light Today/Chat surfaces use the aurora gradient as their canvas, not this.
    static let nmlObsidian = Color.black
    /// Slightly raised surface for cards and rows — dark obsidian / clean white.
    static let nmlSurface = nmlAdaptive(dark: Color(red: 14 / 255, green: 14 / 255, blue: 16 / 255),
                                        light: Color.white.opacity(0.82))
    /// One step lighter still — for elements nested inside a surface (input fields, pills).
    static let nmlSurface2 = nmlAdaptive(dark: Color(red: 21 / 255, green: 21 / 255, blue: 23 / 255),
                                         light: Color.white.opacity(0.9))
    /// Hairline rule — titanium-on-black / ink-on-light, always drawn at 0.5pt.
    static let nmlHairline = nmlAdaptive(dark: Color(red: 198 / 255, green: 200 / 255, blue: 204 / 255).opacity(0.16),
                                         light: Color.black.opacity(0.10))
    /// Flat solid card border (#222222) for raw monospace telemetry cards.
    static let nmlCardBorder = Color(red: 34 / 255, green: 34 / 255, blue: 34 / 255)
    /// Soft titanium for icons, dots, and quiet emphasis. Fixed: it's also the fill
    /// behind black glyphs (send button), so it can't flip to a dark value.
    static let nmlTitanium = Color(red: 199 / 255, green: 202 / 255, blue: 206 / 255)
    /// Primary editorial type — soft white on dark, near-black ink on light.
    static let nmlInk = nmlAdaptive(dark: Color(red: 240 / 255, green: 239 / 255, blue: 235 / 255),
                                    light: Color(red: 0.13, green: 0.13, blue: 0.15))
    /// Muted secondary text for captions, eyebrows, secondary detail.
    static let nmlMuted = nmlAdaptive(dark: Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255),
                                      light: Color(red: 0.42, green: 0.42, blue: 0.46))
    /// Faint halo behind a live-status dot.
    static let nmlGlow = Color(red: 214 / 255, green: 217 / 255, blue: 220 / 255)

    // MARK: - Named surface fills
    //
    // White overlays on obsidian. Use these instead of inline Color.white.opacity(N)
    // so every surface lift has a consistent, auditable name.
    //
    //   ghost  — barely-there tint: inactive tabs, glass base
    //   subtle — slightly raised: button backgrounds, segmented control track
    //   bubble — user chat bubble fill
    //   scrim  — modal/sheet backdrop over the full screen

    static let nmlFillGhost  = Color.white.opacity(0.04)
    static let nmlFillSubtle = Color.white.opacity(0.08)
    /// User chat-bubble fill — a white lift on dark, an ink lift on light (a white
    /// tint would disappear against the light aurora canvas).
    static let nmlFillBubble = nmlAdaptive(dark: Color.white.opacity(0.13), light: Color.black.opacity(0.06))
    static let nmlFillScrim  = Color.black.opacity(0.45)

    // MARK: - Semantic status colours
    //
    // The one place hue is allowed to carry meaning in this otherwise monochrome
    // language: status indicators. A user should be able to read device/connector
    // state from colour alone. Reserved strictly for the `NamelessStatusDot` token
    // table below — not for decoration.
    //
    //   nmlLive       green   — active / live / streaming
    //   nmlGlow       silver  — enabled-and-idle (available, not currently live)
    //   nmlMuted      gray    — disabled / off
    //   nmlDanger     coral   — error / disconnected-with-a-problem / destructive
    //   nmlAttention  amber   — degraded / attention-needed (e.g. overdue)

    /// Green for a live/streaming link.
    static let nmlLive = Color(red: 0.30, green: 0.80, blue: 0.46)
    /// Amber for attention-needed / degraded states (overdue, needs-reconnect).
    static let nmlAttention = Color(red: 232 / 255, green: 176 / 255, blue: 84 / 255)
}

// MARK: - Radius scale
//
// Four named steps cover every shape in the product. Prefer these over raw literals.
//
//   sm     — 5pt  : status dots, small pill badges
//   card   — 8pt  : cards, rows, action chips, attachment strips
//   bubble — 20pt : chat bubble outer corners
//   input  — 22pt : text input container (near-capsule)

enum NMLRadius {
    static let sm:     CGFloat = 5
    static let card:   CGFloat = 8
    static let bubble: CGFloat = 20
    static let input:  CGFloat = 22
}

// MARK: - Animation tokens
//
// Three speed steps + one standard spring. Use these instead of inline duration literals.
//
//   nmlFast     — 0.15 s : micro-interactions, icon transitions
//   nmlStandard — 0.22 s : most UI state changes (modals, tab switching)
//   nmlRelax    — 0.40 s : content reveals, loading transitions
//   nmlSpring   — response 0.34 / damping 0.86 : nav slides, drawer open/close

extension Animation {
    static let nmlFast     = Animation.easeInOut(duration: 0.15)
    static let nmlStandard = Animation.easeInOut(duration: 0.22)
    static let nmlRelax    = Animation.easeInOut(duration: 0.4)
    static let nmlSpring   = Animation.spring(response: 0.34, dampingFraction: 0.86)
}

// MARK: - Typography rule (serif vs sans)
//
// Decide which face a new label takes by its SEMANTIC ROLE, not by taste:
//
//   • nmlDisplay (Fraunces, serif) — warm / identity / emotional moments ONLY:
//     greetings ("Good afternoon", "Welcome back."), empty-state prompts, and
//     Memory content category headers ("People", "Places"). The voice of the app.
//
//   • nmlBody (Inter, sans) — ALL functional/navigational/control UI: screen and
//     nav titles, settings rows, buttons, field labels, status text, captions.
//
//   • nmlMono — technical readouts only (battery, latency, ids, timestamps).
//
// If a label is something the user operates (a control, a title, a status), it's
// sans. If it's the product speaking to the user, it's serif. No other use of serif.
/// Maps a SwiftUI `Font.Weight` to its `UIFont.Weight` twin. `Font.Weight` isn't a
/// switchable enum, so a small lookup is the cleanest bridge for the metrics-scaled
/// monospace font below.
private func nmlUIFontWeight(_ w: Font.Weight) -> UIFont.Weight {
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

    /// Editorial display face (Didot) — iOS's built-in high-contrast Modern serif, the
    /// app-wide headline/identity voice per the Silent Luxury spec. Didot ships only
    /// Regular + Bold faces, so bold-ish weights map to Didot-Bold and everything else
    /// to Didot; `relativeTo:` keeps it scaling with Dynamic Type.
    static func nmlDisplay(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let bolds: Set<Font.Weight> = [.semibold, .bold, .heavy, .black]
        return .custom(bolds.contains(weight) ? "Didot-Bold" : "Didot", size: size, relativeTo: .title)
    }

    /// Body / UI face (Inter) — a clean, even grotesque for running text and labels.
    static func nmlBody(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Inter", size: size, relativeTo: .body).weight(weight)
    }

    /// Clean monospace for technical readouts — battery, latency, connection state.
    /// Scaled with Dynamic Type via UIFontMetrics (a fixed-size `.system` mono otherwise
    /// stays pinned no matter the user's text-size setting).
    static func nmlMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let base = UIFont.monospacedSystemFont(ofSize: size, weight: nmlUIFontWeight(weight))
        return Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: base))
    }
}

extension View {
    /// Editorial eyebrow: small Inter, tracked-out, in muted titanium.
    /// Use above a title to let the layout breathe instead of stacking bold labels.
    func nmlEyebrow() -> some View {
        font(.nmlBody(11, weight: .semibold))
            .tracking(2.6)
            .foregroundStyle(Color.nmlMuted)
    }

    /// A 0.5pt titanium hairline border — the only "accent" this aesthetic allows.
    func nmlHairline(radius: CGFloat) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius)
                .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
        )
    }
}

/// A small status dot whose colour carries meaning (see the token table in the
/// semantic-status section above). A soft halo only appears for the `.live` state,
/// so "live" reads differently from a merely "enabled" row at a glance.
struct NamelessStatusDot: View {
    enum Kind {
        case live      // green — active / streaming
        case enabled   // silver — enabled, idle
        case off       // gray — disabled / off
        case error     // coral — error / disconnected-with-a-problem
        case degraded  // amber — attention-needed

        var color: Color {
            switch self {
            case .live:     return .nmlLive
            case .enabled:  return .nmlGlow
            case .off:      return .nmlMuted.opacity(0.4)
            case .error:    return .nmlDanger
            case .degraded: return .nmlAttention
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

// MARK: - Unified "Nameless" list primitives
//
// Stock `List`/`Form` rows, grouped insets and the green system `Toggle` are
// banned across Settings, Connectors and Memory. These primitives replace them:
// flat rows on pure black, separated by ultra-thin titanium dividers, with raw
// typography instead of colourful SF-symbol tiles.

extension Color {
    /// Luminous coral for destructive actions and overdue states — warm rather than
    /// neon, but bright enough to clear contrast against the pure-black canvas.
    static let nmlDanger = Color(red: 235 / 255, green: 118 / 255, blue: 102 / 255)
}

/// An ultra-thin, low-opacity horizontal divider — the only separator the
/// language allows between rows.
struct NamelessDivider: View {
    var inset: CGFloat = 0
    var body: some View {
        Rectangle()
            // The spec separator: 0.5px ≈ #222222, tinted subtly by the active finish.
            .fill(Color.nmlHairline)
            .frame(height: 0.5)
            .padding(.leading, inset)
    }
}

/// Title Case, wide-tracked sans-serif section header in muted detail colour.
/// Elegant spacing instead of a loud uppercase monospace grid.
struct NamelessSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .regular))
            .tracking(2.4)
            .foregroundStyle(Color.nmlMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Minimalist custom toggle: a 30×16 capsule that slides between muted gray
/// (off) and soft silver (on). Replaces the stock green `Toggle`.
struct NamelessToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isOn.toggle() }
        } label: {
            Capsule()
                .fill(isOn ? Color.nmlInk : Color.white.opacity(0.12))
                .frame(width: 30, height: 16)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.nmlObsidian : Color.nmlMuted)
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
struct NamelessLineField: View {
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
            .foregroundStyle(Color.nmlInk)
            .tint(Color.nmlTitanium)
            .focused($isFocused)

            Rectangle()
                .fill(isFocused ? Color.nmlInk.opacity(0.55) : Color.white.opacity(0.08))
                .frame(height: isFocused ? 1 : 0.5)
                .animation(.easeInOut(duration: 0.2), value: isFocused)
        }
    }
}

// MARK: - Scale-on-press button style
//
// 0.96 is the calibrated value: tactile without feeling exaggerated.
// Apply to every tappable element that isn't a full-width navigation row.

struct NMLScaleButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .animation(.nmlFast, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == NMLScaleButtonStyle {
    static var nmlScale: NMLScaleButtonStyle { .init() }
    static func nmlScale(_ scale: CGFloat) -> NMLScaleButtonStyle { .init(scale: scale) }
}

/// The one loud gesture this language permits: a thick, full-width pill in stark
/// solid white with black text. Labels are bracketed and tracked-out.
struct NamelessPrimaryButton: View {
    let title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .tracking(1.5)
                // On-ink: contrasts with nmlInk in BOTH modes (white text on a dark fill in
                // light mode, black text on a light fill in dark mode). nmlObsidian was always
                // black and went invisible once light mode became real.
                .foregroundStyle(Color.edCanvas)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(Color.nmlInk)
                .clipShape(Capsule())
        }
        .buttonStyle(.nmlScale)
    }
}

// MARK: - Liquid Glass (iOS 26+)
//
// Apple's Liquid Glass material gives icon-sized chrome — header buttons, the
// composer's floating action button, floating overlays — a refractive,
// light-bending surface. It's reserved for that "chrome": flat list rows
// (Settings, Connectors, Memory, More) keep the existing raw-typography
// treatment untouched. On iOS 17–25, where `glassEffect` doesn't exist, a
// frosted `.ultraThinMaterial` approximation keeps the same silhouette and
// tint so the layout doesn't shift between OS versions.

extension View {
    /// Wraps an icon/control in Liquid Glass on iOS 26+, or a frosted-material
    /// approximation on earlier versions. `tint` carries through the control's
    /// existing accent colour (e.g. titanium-fill buttons); pass `nil` for a
    /// neutral glass chip. `interactive` adds the press/highlight response
    /// Liquid Glass gives tappable controls.
    @ViewBuilder
    func nmlGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.nmlGlassStyle(tint: tint, interactive: interactive), in: shape)
        } else {
            self.background { NamelessGlassFill(shape: shape, tint: tint) }
        }
    }

    @available(iOS 26.0, *)
    fileprivate static func nmlGlassStyle(tint: Color?, interactive: Bool) -> Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        if interactive { glass = glass.interactive() }
        return glass
    }
}

/// A hand-built glass fill for iOS 17–25, where Apple's `glassEffect` doesn't
/// exist. A flat `.ultraThinMaterial` reads as frosted plastic; real glass needs
/// the cues the eye looks for — a frosted base, a top-down sheen where light
/// gathers, a bright specular highlight on the upper rim, and a refractive edge
/// that fades toward the bottom. Layering those makes a chip read as glass on a
/// pure-black UI instead of a dim disc.
private struct NamelessGlassFill<S: InsettableShape>: View {
    let shape: S
    let tint: Color?

    var body: some View {
        ZStack {
            // Frosted base + a faint wash (or the control's tint) so it's visible on black.
            shape.fill(.ultraThinMaterial)
            shape.fill((tint ?? Color.white).opacity(tint == nil ? 0.06 : 0.22))

            // Sheen: light gathers along the top and falls off downward.
            shape.fill(
                LinearGradient(
                    colors: [
                        Color.white.opacity(0.24),
                        Color.white.opacity(0.0),
                        Color.white.opacity(0.05)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )

            // Refractive rim: bright at the top edge, dim at the bottom.
            shape.strokeBorder(
                LinearGradient(
                    colors: [
                        Color.white.opacity(0.6),
                        Color.white.opacity(0.14),
                        Color.white.opacity(0.04)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                lineWidth: 0.75
            )
        }
        .compositingGroup()
        .shadow(color: Color.black.opacity(0.35), radius: 4, y: 2)
    }
}

/// Groups adjacent Liquid Glass controls so iOS 26 can render them as a single
/// fluid surface that can morph between states. No-op passthrough on iOS 17–25.
@ViewBuilder
func nmlGlassContainer<Content: View>(spacing: CGFloat = 12, @ViewBuilder content: () -> Content) -> some View {
    if #available(iOS 26.0, *) {
        GlassEffectContainer(spacing: spacing, content: content)
    } else {
        content()
    }
}

// MARK: - NMLCard
//
// The single shared card surface. Every raised container in the product (Today cards,
// More menu, action rows, attachment strips) should use this instead of defining its own
// background + border + radius triple. The content is left-aligned by default; pass a
// different alignment via the view modifier if needed.

struct NMLCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(Color.nmlSurface)
            .clipShape(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous)
                    .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
            )
    }
}

// MARK: - BrandWordmark
//
// The Milgrain wordmark asset, template-rendered so it adapts to any tint on the
// obsidian canvas. Default: muted titanium at 14pt height (as used in the More tab
// identity header). Pass a different height or color for alternate contexts.

struct BrandWordmark: View {
    var height: CGFloat = 14
    var color: Color = .nmlMuted

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
// the softer app-wide `nml*` tokens (off-black canvas, warm off-white ink, translucent
// titanium hairlines) so Chat / Today / Onboarding are left untouched.

extension Color {
    // Adaptive: resolves light/dark from the environment colorScheme, which the app root
    // drives from the user's AppAppearance setting (.system follows iOS). Dark values are
    // the Milgrain spec; light values are the inverted equivalents.
    static let mgBg = nmlAdaptive(dark: Color(red: 10 / 255, green: 10 / 255, blue: 10 / 255), // #0A0A0A
                                  light: Color(red: 250 / 255, green: 250 / 255, blue: 249 / 255)) // near-white
    static let mgDivider = nmlAdaptive(dark: Color(red: 26 / 255, green: 26 / 255, blue: 26 / 255), // #1A1A1A
                                       light: Color.black.opacity(0.10))
    static let mgHeading = nmlAdaptive(dark: Color.white,                                     // #FFFFFF
                                       light: Color(red: 0.11, green: 0.11, blue: 0.12))      // near-black
    static let mgSecondary = nmlAdaptive(dark: Color(red: 136 / 255, green: 136 / 255, blue: 136 / 255), // #888
                                         light: Color(red: 0.42, green: 0.42, blue: 0.46))
    static let mgCaption = nmlAdaptive(dark: Color(red: 85 / 255, green: 85 / 255, blue: 85 / 255), // #555
                                       light: Color(red: 0.56, green: 0.56, blue: 0.58))
    static let mgOff = nmlAdaptive(dark: Color(red: 51 / 255, green: 51 / 255, blue: 51 / 255), // #333 toggle off
                                   light: Color(white: 0.82))
    /// Fixed both finishes — system red reads on black and white alike.
    static let mgDestructive = Color(red: 255 / 255, green: 59 / 255, blue: 48 / 255)          // #FF3B30
}

extension Font {
    /// Didot — iOS's built-in high-contrast Modern serif. Headings and the wordmark
    /// ONLY (17pt and up): its hairline strokes alias and turn muddy at small sizes,
    /// so labels and captions stay in the clean sans. Default weight is bold per spec.
    static func mgDidot(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        let bolds: Set<Font.Weight> = [.semibold, .bold, .heavy, .black]
        return .custom(bolds.contains(weight) ? "Didot-Bold" : "Didot", size: size, relativeTo: .title)
    }
}

/// Full-bleed dark hairline (#1A1A1A, 0.5pt) — the Milgrain row separator.
struct MilgrainDivider: View {
    var body: some View {
        Rectangle().fill(Color.mgDivider).frame(height: 0.5)
    }
}

/// Editorial section header — a Didot title in editorial ink, Title-case, left-aligned,
/// no background. The settings-family counterpart to `EditorialSectionTitle`.
struct MilgrainSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.nmlDisplay(20))
            .foregroundStyle(Color.edInk)
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
                .fill(isOn ? Color.mgHeading : Color.mgOff)
                .frame(width: 30, height: 16)
                .overlay(
                    Circle()
                        .fill(isOn ? Color.mgBg : Color.mgSecondary)
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
/// No capsule track, no fill, no pill (per the Silent Luxury spec: zero pill shapes).
/// `options` holds the stored values; pass `labels` when the display text differs.
struct MilgrainSegmentedControl: View {
    let options: [String]
    var labels: [String]? = nil
    @Binding var selection: String

    private func label(_ index: Int) -> String {
        if let labels, index < labels.count { return labels[index] }
        return options[index]
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 {
                    Rectangle()
                        .fill(Color.mgDivider)
                        .frame(width: 0.5, height: 18)
                }
                let isSelected = selection == option
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { selection = option }
                    HapticManager.shared.impact(.light)
                } label: {
                    Text(label(index))
                        .font(.system(size: 14, weight: .light))
                        .foregroundStyle(isSelected ? Color.mgHeading : Color.mgSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
            }
        }
    }
}

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

/// A glass card for the Today tab — same silhouette as `NMLCard` but with a
/// refractive Liquid Glass surface instead of an opaque fill, so it picks up the
/// aurora gradient behind it. Group these in `nmlGlassContainer` to get the fluid
/// morph between cards on iOS 26.
struct TodayCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var scheme

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background {
                // Both finishes use a plain shape FILL (not a glassEffect/material modifier):
                // a glass-effect background applies vibrancy to the card's content and washes
                // the text out. A fill keeps the content text at full contrast.
                if scheme == .dark {
                    shape.fill(Color(red: 0.10, green: 0.10, blue: 0.12))
                    shape.strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                } else {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(Color.white.opacity(0.55))
                    shape.strokeBorder(Color.white.opacity(0.7), lineWidth: 0.5)
                }
            }
            .clipShape(shape)
            .shadow(color: Color.black.opacity(scheme == .dark ? 0 : 0.07), radius: 14, y: 6)
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

// MARK: - Scroll-aware tab bar
//
// Reddit/iOS-style: the floating tab bar tucks away while you scroll down into
// content and slides back when you scroll up (or reach the top). A single shared
// observable carries the hidden state; each scroll view reports its direction via
// `hidesTabBarOnScroll()` and MainTabView reads `hidden` to offset the bar.

@Observable final class TabBarVisibility {
    var hidden = false
}

private struct HidesTabBarOnScroll: ViewModifier {
    @Environment(TabBarVisibility.self) private var visibility

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { oldY, newY in
                // Ignore rubber-banding above the top and sub-pixel jitter.
                guard newY > 0 else { withAnimation(.nmlStandard) { visibility.hidden = false }; return }
                let delta = newY - oldY
                guard abs(delta) > 6 else { return }
                withAnimation(.nmlStandard) { visibility.hidden = delta > 0 && newY > 40 }
            }
        } else {
            content // ponytail: pre-iOS-18 just keeps the bar pinned; not worth a manual offset reader.
        }
    }
}

extension View {
    /// Hide the floating tab bar while scrolling down this scroll view, reveal it on
    /// scroll-up or at the top. Attach to a `ScrollView` inside a tab.
    func hidesTabBarOnScroll() -> some View { modifier(HidesTabBarOnScroll()) }
}

/// The quiet counterpart: border-only, muted titanium text, no fill.
struct NamelessOutlineButton: View {
    let title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .tracking(1.5)
                .foregroundStyle(Color.nmlMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5))
        }
        .buttonStyle(.nmlScale)
    }
}

// MARK: - Editorial language (de-gadgeted, whole-app)
//
// The product reads as a beautifully made editorial object, not a device dashboard.
// Colour lives only in the painterly weather sky; the canvas stays warm-white (light)
// or true black (dark) and all content is monochrome, tone-adaptive. These tokens and
// primitives are the shared vocabulary for every screen.

extension Color {
    /// Warm-white by day, true black at night — the page canvas the whole app sits on.
    static let edCanvas = nmlAdaptive(dark: .black,
                                      light: Color(red: 255 / 255, green: 253 / 255, blue: 249 / 255))
    /// Primary editorial ink — soft off-white on black, warm near-black on white.
    static let edInk = nmlAdaptive(dark: Color(red: 236 / 255, green: 234 / 255, blue: 228 / 255),
                                   light: Color(red: 42 / 255, green: 36 / 255, blue: 29 / 255))
    /// Muted secondary — captions, times, metadata. Warm taupe on white, cool grey on black.
    static let edMuted = nmlAdaptive(dark: Color(red: 124 / 255, green: 122 / 255, blue: 128 / 255),
                                     light: Color(red: 168 / 255, green: 154 / 255, blue: 134 / 255))
    /// Tonal plate fill for featured blocks — deep charcoal on black, warm taupe on white.
    static let edPlate = nmlAdaptive(dark: Color(red: 16 / 255, green: 15 / 255, blue: 13 / 255),
                                     light: Color(red: 239 / 255, green: 230 / 255, blue: 216 / 255))
    /// Hairline rule for editorial dividers.
    static let edRule = nmlAdaptive(dark: Color.white.opacity(0.10),
                                    light: Color(red: 230 / 255, green: 221 / 255, blue: 207 / 255))
}

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
struct PaperGrain: View {
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
struct EditorialSectionTitle: View {
    let text: String
    var size: CGFloat = 22
    init(_ text: String, size: CGFloat = 22) { self.text = text; self.size = size }
    var body: some View {
        Text(text)
            .font(.nmlDisplay(size))
            .foregroundStyle(Color.edInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Hairline rule with a small centred dot — the only divider ornament the language uses.
struct EditorialRule: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color.edRule).frame(height: 0.5)
            Circle().fill(Color.edMuted.opacity(0.55)).frame(width: 3, height: 3)
            Rectangle().fill(Color.edRule).frame(height: 0.5)
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
                    Color.edPlate
                    PaperGrain(intensity: 0.06)
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
    var color: Color = .edMuted

    private var attributed: AttributedString {
        var a = AttributedString(text)
        a.font = .system(size: bodySize, weight: .regular)
        a.foregroundColor = color
        if !a.characters.isEmpty {
            let end = a.index(a.startIndex, offsetByCharacters: 1)
            a[a.startIndex..<end].font = .custom("Didot", size: dropSize)
            a[a.startIndex..<end].foregroundColor = .edInk
        }
        return a
    }

    var body: some View {
        Text(attributed)
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
