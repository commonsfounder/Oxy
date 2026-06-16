import SwiftUI
import AVFoundation

// Agentic generative UI: a living agent orb + cards the agent can "summon" over the
// Today surface. Reuses the existing Bloom palette and `bloomGlass` from TodayView —
// this file only adds the orb and the generative-card flow on top of them.

// MARK: - Stage (the hook point)
//
// Your existing agent callback pushes into this. One line from anywhere with the
// environment object:  stage.present(.carPurchase(.porsche911))
// The orb reads `isThinking` to come alive; the overlay renders `card`.

@Observable
@MainActor
final class AgentStage {
    /// The card the agent is currently showing over Today. nil = nothing summoned.
    var card: GenerativeCard?
    /// Drives the orb's "active" look (brighter glow, faster orbit, color shift).
    var isThinking = false

    func think() { withAnimation(.easeInOut(duration: 0.3)) { isThinking = true } }

    func present(_ card: GenerativeCard) {
        withAnimation(.spring(response: 0.55, dampingFraction: 0.82)) {
            isThinking = false
            self.card = card
        }
    }

    func dismiss() {
        withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { card = nil }
    }
}

/// Every UI the agent can render. Add a case + a view branch to grow the vocabulary.
enum GenerativeCard: Identifiable {
    case carPurchase(CarModel)
    var id: String {
        switch self { case .carPurchase(let m): return "car-\(m.name)" }
    }
}

// MARK: - Agent Orb
//
// A glowing sphere with particles orbiting it. TimelineView drives one continuous
// clock; Canvas draws the orbit so it's a single cheap layer, not N animated views.
// `active` shifts hue toward magenta, brightens the glow, and speeds the orbit.

struct AgentOrb: View {
    var active: Bool = false
    var diameter: CGFloat = 132
    var onTap: () -> Void = {}

    @State private var pressed = false

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            ZStack {
                // Soft outer halo — breathes, brighter when active.
                Circle()
                    .fill(active ? Bloom.magenta : Bloom.purple)
                    .frame(width: diameter * 1.9, height: diameter * 1.9)
                    .opacity((active ? 0.32 : 0.18) + 0.06 * sin(t * 1.4))
                    .blur(radius: 60)

                // The core sphere: layered gradient + inner glow.
                Circle()
                    .fill(
                        RadialGradient(
                            colors: active
                                ? [Color.white, Bloom.magenta, Bloom.purple]
                                : [Color.white.opacity(0.9), Bloom.purple, Bloom.base2],
                            center: .init(x: 0.38, y: 0.34),
                            startRadius: 2,
                            endRadius: diameter * 0.72
                        )
                    )
                    .frame(width: diameter, height: diameter)
                    .overlay(
                        Circle().strokeBorder(
                            LinearGradient(colors: [.white.opacity(0.7), .clear],
                                           startPoint: .top, endPoint: .bottom),
                            lineWidth: 1)
                    )
                    .shadow(color: (active ? Bloom.magenta : Bloom.purple).opacity(0.7),
                            radius: active ? 34 : 22)

                // Orbiting connection particles.
                Canvas { ctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let speed = active ? 1.7 : 0.9
                    let rings: [(r: CGFloat, n: Int, tilt: CGFloat)] = [
                        (diameter * 0.78, 5, 0.5),
                        (diameter * 0.95, 7, -0.35)
                    ]
                    for (ri, ring) in rings.enumerated() {
                        for i in 0..<ring.n {
                            let phase = t * speed + Double(i) * (2 * .pi / Double(ring.n)) + Double(ri)
                            let x = c.x + cos(phase) * ring.r
                            let y = c.y + sin(phase) * ring.r * ring.tilt + sin(phase) * 6
                            let depth = (sin(phase) + 1) / 2          // 0 back … 1 front
                            let d = 2.5 + depth * 4
                            let rect = CGRect(x: x - d/2, y: y - d/2, width: d, height: d)
                            let dot = Color.white.opacity(0.25 + depth * 0.6)
                            ctx.fill(Path(ellipseIn: rect), with: .color(dot))
                        }
                    }
                }
                .frame(width: diameter * 2.4, height: diameter * 2.4)
                .blendMode(.plusLighter)
            }
            .scaleEffect((pressed ? 0.93 : 1) * (active ? 1.05 : 1))
            .animation(.spring(response: 0.4, dampingFraction: 0.6), value: pressed)
            .animation(.spring(response: 0.6, dampingFraction: 0.8), value: active)
        }
        .frame(width: diameter * 2.4, height: diameter * 2.4)
        .contentShape(Circle())
        .onTapGesture { onTap() }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in pressed = true }
                .onEnded { _ in pressed = false }
        )
        .accessibilityLabel("Agent")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Generative card overlay
