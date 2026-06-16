import SwiftUI
import UIKit

/// "Silent Luxury" design tokens for the Nameless companion experience —
/// deep obsidian, titanium hairlines, soft white editorial type. Intentionally
/// fixed rather than light/dark-adaptive: this aesthetic doesn't bend to system
/// appearance, the same way a well-made object looks the same in any room.
// MARK: - Customization engine
//
// One luxury aesthetic, three finishes. The background is always pure black and
// the *structure* never changes — only the subtle accent/detail/border colourway
// shifts between profiles. Every view reads the `nml*` colour tokens below, so
// switching the finish re-skins the entire app from this one place.

/// A finish is a colourway — it paints the accent on top of the active appearance
/// (light or dark). The neutrals (canvas, ink, surfaces, hairlines) come from the
/// appearance; the finish only shifts the accent + glow.
struct OxyThemeProfile: Identifiable, Equatable {
    let id: String
    let name: String
    /// Accent on a dark canvas — interactive text, active states, quiet emphasis.
    let accent: Color
    /// Accent on a light canvas — darker so it stays legible on bone.
    let accentLight: Color
    /// Halo behind a live-status dot.
    let glow: Color

    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> Color {
        Color(red: r / 255, green: g / 255, blue: b / 255)
    }

    /// Onyx — neutral graphite. (id stays "obsidian" so saved selections survive.)
    static let obsidian = OxyThemeProfile(
        id: "obsidian", name: "Onyx",
        accent: rgb(124, 124, 130), accentLight: rgb(86, 86, 92), glow: rgb(184, 184, 190)
    )

    /// Moonstone — warm silver (default). (id stays "titanium".)
    static let titanium = OxyThemeProfile(
        id: "titanium", name: "Moonstone",
        accent: rgb(208, 203, 196), accentLight: rgb(110, 101, 90), glow: rgb(222, 217, 209)
    )

    /// Champagne — soft gold. (id stays "gold".)
    static let gold = OxyThemeProfile(
        id: "gold", name: "Champagne",
        accent: rgb(200, 168, 118), accentLight: rgb(150, 120, 62), glow: rgb(224, 207, 168)
    )
}

/// The finish engine. The selection lives in UserDefaults so the plain `static`
/// colour tokens can read it synchronously; the app root re-keys its identity on
/// the same value so a change re-skins every screen at once.
enum OxyTheme {
    static let storageKey = "oxy_theme_profile"
    static let profiles: [OxyThemeProfile] = [.obsidian, .titanium, .gold]

    static var current: OxyThemeProfile {
        let id = UserDefaults.standard.string(forKey: storageKey) ?? OxyThemeProfile.titanium.id
        return profiles.first { $0.id == id } ?? .titanium
    }
}

extension Color {
    // Neutrals adapt to the active appearance (oxy_appTheme: light/dark/system) via the
    // same trait-aware resolver the rest of the app uses. Dark = warm near-black; light =
    // warm bone. The finish only shifts the accent on top.
    private static func nmlHex(_ hex: UInt) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// Canvas — obsidian. (Light kept for the resolver, but the app is dark-by-design now.)
    static var nmlObsidian: Color { dynamicColor(light: nmlHex(0xEDE7DB), dark: nmlHex(0x0A0A0F)) }
    /// Slightly raised surface for cards and rows.
    static var nmlSurface: Color { dynamicColor(light: nmlHex(0xF6F1E8), dark: nmlHex(0x16161F)) }
    /// One step lighter still — fields, pills nested inside a surface.
    static var nmlSurface2: Color { dynamicColor(light: nmlHex(0xEFE9DD), dark: nmlHex(0x1E1E28)) }
    /// Hairline / container border.
    static var nmlHairline: Color { dynamicColor(light: nmlHex(0xD9D2C5), dark: nmlHex(0x2A2A36)) }
    /// Flat solid container border — same source as the hairline.
    static var nmlCardBorder: Color { nmlHairline }
    /// The finish accent — icons, dots, interactive text, quiet emphasis.
    static var nmlTitanium: Color {
        dynamicColor(light: UIColor(OxyTheme.current.accentLight), dark: UIColor(OxyTheme.current.accent))
    }
    /// Primary type — luminous white on the obsidian canvas.
    static var nmlInk: Color { dynamicColor(light: nmlHex(0x1B1712), dark: nmlHex(0xF5F5F8)) }
    /// Muted secondary detail.
    static var nmlMuted: Color { dynamicColor(light: nmlHex(0x8A8076), dark: nmlHex(0x9A9AA8)) }
    /// Faint halo behind a live-status dot.
    static var nmlGlow: Color { OxyTheme.current.glow }
}

extension Font {
    /// Display type — SF Pro, tight and luminous. (Was Fraunces; unified to system SF Pro
    /// for the generative aesthetic.)
    static func nmlDisplay(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight)
    }

    /// Body / UI type — SF Pro. (Was Inter.)
    static func nmlBody(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// Clean monospace for technical readouts — battery, latency, connection state.
    static func nmlMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension View {
    /// Editorial eyebrow: small, tracked-out, small-caps in muted titanium.
    /// Use above a title to let the layout breathe instead of stacking bold labels.
    func nmlEyebrow() -> some View {
        font(.system(size: 11, weight: .semibold))
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

/// A small glowing dot used in place of loud status badges — silver when live,
/// dim titanium when idle. No neon, no pulsing rings; the glow is a soft halo.
struct NamelessStatusDot: View {
    var isLive: Bool
    var diameter: CGFloat = 6

    var body: some View {
        ZStack {
            if isLive {
                Circle()
                    .fill(Color.nmlGlow.opacity(0.35))
                    .frame(width: diameter * 2.4, height: diameter * 2.4)
                    .blur(radius: diameter * 0.5)
            }
            Circle()
                .fill(isLive ? Color.nmlGlow : Color.nmlMuted.opacity(0.4))
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
    /// Muted clay red for destructive actions — desaturated so it never reads neon.
    static let nmlDanger = Color(red: 196 / 255, green: 104 / 255, blue: 92 / 255)
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
                .foregroundStyle(Color.nmlObsidian)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(Color.nmlInk)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
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
            .highPriorityGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        guard value.startLocation.x < edgeWidth, value.translation.width > 0 else { return }
                        offset = value.translation.width
                    }
                    .onEnded { value in
                        if value.startLocation.x < edgeWidth, value.translation.width > dismissThreshold {
                            dismiss()
                        } else {
                            withAnimation(.easeOut(duration: 0.2)) { offset = 0 }
                        }
                    }
            )
    }
}

extension View {
    /// Edge-swipe-to-dismiss for full-screen covers. Apply to the presented screen's root.
    func swipeToDismiss() -> some View { modifier(SwipeToDismissModifier()) }
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
        .buttonStyle(.plain)
    }
}
