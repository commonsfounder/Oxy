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
// An A drawn as a roof over a doorway, with one blue dot standing where the
// crossbar would be: Adam, present in the house. Live geometry, so it stays
// crisp from a 16pt chip to a full-screen identity moment.

struct BrandWordmark: View {
    var height: CGFloat = 14
    var color: Color = .appInk

    var body: some View {
        HStack(spacing: height * 0.5) {
            AdamMark()
                .frame(width: height, height: height)
            Text("ADAM")
                .font(.appBody(height * 0.78, weight: .bold))
                .tracking(height * 0.16)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Adam")
    }
}

/// Graphite roof, blue presence dot. Blue stays reserved for activity: when
/// `active` is false the dot goes quiet.
struct AdamMark: View {
    var active = true

    var body: some View {
        ZStack {
            AdamRoofShape().fill(Color.appInk)
            AdamDotShape().fill(active ? Color.appAccent : Color.appMuted.opacity(0.35))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

private struct AdamRoofShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }
        var line = Path()
        line.move(to: point(0.17, 0.85))
        line.addLine(to: point(0.5, 0.16))
        line.addLine(to: point(0.83, 0.85))
        return line.strokedPath(StrokeStyle(lineWidth: rect.width * 0.2, lineCap: .round, lineJoin: .round))
    }
}

private struct AdamDotShape: Shape {
    func path(in rect: CGRect) -> Path {
        let r = rect.width * 0.08
        let c = CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.69)
        return Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
    }
}

// MARK: - Activity mark

enum AdamActivityState {
    /// Adam is doing something: the dot traces the roof of the A.
    case working
    /// Adam is hearing you: the dot becomes the speaker cone of a ripple of dots.
    case listening
    /// Adam needs you: the dot draws a question mark, then drops in as its full stop.
    case waiting
}

/// The activity indicator. One blue dot is the actor in every state. When the state changes the
/// dot is carried across, never replaced: it flies from where it was to where it is needed next.
struct AdamActivityMark: View {
    var state: AdamActivityState = .working
    var size: CGFloat = 26
    var tint: Color = .appAccent
    /// Live loudness from 0 to 1 while listening. Without it the dots move on their own, like speech.
    var level: (() -> Double)? = nil
    @State private var smoother = LevelSmoother()
    @State private var track = Track()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private final class LevelSmoother {
        var value = 0.0
        func step(toward target: Double) -> Double {
            value += (target - value) * (target > value ? 0.45 : 0.12)
            return value
        }
    }

    /// The dot, in unit coordinates: where it is, how big, how solid, and how squashed.
    private struct Dot {
        var x = 0.5
        var y = 0.5
        var r = 0.07
        var alpha = 1.0
        var sx = 1.0
        var sy = 1.0
    }

    /// Remembers the dot between frames so a change of state can start from where it was.
    private final class Track {
        var startedAt = Date().timeIntervalSinceReferenceDate
        var from: AdamActivityState?
        var fromDot = Dot()
        var last = Dot()
    }

