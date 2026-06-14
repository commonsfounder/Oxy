import SwiftUI

/// "Feminine-luxe" design tokens for the Oxy companion experience — a jewelry
/// register (Hermès / Calm / Oura): warm pearl daytime canvas, soft metallic
/// finishes, large airy editorial type. Two axes now: a *finish* (the metal) and
/// an *appearance* (Soft/light, the default, or Dark). Every view reads the `nml*`
/// tokens below, so changing either axis re-skins the whole app from this one place.
// MARK: - Customization engine
//
// A finish is the metal — accent / glow / border-warmth. An appearance is the
// canvas the metal sits on. Each finish carries both a dark and a light neutral
// set; the token getters pick the right one for the active appearance.

/// A single finish: the metallic colourway plus its dark + light neutral palettes.
struct OxyThemeProfile: Identifiable, Equatable {
    let id: String
    let name: String
    // Metallic identity — shared across appearances, two tunings for legibility.
    let accent: Color        // accent on the dark canvas
    let accentLight: Color   // deeper accent so the metal stays legible on light
    let accentDeep: Color    // darkest stop of the metal gradient (jewelry shine)
    let glow: Color          // lightest stop / halo behind a live dot
    // Dark neutrals
    let inkD, mutedD, borderD, surfaceD, surface2D, bgD: Color
    // Light / Soft neutrals
    let inkL, mutedL, borderL, surfaceL, surface2L, bgL: Color

    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> Color {
        Color(red: r / 255, green: g / 255, blue: b / 255)
    }

    /// This finish's own metal gradient — used for live swatches in the picker,
    /// independent of which finish is currently active.
    var metal: LinearGradient {
        LinearGradient(colors: [glow, accent, accentDeep], startPoint: .top, endPoint: .bottom)
    }

    /// Shared warm-pearl light canvas — only the metal differs between finishes.
    private static func make(
        id: String, name: String,
        accent: Color, accentLight: Color, accentDeep: Color, glow: Color,
        inkD: Color, mutedD: Color, borderD: Color, surfaceD: Color, surface2D: Color, bgD: Color
    ) -> OxyThemeProfile {
        OxyThemeProfile(
            id: id, name: name,
            accent: accent, accentLight: accentLight, accentDeep: accentDeep, glow: glow,
            inkD: inkD, mutedD: mutedD, borderD: borderD, surfaceD: surfaceD, surface2D: surface2D, bgD: bgD,
            inkL: rgb(28, 26, 23), mutedL: rgb(124, 116, 107), borderL: rgb(222, 216, 207),
            surfaceL: rgb(252, 250, 246), surface2L: rgb(244, 240, 233), bgL: rgb(247, 244, 239)
        )
    }

    /// Sterling Silver — cool nacreous steel. The default finish.
    static let titanium = make(
        id: "titanium", name: "Sterling Silver",
        accent: rgb(199, 202, 206), accentLight: rgb(120, 124, 130), accentDeep: rgb(92, 96, 102), glow: rgb(214, 217, 220),
        inkD: rgb(240, 239, 235), mutedD: rgb(166, 166, 171), borderD: rgb(36, 36, 38),
        surfaceD: rgb(14, 14, 16), surface2D: rgb(21, 21, 23), bgD: rgb(7, 7, 8)
    )

    /// Warm Gold — deep champagne shine.
    static let gold = make(
        id: "gold", name: "Warm Gold",
        accent: rgb(200, 168, 118), accentLight: rgb(150, 116, 58), accentDeep: rgb(120, 92, 46), glow: rgb(224, 207, 168),
        inkD: rgb(244, 239, 230), mutedD: rgb(168, 158, 145), borderD: rgb(44, 38, 28),
        surfaceD: rgb(16, 14, 10), surface2D: rgb(24, 21, 15), bgD: rgb(8, 7, 5)
    )

    /// Rose Gold — warm blush metal.
    static let roseGold = make(
        id: "rose", name: "Rose Gold",
        accent: rgb(214, 158, 150), accentLight: rgb(176, 110, 104), accentDeep: rgb(138, 84, 80), glow: rgb(236, 200, 194),
        inkD: rgb(245, 236, 233), mutedD: rgb(174, 156, 152), borderD: rgb(46, 34, 32),
        surfaceD: rgb(17, 12, 12), surface2D: rgb(25, 18, 18), bgD: rgb(9, 6, 6)
    )

    /// Pearl / Opalescent — cool iridescent nacre.
    static let pearl = make(
        id: "pearl", name: "Pearl",
        accent: rgb(222, 214, 224), accentLight: rgb(150, 140, 158), accentDeep: rgb(110, 104, 122), glow: rgb(236, 230, 240),
        inkD: rgb(243, 240, 244), mutedD: rgb(170, 165, 174), borderD: rgb(40, 37, 44),
        surfaceD: rgb(14, 13, 16), surface2D: rgb(22, 20, 25), bgD: rgb(7, 6, 9)
    )
}

/// The finish engine. The finish and the appearance both live in UserDefaults so
/// the plain `static` colour tokens can read them synchronously; the app root
/// re-keys its identity on the same values so a change re-skins every screen.
enum OxyTheme {
    static let storageKey = "oxy_theme_profile"
    static let appearanceKey = "oxy_appTheme"   // "soft" (default) | "dark"
    static let profiles: [OxyThemeProfile] = [.titanium, .gold, .roseGold, .pearl]

