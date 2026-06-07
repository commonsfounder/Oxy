import SwiftUI

/// "Silent Luxury" design tokens for the Nameless companion experience —
/// deep obsidian, titanium hairlines, soft white editorial type. Intentionally
/// fixed rather than light/dark-adaptive: this aesthetic doesn't bend to system
/// appearance, the same way a well-made object looks the same in any room.
extension Color {
    /// Deep obsidian background — richer and darker than the standard surface gray.
    static let nmlObsidian = Color(red: 6 / 255, green: 6 / 255, blue: 7 / 255)
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
    /// Muted warm gray for captions, eyebrows, and secondary detail.
    static let nmlMuted = Color(red: 142 / 255, green: 141 / 255, blue: 137 / 255)
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