    private static let flight = 0.5

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            Canvas { ctx, canvas in
                render(ctx, canvas.width, time)
            }
        }
        .frame(width: size, height: size)
        .onChange(of: state) { old, _ in
            track.from = old
            track.fromDot = track.last
            track.startedAt = Date().timeIntervalSinceReferenceDate
        }
        .accessibilityHidden(true)
    }

    private func render(_ ctx: GraphicsContext, _ w: CGFloat, _ time: Double) {
        let tau = time - track.startedAt
        let progress = min(max(tau / Self.flight, 0), 1)
        let e = progress * progress * (3 - 2 * progress)
        // Coming back from waiting, the dot slides left along the floor to the A's foot, and only
        // then does the tracing begin. So the working motion is held until the dot has arrived.
        let handoff = track.from == .waiting && state == .working
        let kick = handoff ? Self.flight : 0
        var dot = Dot()

        if let from = track.from, progress < 1, !reduceMotion {
            ctx.drawLayer { layer in
                layer.opacity = 1 - e
                _ = scene(from, &layer, w, time, tau: 999, kick: 0)
            }
            var target = Dot()
            ctx.drawLayer { layer in
                layer.opacity = e
                target = scene(state, &layer, w, time, tau: tau, kick: kick)
            }
            dot = carried(from: track.fromDot, to: target, e, arcs: !handoff)
        } else {
            var layer = ctx
            dot = scene(state, &layer, w, time, tau: tau, kick: kick)
        }

        track.last = dot
        let rx = dot.r * w * dot.sx
        let ry = dot.r * w * dot.sy
        ctx.fill(
            Path(ellipseIn: CGRect(x: dot.x * w - rx, y: dot.y * w - ry, width: rx * 2, height: ry * 2)),
            with: .color(tint.opacity(dot.alpha))
        )
    }

    /// The dot's flight from one state to the next: a gentle arc, landing exactly on the new dot.
    private func carried(from a: Dot, to b: Dot, _ e: Double, arcs: Bool = true) -> Dot {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let length = hypot(dx, dy)
        var nx = length > 0 ? -dy / length : 0
        var ny = length > 0 ? dx / length : 0
        if ny > 0 { nx = -nx; ny = -ny }
        let bulge = arcs ? 0.2 * length * sin(Double.pi * e) : 0
        return Dot(
            x: a.x + dx * e + nx * bulge,
            y: a.y + dy * e + ny * bulge,
            r: a.r + (b.r - a.r) * e,
            alpha: a.alpha + (b.alpha - a.alpha) * e,
            sx: 1 + (b.sx - 1) * e,
            sy: 1 + (b.sy - 1) * e
        )
    }

    private func scene(_ which: AdamActivityState, _ ctx: inout GraphicsContext, _ w: CGFloat, _ time: Double, tau: Double, kick: Double) -> Dot {
        switch which {
        case .working:
            if kick > 0 && tau < 500 {
                return sceneWorking(&ctx, w, time, max(tau - kick, 0), homeFade: clamp((tau - kick - 0.15) / 0.5))
            }
            return sceneWorking(&ctx, w, time, tau, homeFade: 1)
        case .listening: return sceneListening(&ctx, w, time)
        case .waiting: return sceneWaiting(&ctx, w, tau)
        }
    }

    private func circle(_ at: CGPoint, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: at.x - r, y: at.y - r, width: r * 2, height: r * 2))
    }

    private func ease(_ x: Double) -> Double { x * x }
    private func easeOut(_ x: Double) -> Double { 1 - (1 - x) * (1 - x) }
    private func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }
    private func clamp(_ x: Double) -> Double { min(max(x, 0), 1) }

    // MARK: Working — the dot traces the roof of the A

    private static let corners: [CGPoint] = [CGPoint(x: 0.17, y: 0.85), CGPoint(x: 0.5, y: 0.16), CGPoint(x: 0.83, y: 0.85)]
    private static let home = CGPoint(x: 0.5, y: 0.69)
    private static let travel = 0.76
    private static let cycle = 2.3

    private func sceneWorking(_ ctx: inout GraphicsContext, _ w: CGFloat, _ time: Double, _ tau: Double, homeFade: Double) -> Dot {
        let stroke = StrokeStyle(lineWidth: w * 0.1, lineCap: .round, lineJoin: .round)
        let pts = Self.corners.map { CGPoint(x: $0.x * w, y: $0.y * w) }
        var roof = Path()
        roof.move(to: pts[0]); roof.addLine(to: pts[1]); roof.addLine(to: pts[2])
        ctx.stroke(roof, with: .color(Color.appMuted.opacity(0.38)), style: stroke)

        let home = CGPoint(x: Self.home.x * w, y: Self.home.y * w)
        let dotR = w * 0.07
        if reduceMotion {
            return Dot(x: Self.home.x, y: Self.home.y, r: 0.07)
        }
        // Counting from the moment the state began, so the dot always starts at the left foot.
        let clock = tau > 500 ? time : tau
        let phase = (clock / Self.cycle).truncatingRemainder(dividingBy: 1)
        let u = min(phase / Self.travel, 1)
        let head = u * u * (3 - 2 * u)
        let tailLength = 0.3
        for k in 0..<4 {
            let a = max(0, head - tailLength + tailLength * Double(k) / 4)
            let b = max(0, head - tailLength + tailLength * Double(k + 1) / 4)
            guard b > a else { continue }
            var seg = Path()
            seg.move(to: point(at: a, pts))
            for f in stride(from: a, through: b, by: 0.02) { seg.addLine(to: point(at: f, pts)) }
            seg.addLine(to: point(at: b, pts))
            ctx.stroke(seg, with: .color(tint.opacity(0.12 + 0.2 * Double(k))), style: stroke)
        }
        let lift = sin(Double.pi * clamp((phase - Self.travel) / (1 - Self.travel)))
        ctx.fill(circle(home, dotR * (1 + 0.25 * lift)), with: .color(tint.opacity((0.35 + 0.65 * lift) * homeFade)))

        let fade = phase <= Self.travel ? 1 : max(0, 1 - (phase - Self.travel) / 0.08)
        let at = point(at: head, pts)
        return Dot(x: Double(at.x / w), y: Double(at.y / w), r: 0.07, alpha: fade)
    }

    /// A point a fraction of the way along the roof, measured by length so the speed is even.
    private func point(at fraction: Double, _ pts: [CGPoint]) -> CGPoint {
        let first = hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
        let second = hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
        let along = min(max(fraction, 0), 1) * (first + second)
        if along <= first {
            let f = first == 0 ? 0 : along / first
            return CGPoint(x: pts[0].x + (pts[1].x - pts[0].x) * f, y: pts[0].y + (pts[1].y - pts[0].y) * f)
        }
        let f = second == 0 ? 0 : (along - first) / second
        return CGPoint(x: pts[1].x + (pts[2].x - pts[1].x) * f, y: pts[1].y + (pts[2].y - pts[1].y) * f)
    }

    // MARK: Listening — the dot becomes the speaker cone

    private func sceneListening(_ ctx: inout GraphicsContext, _ w: CGFloat, _ time: Double) -> Dot {
        let n = w < 40 ? 5 : (w < 80 ? 7 : 9)
        let step = 0.82 * w / CGFloat(n - 1)
        let centre = CGPoint(x: w / 2, y: w / 2)
        let baseR = step * 0.2
        let half = Double(n - 1) / 2

        let synthetic = abs(sin(time * 1.3) * sin(time * 2.9 + 1)) * (0.55 + 0.45 * sin(time * 7.3))
        let loud = reduceMotion ? 0.4 : smoother.step(toward: min(max(level?() ?? synthetic, 0), 1))

        ctx.fill(circle(centre, w * 0.47), with: .color(tint.opacity(0.06 + 0.07 * loud)))

        for row in 0..<n {
            for col in 0..<n {
                let gx = Double(col) - half
                let gy = Double(row) - half
                let d = hypot(gx, gy)
                if d == 0 { continue }
                let wave = reduceMotion ? 0 : sin(d * 1.9 - time * 6.0) * exp(-d * 0.22)
                let ripple = reduceMotion ? 0 : sin(d * 3.4 - time * 9.5 + 1.3) * exp(-d * 0.35) * 0.5
                let z = (wave + ripple) * (0.25 + 0.75 * loud)
                let crest = max(0, z)
                let radius = max(baseR * 0.45, baseR * CGFloat(1 + 1.7 * z))
                let glow = min(1, crest * 1.4 + loud * 0.3 * exp(-d * 0.45))
                let at = CGPoint(x: centre.x + CGFloat(gx) * step, y: centre.y + CGFloat(gy) * step)
                ctx.fill(circle(at, radius), with: .color(tint.opacity(0.26 + 0.74 * glow)))
            }
        }
        return Dot(x: 0.5, y: 0.5, r: Double(baseR * (1.7 + 1.2 * loud) / w))
    }

    // MARK: Waiting — the dot draws a question mark and drops in as its full stop

    private static let sampleCount = 40

    /// "?" as one stroke: an upright oval bowl, level at the left tip, that eases into a straight stem
    /// directly under its middle.
    private static let questionPoints: [CGPoint] = {
        var points: [CGPoint] = []
        let centre = CGPoint(x: 0.5, y: 0.29)
        let rx = 0.16
        let ry = 0.185
        let start = 180.0 * Double.pi / 180
        let end = -68.0 * Double.pi / 180
        let arcCount = 26
        for i in 0...arcCount {
            let a = start + (end - start) * Double(i) / Double(arcCount)
            points.append(CGPoint(x: centre.x + rx * cos(a), y: centre.y - ry * sin(a)))
        }
        let p0 = points.last!
        var tx = rx * sin(end)
        var ty = ry * cos(end)
        let length = hypot(tx, ty)
        tx /= length
        ty /= length
        let c1 = CGPoint(x: p0.x + 0.05 * tx, y: p0.y + 0.05 * ty)
        let c2 = CGPoint(x: 0.5, y: 0.53)
        let p3 = CGPoint(x: 0.5, y: stemEnd)
        let tail = sampleCount - points.count
        for i in 1...tail {
            let t = Double(i) / Double(tail)
            let m = 1 - t
            points.append(CGPoint(
                x: m * m * m * p0.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * p3.x,
                y: m * m * m * p0.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * p3.y
            ))
        }
        return points
    }()

    private static let stemEnd = 0.62

    private func hookPoint(_ fraction: Double) -> CGPoint {
        let pts = Self.questionPoints
        let f = clamp(fraction) * Double(pts.count - 1)
        let i = min(Int(f.rounded(.down)), pts.count - 1)
        let j = min(i + 1, pts.count - 1)
        let t = CGFloat(f - Double(i))
        return CGPoint(x: pts[i].x + (pts[j].x - pts[i].x) * t, y: pts[i].y + (pts[j].y - pts[i].y) * t)
    }

    private func strokePath(_ pts: [CGPoint], from a: Double, to b: Double) -> Path {
        let last = Double(pts.count - 1)
        let fa = clamp(a) * last
        let fb = clamp(b) * last
        guard fb > fa + 0.001 else { return Path() }
        func at(_ f: Double) -> CGPoint {
            let i = min(Int(f.rounded(.down)), pts.count - 1)
            let j = min(i + 1, pts.count - 1)
            let t = CGFloat(f - Double(i))
            return CGPoint(x: pts[i].x + (pts[j].x - pts[i].x) * t, y: pts[i].y + (pts[j].y - pts[i].y) * t)
        }
        var path = Path()
        path.move(to: at(fa))
        var i = Int(fa.rounded(.down)) + 1
        while Double(i) < fb { path.addLine(to: pts[i]); i += 1 }
        path.addLine(to: at(fb))
        return path
    }

    /// Floor taps as (time since the state began, strength): the landing and its bounces, then a
    /// small impatient double hop every few seconds.
    private func contacts(_ tau: Double) -> [(Double, Double)] {
        var list: [(Double, Double)] = [(1.45, 1), (1.71, 0.6), (1.87, 0.35)]
        if tau > 1.9 {
            let k = Int(((tau - 1.9) / 2.6).rounded(.down))
            for j in max(0, k - 1)...k {
                let base = 1.9 + Double(j) * 2.6
                list.append((base + 1.56, 0.5))
                list.append((base + 1.74, 0.3))
            }
        }
        return list
    }

    private func sceneWaiting(_ ctx: inout GraphicsContext, _ w: CGFloat, _ tau: Double) -> Dot {
        let lineWidth = max(1.6, w * 0.1)
        let style = StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
        let question = Self.questionPoints.map { CGPoint(x: $0.x * w, y: $0.y * w) }
        let landY = 0.855
        let stemY = Self.stemEnd
        let dotR = 0.085
        let strokeR = Double(lineWidth / 2 / w)

        if reduceMotion {
            ctx.stroke(strokePath(question, from: 0, to: 1), with: .color(tint), style: style)
            return Dot(x: 0.5, y: landY, r: dotR)
        }

        // The dot draws the hook, then lets go of the end of it and falls.
        let hookStart = 0.45
        let hookEnd = 1.15
        let drawn = smooth(clamp((tau - hookStart) / (hookEnd - hookStart)))
        ctx.stroke(strokePath(question, from: 0, to: drawn), with: .color(tint), style: style)

        var dot = Dot(x: 0.5, y: landY, r: dotR)
        if tau < hookEnd {
            let at = hookPoint(drawn)
            dot = Dot(x: Double(at.x), y: Double(at.y), r: strokeR)
        } else if tau < 1.45 {
            let u = (tau - hookEnd) / 0.30
            dot.y = stemY + (landY - stemY) * ease(u)
            dot.r = strokeR + (dotR - strokeR) * u
            dot.sy = 1 + 0.3 * u
            dot.sx = 1 / sqrt(dot.sy)
        } else if tau < 1.71 {
            let u = (tau - 1.45) / 0.26
            dot.y = landY - 4 * 0.12 * u * (1 - u)
            dot.sy = 1 + 0.15 * sin(Double.pi * u)
            dot.sx = 1 / sqrt(dot.sy)
        } else if tau < 1.87 {
            let u = (tau - 1.71) / 0.16
            dot.y = landY - 4 * 0.04 * u * (1 - u)
        } else if tau >= 1.9 {
            let p = ((tau - 1.9) / 2.6).truncatingRemainder(dividingBy: 1)
            if p >= 0.5 && p < 0.6 {
                let u = (p - 0.5) / 0.1
                dot.y = landY - 4 * 0.1 * u * (1 - u)
            } else if p >= 0.6 && p < 0.67 {
                let u = (p - 0.6) / 0.07
                dot.y = landY - 4 * 0.035 * u * (1 - u)
            }
        }
        if tau >= 1.45 {
            let squash = contacts(tau).map { max(0, 1 - abs(tau - $0.0) / 0.03) * $0.1 }.max() ?? 0
            dot.sx *= 1 + 0.3 * squash
            dot.sy *= 1 - 0.3 * squash
        }

        let floorY = 0.935 * w
        for (c, strength) in contacts(tau) {
            let age = (tau - c) / 0.5
            guard age >= 0, age <= 1 else { continue }
            let spread = w * (0.07 + 0.3 * easeOut(age)) * strength
            ctx.stroke(
                Path(ellipseIn: CGRect(x: w / 2 - spread, y: floorY - spread * 0.22, width: spread * 2, height: spread * 0.44)),
                with: .color(tint.opacity(0.55 * (1 - age) * strength)), lineWidth: max(1, w * 0.035)
            )
        }
        return dot
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

/// Capsule toggle at the system switch size: blue when on, quiet grey when off.
struct SettingsToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.appToggle) { isOn.toggle() }
        } label: {
            Capsule()
                .fill(isOn ? Color.appAccent : Color.appToggleOff)
                .frame(width: 51, height: 31)
                .overlay(
                    Circle()
                        .fill(Color.white)
                        .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
                        .frame(width: 27, height: 27)
                        .padding(2)
                        .frame(maxWidth: .infinity, alignment: isOn ? .trailing : .leading)
                )
                .frame(width: 51, height: 44)
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
