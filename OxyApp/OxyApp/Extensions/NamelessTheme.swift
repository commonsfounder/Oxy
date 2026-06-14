import SwiftUI

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

/// A single finish: the colourway that paints the app's accents, text and rules
/// on top of the invariant pure-black canvas.
struct OxyThemeProfile: Identifiable, Equatable {
    let id: String
    let name: String
    /// Primary editorial text.
    let ink: Color
    /// Secondary captions and quiet detail.
    let muted: Color
    /// The accent — interactive text, active states, quiet emphasis.
    let accent: Color
    /// Halo behind a live-status dot.
    let glow: Color
    /// Hairline rules and container borders (the only separators allowed).
    let border: Color
    /// Slightly-raised surface for nested fields.
    let surface: Color
    let surface2: Color

    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> Color {
        Color(red: r / 255, green: g / 255, blue: b / 255)
    }

    /// Raw Obsidian — pure black, dark-grey accents, near-white text.
    static let obsidian = OxyThemeProfile(
        id: "obsidian", name: "Raw Obsidian",
        ink: rgb(250, 250, 250), muted: rgb(110, 110, 115),
        accent: rgb(124, 124, 130), glow: rgb(184, 184, 190),
        border: rgb(34, 34, 34), surface: rgb(12, 12, 13), surface2: rgb(22, 22, 24)
    )

    /// Brushed Titanium — pure black, muted steel-grey accents, cool silver detail.
    static let titanium = OxyThemeProfile(
        id: "titanium", name: "Brushed Titanium",
        ink: rgb(240, 239, 235), muted: rgb(142, 142, 147),
        accent: rgb(199, 202, 206), glow: rgb(214, 217, 220),
        border: rgb(34, 34, 34), surface: rgb(14, 14, 16), surface2: rgb(21, 21, 23)
    )

    /// Warm Gold — pure black, deep champagne accents, soft gold detail.
    static let gold = OxyThemeProfile(
        id: "gold", name: "Warm Gold",
        ink: rgb(244, 239, 230), muted: rgb(140, 131, 120),
        accent: rgb(200, 168, 118), glow: rgb(224, 207, 168),
        border: rgb(41, 35, 26), surface: rgb(16, 14, 10), surface2: rgb(24, 21, 15)
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
    /// Pure black background — the single canvas colour, invariant across finishes.
    static let nmlObsidian = Color.black
    /// Slightly raised obsidian surface for cards and rows.
    static var nmlSurface: Color { OxyTheme.current.surface }
    /// One step lighter still — for elements nested inside a surface (input fields, pills).
    static var nmlSurface2: Color { OxyTheme.current.surface2 }
    /// Hairline / container border (≈#222222), tinted subtly by the active finish.
    static var nmlHairline: Color { OxyTheme.current.border }
    /// Flat solid container border — same source as the hairline.
    static var nmlCardBorder: Color { OxyTheme.current.border }
    /// The finish accent — icons, dots, interactive text, quiet emphasis.
    static var nmlTitanium: Color { OxyTheme.current.accent }
    /// Primary editorial type for the active finish.
    static var nmlInk: Color { OxyTheme.current.ink }
    /// Muted secondary detail for the active finish.
    static var nmlMuted: Color { OxyTheme.current.muted }
    /// Faint halo behind a live-status dot.
    static var nmlGlow: Color { OxyTheme.current.glow }
}

extension Font {
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
            Text("[ \(title) ]")
                .font(.system(size: 14, weight: .semibold))
                .tracking(2)
                .foregroundStyle(Color.black)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(Color.white)
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
            Text("[ \(title) ]")
                .font(.system(size: 14, weight: .medium))
                .tracking(2)
                .foregroundStyle(Color.nmlMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}