    static var current: OxyThemeProfile {
        let id = UserDefaults.standard.string(forKey: storageKey) ?? OxyThemeProfile.titanium.id
        return profiles.first { $0.id == id } ?? .titanium
    }

    /// Soft/light is the daytime-first default; only an explicit "dark" opts out.
    static var isLight: Bool {
        UserDefaults.standard.string(forKey: appearanceKey) != "dark"
    }
}

extension Color {
    /// The canvas. Warm pearl by day, near-black by night.
    static var nmlBackground: Color {
        let p = OxyTheme.current
        return OxyTheme.isLight ? p.bgL : p.bgD
    }
    /// Legacy alias — many views still paint `nmlObsidian`; now appearance-aware.
    static var nmlObsidian: Color { nmlBackground }
    /// Slightly raised surface for cards and rows.
    static var nmlSurface: Color { OxyTheme.isLight ? OxyTheme.current.surfaceL : OxyTheme.current.surfaceD }
    /// One step further — for elements nested inside a surface (input fields, pills).
    static var nmlSurface2: Color { OxyTheme.isLight ? OxyTheme.current.surface2L : OxyTheme.current.surface2D }
    /// Hairline / container border, tinted subtly by the active finish + appearance.
    static var nmlHairline: Color { OxyTheme.isLight ? OxyTheme.current.borderL : OxyTheme.current.borderD }
    /// Flat solid container border — same source as the hairline.
    static var nmlCardBorder: Color { nmlHairline }
    /// The finish accent — icons, dots, interactive text, quiet emphasis.
    static var nmlTitanium: Color { OxyTheme.isLight ? OxyTheme.current.accentLight : OxyTheme.current.accent }
    /// Primary editorial type for the active finish + appearance.
    static var nmlInk: Color { OxyTheme.isLight ? OxyTheme.current.inkL : OxyTheme.current.inkD }
    /// Muted secondary detail.
    static var nmlMuted: Color { OxyTheme.isLight ? OxyTheme.current.mutedL : OxyTheme.current.mutedD }
    /// Faint halo behind a live-status dot.
    static var nmlGlow: Color { OxyTheme.current.glow }
    /// Dark text that reads on a light metal fill (gold/silver pill, swatch).
    static var nmlOnMetal: Color { Color(red: 0.10, green: 0.09, blue: 0.08) }
    /// A subtle raised fill that works on either canvas (ink-tinted on light,
    /// white-tinted on dark). Use instead of bare `Color.white.opacity(...)`.
    static func nmlFill(_ amount: Double = 0.06) -> Color {
        (OxyTheme.isLight ? Color.black : Color.white).opacity(amount)
    }
}

extension ShapeStyle where Self == LinearGradient {
    /// The jewelry shine — light at the top edge, accent in the middle, deep at the
    /// foot. Used for the gold user bubble, finish swatches, and the primary button.
    static var nmlMetal: LinearGradient {
        let p = OxyTheme.current
        return LinearGradient(
            colors: [p.glow, p.accent, p.accentDeep],
            startPoint: .top, endPoint: .bottom
        )
    }
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
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? AnyShapeStyle(.nmlMetal) : AnyShapeStyle(Color.nmlMuted.opacity(0.22)))
                    .frame(width: 46, height: 28)
                Circle()
                    .fill(isOn ? Color.nmlOnMetal : Color.nmlMuted)
                    .frame(width: 22, height: 22)
                    .padding(3)
            }
            .frame(width: 46, height: 28)
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
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(Color.nmlInk)
            .tint(Color.nmlTitanium)
            .focused($isFocused)

            Rectangle()
                .fill(isFocused ? Color.nmlTitanium : Color.nmlHairline)
                .frame(height: isFocused ? 1 : 0.5)
                .animation(.easeInOut(duration: 0.2), value: isFocused)
        }
    }
}

/// The signature gesture: a thick, full-width pill filled with the finish's metal
/// gradient — a piece of jewelry you press. Dark ink text reads on the light metal.
struct NamelessPrimaryButton: View {
    let title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(Color.nmlOnMetal)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(.nmlMetal, in: Capsule())
                .shadow(color: Color.nmlGlow.opacity(0.35), radius: 12, y: 4)
        }
        .buttonStyle(.plain)
    }
}

/// An SF Symbol set in a generous liquid-glass chip — the "fleshed out" icon
/// treatment used for row leadings, header controls and inline affordances so
/// glyphs read as tappable objects rather than tiny bare marks.
struct NamelessGlassIcon: View {
    let systemName: String
    var size: CGFloat = 19
    var diameter: CGFloat = 44
    var tint: Color? = nil
    var weight: Font.Weight = .regular

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(tint == nil ? Color.nmlTitanium : Color.nmlOnMetal)
            .frame(width: diameter, height: diameter)
            .nmlGlass(Circle(), tint: tint, interactive: true)
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

/// The quiet counterpart: border-only, muted titanium text, no fill.
struct NamelessOutlineButton: View {
    let title: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(Color.nmlTitanium)
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .overlay(Capsule().strokeBorder(Color.nmlHairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