//
// Drop this once near the top of your Today ZStack. It dims the surface and floats
// the agent's card in with a spring. Renders whatever `stage.card` holds.

struct AgentCardOverlay: View {
    @Bindable var stage: AgentStage

    var body: some View {
        ZStack {
            if let card = stage.card {
                Color.black.opacity(0.55)
                    .ignoresSafeArea()
                    .transition(.opacity)
                    .onTapGesture { stage.dismiss() }

                Group {
                    switch card {
                    case .carPurchase(let model):
                        CarPurchaseCard(model: model) { stage.dismiss() }
                    }
                }
                .padding(.horizontal, 20)
                .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.55, dampingFraction: 0.82), value: stage.card?.id)
    }
}

// MARK: - Car purchase flow (the "buy Porsche 911" moment)

struct CarModel: Equatable {
    let name: String
    let tagline: String
    let price: Int
    let finishes: [CarFinish]

    static let porsche911 = CarModel(
        name: "911 Carrera GTS",
        tagline: "Porsche · Reserve in seconds",
        price: 164_900,
        finishes: [
            .init(name: "GT Silver", color: Color(red: 0.78, green: 0.80, blue: 0.82)),
            .init(name: "Guards Red", color: Color(red: 0.82, green: 0.12, blue: 0.16)),
            .init(name: "Gentian Blue", color: Color(red: 0.13, green: 0.27, blue: 0.55)),
            .init(name: "Jet Black", color: Color(red: 0.08, green: 0.08, blue: 0.10))
        ]
    )
}

struct CarFinish: Equatable, Identifiable {
    let name: String
    let color: Color
    var id: String { name }
}

struct CarPurchaseCard: View {
    let model: CarModel
    var onClose: () -> Void

    @State private var finishIndex = 0
    @State private var rotation: Angle = .degrees(-18)   // drag-to-rotate
    @State private var reserved = false
    @State private var burst = false

    private var finish: CarFinish { model.finishes[finishIndex] }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            header

            // "3D-ish" product viz: a finish-tinted body you can swing with a drag.
            // Swap CarBodyShape for Model3D / a RealityKit ModelEntity when you have
            // the .usdz asset — the rotation gesture below already feeds a yaw angle.
            ZStack {
                RadialGradient(colors: [finish.color.opacity(0.45), .clear],
                               center: .center, startRadius: 4, endRadius: 220)
                    .blur(radius: 8)

                CarBodyShape()
                    .fill(
                        LinearGradient(colors: [finish.color, finish.color.opacity(0.55)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .overlay(CarBodyShape().stroke(.white.opacity(0.25), lineWidth: 1))
                    .frame(width: 280, height: 120)
                    .rotation3DEffect(rotation, axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                    .shadow(color: finish.color.opacity(0.6), radius: 24, y: 14)

                if reserved { SuccessBurst(trigger: burst).allowsHitTesting(false) }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 190)
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { v in
                        rotation = .degrees(-18 + Double(v.translation.width) * 0.4)
                    }
                    .onEnded { _ in
                        withAnimation(.spring(response: 0.6, dampingFraction: 0.7)) {
                            rotation = .degrees(-18)
                        }
                    }
            )

            finishPicker

            HStack(alignment: .firstTextBaseline) {
                Text("Total today").font(.system(size: 13)).foregroundStyle(Bloom.inkSoft)
                Spacer()
                Text(model.price, format: .currency(code: "USD").precision(.fractionLength(0)))
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(Bloom.ink)
                    .contentTransition(.numericText())
            }

            reserveButton
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .bloomGlass(30)
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.tagline.uppercased())
                    .font(.system(size: 11, weight: .semibold)).tracking(2)
                    .foregroundStyle(Bloom.inkFaint)
                Text(model.name)
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(Bloom.ink)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Bloom.inkSoft)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(.white.opacity(0.08)))
            }
            .buttonStyle(.plain)
        }
    }

    private var finishPicker: some View {
        HStack(spacing: 14) {
            ForEach(Array(model.finishes.enumerated()), id: \.element.id) { i, f in
                Circle()
                    .fill(f.color)
                    .frame(width: 30, height: 30)
                    .overlay(Circle().strokeBorder(.white.opacity(0.3), lineWidth: 1))
                    .overlay(
                        Circle().strokeBorder(.white, lineWidth: 2)
                            .padding(-4)
                            .opacity(finishIndex == i ? 1 : 0)
                    )
                    .scaleEffect(finishIndex == i ? 1.0 : 0.86)
                    .onTapGesture {
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.6)) { finishIndex = i }
                    }
            }
            Spacer()
            Text(finish.name)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Bloom.inkSoft)
                .contentTransition(.opacity)
        }
    }

    private var reserveButton: some View {
        Button {
            guard !reserved else { return }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) { reserved = true }
            burst.toggle()
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: reserved ? "checkmark.circle.fill" : "bolt.fill")
                Text(reserved ? "Reserved" : "Reserve Now")
                    .contentTransition(.opacity)
            }
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(reserved ? Bloom.ink : Bloom.base)
            .frame(maxWidth: .infinity).frame(height: 56)
            .background(
                Capsule().fill(
                    reserved
                        ? AnyShapeStyle(.white.opacity(0.12))
                        : AnyShapeStyle(LinearGradient(colors: [.white, Bloom.inkSoft],
                                                       startPoint: .top, endPoint: .bottom))
                )
            )
            .overlay(reserved ? Capsule().strokeBorder(.white.opacity(0.2), lineWidth: 1) : nil)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: reserved)
    }
}

