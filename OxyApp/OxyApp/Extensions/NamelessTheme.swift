import SwiftUI

/// "Silent Luxury" design tokens for the Nameless companion experience —
/// deep obsidian, titanium hairlines, soft white editorial type. Intentionally
/// fixed rather than light/dark-adaptive: this aesthetic doesn't bend to system
/// appearance, the same way a well-made object looks the same in any room.
extension Color {
    /// Pure black background — the single canvas colour across the app.
    static let nmlObsidian = Color.black
    /// Slightly raised obsidian surface for cards and rows.
    static let nmlSurface = Color(red: 14 / 255, green: 14 / 255, blue: 16 / 255)
    /// One step lighter still — for elements nested inside a surface (input fields, pills).
    static let nmlSurface2 = Color(red: 21 / 255, green: 21 / 255, blue: 23 / 255)
    /// Titanium/silver hairline — always drawn at 0.5pt.
    static let nmlHairline = Color(red: 198 / 255, green: 200 / 255, blue: 204 / 255).opacity(0.16)
    /// Soft titanium for icons, dots, and quiet emphasis.
    static let nmlTitanium = Color(red: 199 / 255, green: 202 / 255, blue: 206 / 255)
    /// Soft white for primary editorial type — intentionally never pure white.
    static let nmlInk = Color(red: 240 / 255, green: 239 / 255, blue: 235 / 255)
    /// Muted secondary gray (#8E8E93) for captions, eyebrows, and secondary detail.
    static let nmlMuted = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255)
    /// Faint halo behind a live-status dot.
    static let nmlGlow = Color(red: 214 / 255, green: 217 / 255, blue: 220 / 255)
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
            .textCase(.uppercase)
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
            .fill(Color.white.opacity(0.08))
            .frame(height: 0.5)
            .padding(.leading, inset)
    }
}

/// Small, uppercase, wide-tracked monospaced section header in muted gray.
struct NamelessSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(2)
            .textCase(.uppercase)
            .foregroundStyle(Color.gray)
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