/// A clean side-profile silhouette — good enough to read as "car" without an asset.
/// Replace with Model3D(named:) once you ship a .usdz.
private struct CarBodyShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let w = r.width, h = r.height
        p.move(to: .init(x: 0.04*w, y: 0.78*h))
        p.addCurve(to: .init(x: 0.26*w, y: 0.40*h),
                   control1: .init(x: 0.10*w, y: 0.60*h), control2: .init(x: 0.18*w, y: 0.42*h))
        p.addCurve(to: .init(x: 0.62*w, y: 0.30*h),
                   control1: .init(x: 0.36*w, y: 0.18*h), control2: .init(x: 0.52*w, y: 0.20*h))
        p.addCurve(to: .init(x: 0.96*w, y: 0.60*h),
                   control1: .init(x: 0.80*w, y: 0.40*h), control2: .init(x: 0.90*w, y: 0.48*h))
        p.addLine(to: .init(x: 0.96*w, y: 0.78*h))
        p.addLine(to: .init(x: 0.04*w, y: 0.78*h))
        p.closeSubpath()
        return p
    }
}

// MARK: - Success particle burst
//
// One Canvas, one TimelineView, a finite ~1.1s life keyed off `trigger`. No library.

struct SuccessBurst: View {
    var trigger: Bool
    @State private var start = Date.distantPast

    private struct Spark { let angle: Double; let speed: Double; let hue: Double; let size: CGFloat }
    @State private var sparks: [Spark] = (0..<46).map { _ in
        Spark(angle: .random(in: 0..<(2 * .pi)),
              speed: .random(in: 60...230),
              hue: .random(in: 0.55...0.85),
              size: .random(in: 2...5))
    }

    var body: some View {
        TimelineView(.animation) { tl in
            let elapsed = tl.date.timeIntervalSince(start)
            let life = 1.1
            Canvas { ctx, size in
                guard elapsed < life else { return }
                let p = elapsed / life
                let c = CGPoint(x: size.width/2, y: size.height/2)
                for s in sparks {
                    let dist = s.speed * p
                    let x = c.x + cos(s.angle) * dist
                    let y = c.y + sin(s.angle) * dist + 40 * p * p   // slight gravity
                    let r = s.size * (1 - p)
                    let col = Color(hue: s.hue, saturation: 0.7, brightness: 1).opacity(1 - p)
                    ctx.fill(Path(ellipseIn: CGRect(x: x-r, y: y-r, width: r*2, height: r*2)),
                             with: .color(col))
                }
            }
        }
        .blendMode(.plusLighter)
        .onChange(of: trigger) { _, _ in
            sparks = (0..<46).map { _ in
                Spark(angle: .random(in: 0..<(2 * .pi)), speed: .random(in: 60...230),
                      hue: .random(in: 0.55...0.85), size: .random(in: 2...5))
            }
            start = Date()
        }
    }
}

// MARK: - Today Input Bar
//
// A floating glass bar at the bottom of Today: text field + mic button.
// Owns its own ChatViewModel + VoiceInputManager so Today is self-contained.
// Drives AgentStage for orb state and card presentation.
//
// Action → card routing: add cases to `actionToCard` as you ship new generative flows.

struct TodayInputBar: View {
    @Bindable var stage: AgentStage
    let userId: String

    @State private var viewModel = ChatViewModel()
    @State private var voiceInput = VoiceInputManager()
    @State private var text = ""
    @FocusState private var focused: Bool

    private var isBusy: Bool { voiceInput.isRecording || voiceInput.isTranscribing || viewModel.isSending }
    private var canSend: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty && !isBusy }

    var body: some View {
        HStack(spacing: 12) {
            // Text field
            TextField("Ask anything…", text: $text, axis: .vertical)
                .lineLimit(1...4)
                .font(.system(size: 16, weight: .light))
                .foregroundStyle(Color.white)
                .tint(Color.white.opacity(0.7))
                .focused($focused)
                .submitLabel(.send)
                .onSubmit { submit() }
                .disabled(isBusy)

            Spacer(minLength: 0)

            // Mic / send / activity button — one slot, three states
            Button { primaryAction() } label: {
                ZStack {
                    if viewModel.isSending || voiceInput.isTranscribing {
                        // Thinking spinner
                        TimelineView(.animation) { tl in
                            let t = tl.date.timeIntervalSinceReferenceDate
                            Circle()
                                .trim(from: 0, to: 0.72)
                                .stroke(Color.white.opacity(0.7), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                                .rotationEffect(.degrees(t * 200))
                                .frame(width: 20, height: 20)
                        }
                    } else if voiceInput.isRecording {
                        // Live recording indicator
                        Circle()
                            .fill(Color.red.opacity(0.85))
                            .frame(width: 10, height: 10)
                    } else if canSend {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.white)
                    } else {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Color.white.opacity(0.7))
                    }
                }
                .frame(width: 38, height: 38)
                .background(Circle().fill(canSend ? Color.white.opacity(0.22) : Color.white.opacity(0.09)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.15), lineWidth: 0.75))
            }
            .buttonStyle(.plain)
            .scaleEffect(voiceInput.isRecording ? 1.12 : 1)
            .animation(.spring(response: 0.35, dampingFraction: 0.6), value: voiceInput.isRecording)
            .sensoryFeedback(.impact(weight: .medium), trigger: voiceInput.isRecording)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .bloomGlass(28)
        // Orb reacts to busy state
        .onChange(of: isBusy) { _, busy in
            stage.isThinking = busy
        }
        // Transcript ready → send
        .onChange(of: voiceInput.isTranscribing) { _, transcribing in
            guard !transcribing else { return }
            let t = voiceInput.transcript.trimmingCharacters(in: .whitespaces)
            voiceInput.transcript = ""
            guard !t.isEmpty else { return }
            text = t
            submit()
        }
        // Agent reply landed → route to generative card if applicable
        .onChange(of: viewModel.messages) { _, msgs in
            guard let last = msgs.last,
                  last.role == .assistant,
                  !last.isStreaming else { return }
            if let card = actionToCard(last.actions) {
                stage.present(card)
            } else {
                withAnimation { stage.isThinking = false }
            }
        }
    }

    // MARK: - Actions

    private func primaryAction() {
        if canSend { submit() } else { toggleMic() }
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        viewModel.inputText = trimmed
        text = ""
        focused = false
        stage.think()
        viewModel.sendMessage(userId: userId)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func toggleMic() {
        if voiceInput.isRecording {
            voiceInput.stopRecording()
        } else {
            voiceInput.startRecording(userId: userId)
        }
    }

    // MARK: - Action → card routing
    //
    // Map action names to generative card types. The action name comes from
    // ActionResult.action — matches exactly what `ACTION_CONTRACTS` defines
    // on the backend. Add a case here for every new generative card you ship.

    private func actionToCard(_ actions: [ActionResult]) -> GenerativeCard? {
        for a in actions {
            switch a.action {
            // Extend: case "book_uber": return .uberRide(...)
            // Extend: case "buy_product": return .purchase(...)
            // Demo car flow — fires when the agent emits a "reserve_vehicle" action.
            case "reserve_vehicle":
                return .carPurchase(.porsche911)   // swap for real data from a.cardText
            default:
                continue
            }
        }
        return nil
    }
}

// MARK: - Orb voice-state bridge
//
// Call this modifier on AgentOrb so it expands and shifts hue while the mic is live.
// Usage: AgentOrb(...).orbVoiceState(voiceInput: voiceInput)
// (TodayView can't own the VoiceInputManager directly since it lives in TodayInputBar,
//  so this is wired through AgentStage.isThinking which TodayInputBar already drives.)
// The modifier is here as documentation; the stage-driven path is sufficient.

extension AgentOrb {
    /// Convenience: expand the orb while a VoiceInputManager is recording.
    func expandsWhileRecording(_ manager: VoiceInputManager) -> some View {
        self.scaleEffect(manager.isRecording ? 1.18 : 1)
            .animation(.spring(response: 0.45, dampingFraction: 0.6), value: manager.isRecording)
    }
}
