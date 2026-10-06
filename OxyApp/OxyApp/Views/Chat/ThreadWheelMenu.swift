import SwiftUI

/// What the wheel can open. The first four, in the saved order, sit on the arc; the rest are a spin away.
enum ThreadMenuChoice: String, CaseIterable, Identifiable {
    case activity, home, memory, settings, privateChat, apps, payments, logins, displays

    var id: String { rawValue }

    var title: String {
        switch self {
        case .activity: return "Activity"
        case .home: return "Your home"
        case .memory: return "Memory"
        case .settings: return "Settings"
        case .privateChat: return "Private mode"
        case .apps: return "Apps"
        case .payments: return "Payments"
        case .logins: return "Saved logins"
        case .displays: return "Displays"
        }
    }

    /// How many items rest on the arc without spinning.
    static let reachable = 4
    static let orderKey = "adam_wheel_order"

    /// The saved order, with anything new appended so a fresh item never goes missing.
    static func ordered(from raw: String) -> [ThreadMenuChoice] {
        var seen = Set<ThreadMenuChoice>()
        let saved = raw.split(separator: ",").compactMap { ThreadMenuChoice(rawValue: String($0)) }.filter { seen.insert($0).inserted }
        return saved + allCases.filter { !seen.contains($0) }
    }

    static func raw(for order: [ThreadMenuChoice]) -> String {
        order.map(\.rawValue).joined(separator: ",")
    }
}

private struct WheelGlyph: View {
    let choice: ThreadMenuChoice
    var size: CGFloat
    var active = false

    var body: some View {
        Group {
            switch choice {
            case .activity: AppIcon("history", size: size)
            case .home: AppIcon("tab-home", size: size)
            case .memory: AppIcon("dotted", size: size)
            case .settings: AppIcon("list", size: size)
            case .privateChat: GhostIcon(active: active).frame(width: size, height: size)
            case .apps: AppIcon("cube", size: size)
            case .payments: AppIcon("card", size: size)
            case .logins: AppIcon("person-check", size: size)
            case .displays: AppIcon("photo", size: size)
            }
        }
    }
}

/// The closed button: the Adam mark in a circle. It turns into a cross as the wheel opens.
struct WheelHub: View {
    var progress: CGFloat
    var incognito: Bool
    /// What Adam is doing right now. While set, the Adam mark in the hub shows it; otherwise the plain logo.
    var activity: AdamActivityState? = nil

    /// Every item grows out of the centre of the hub.
    static func slotOffset(_ choice: ThreadMenuChoice) -> CGSize { .zero }

    var body: some View {
        let open = min(max(progress, 0), 1)
        ZStack {
            Circle().fill(incognito && open < 0.5 ? Color.appAction : Color.appReceivedBubble)
            if incognito {
                GhostIcon(active: true)
                    .frame(width: 20, height: 20)
                    .foregroundColor(Color.appOnAction)
                    .scaleEffect(1 - 0.4 * open)
                    .opacity(1 - open)
            } else if let activity {
                AdamActivityMark(state: activity, size: 32)
                    .scaleEffect(1 - 0.4 * open)
                    .opacity(1 - open)
            } else {
                AdamMark()
                    .frame(width: 20, height: 20)
                    .scaleEffect(1 - 0.4 * open)
                    .opacity(1 - open)
            }
            ZStack {
                Capsule().frame(width: 16, height: 2)
                Capsule().frame(width: 2, height: 16)
            }
            .foregroundColor(Color.appInk)
            .rotationEffect(.degrees(Double(open) * 90 - 45))
            .scaleEffect(0.6 + 0.4 * open)
            .opacity(open)
        }
        .frame(width: 44, height: 44)
        .contentShape(Circle())
    }
}

/// The open wheel. Items swing out of the hub along an arc, each growing from its tiny slot.
/// Drag around the hub to spin the wheel; it clicks into place one item at a time.
struct ThreadWheelMenu: View {
    let hub: CGPoint
    @Binding var isOpen: Bool
    var incognito: Bool
    @Binding var orderRaw: String
    var onChoose: (ThreadMenuChoice) -> Void

    @State private var progress: CGFloat = 0
    /// The item picked up with a long press, and where the finger holding it is.
    @State private var lifted: ThreadMenuChoice?
    @State private var liftedPoint: CGPoint = .zero
    @State private var fingerSlot: Double = 0
    @State private var edgeSpin: Task<Void, Never>?
    @State private var lastDrop = Date.distantPast
    @State private var spin: Double = 0
    @State private var dragBase: (angle: Double, spin: Double)?
    @State private var lastDetent = 0
    @State private var mounted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Four items share one quarter circle: 5°, 33°, 61°, 89° from straight down.
    static let step: Double = 28
    static let firstAngle: Double = 5

    /// The order while the wheel is open. Edits stay here and are saved on drop, so a swap mid-drag
    /// doesn't re-render the whole chat screen.
    @State private var order: [ThreadMenuChoice] = []
    private var choices: [ThreadMenuChoice] { order.isEmpty ? ThreadMenuChoice.ordered(from: orderRaw) : order }
    private var detent: Int { Int((spin / Self.step).rounded()) }

    var body: some View {
        ZStack {
            if mounted {
                WheelLayout(progress: progress, spin: spin, hub: hub, incognito: incognito, choices: choices,
                            lifted: lifted, liftedPoint: liftedPoint,
                            onChoose: choose, onLiftMove: liftMove, onLiftEnd: liftEnd, onNudge: nudge,
                            onClose: { isOpen = false })
                    .simultaneousGesture(dragGesture)
            }
        }
        .allowsHitTesting(mounted)
        .onChange(of: orderRaw) { _, raw in
            if lifted == nil { order = ThreadMenuChoice.ordered(from: raw) }
        }
        .onChange(of: isOpen) { _, open in
            if open {
                order = ThreadMenuChoice.ordered(from: orderRaw)
                spin = 0
                lastDetent = 0
                mounted = true
                if reduceMotion { progress = 1 } else {
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { progress = 1 }
                }
            } else {
                HapticManager.shared.impact(.light)
                withAnimation(.spring(response: 0.28, dampingFraction: 0.95)) { progress = 0 }
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    if !isOpen { mounted = false }
                }
            }
        }
    }

    private func angle(at point: CGPoint) -> Double {
        atan2(-Double(point.x - hub.x), Double(point.y - hub.y)) * 180 / .pi
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard lifted == nil else { return }
                if dragBase == nil { dragBase = (angle(at: value.startLocation), spin) }
                guard let base = dragBase else { return }
                spin = base.spin + (angle(at: value.location) - base.angle)
                let detent = Int((spin / Self.step).rounded())
                if detent != lastDetent {
                    lastDetent = detent
                    HapticManager.shared.select()
                }
            }
            .onEnded { value in
                guard lifted == nil, let base = dragBase else { dragBase = nil; return }
                dragBase = nil
                let flick = angle(at: value.predictedEndLocation) - angle(at: value.location)
                let target = ((spin + flick * 0.5) / Self.step).rounded() * Self.step
                withAnimation(.spring(response: 0.45, dampingFraction: 0.78)) { spin = target }
                let detent = Int((target / Self.step).rounded())
                if detent != lastDetent {
                    lastDetent = detent
                    HapticManager.shared.select()
                }
                _ = base
            }
    }

    // MARK: Reordering by dragging

    private func liftMove(_ choice: ThreadMenuChoice, to point: CGPoint) {
        if lifted == nil {
            HapticManager.shared.impact(.rigid)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) { lifted = choice }
            startEdgeSpin()
        }
        liftedPoint = point
        retarget()
    }

    private func liftEnd() {
        guard lifted != nil else { return }
        edgeSpin?.cancel()
        lastDrop = Date()
        orderRaw = ThreadMenuChoice.raw(for: order)
        HapticManager.shared.impact(.soft)
        withAnimation(.spring(response: 0.38, dampingFraction: 0.8)) { lifted = nil }
        Task {
            try? await Task.sleep(for: .milliseconds(230))
            HapticManager.shared.impact(.rigid)
        }
    }

    /// Moves the held item to the slot under the finger; the others slide to make room.
    private func retarget() {
        guard let held = lifted, let from = choices.firstIndex(of: held) else { return }
        fingerSlot = (angle(at: liftedPoint) - Self.firstAngle) / Self.step
        let slot = min(max(Int(fingerSlot.rounded()), 0), ThreadMenuChoice.reachable - 1)
        let count = choices.count
        // The held item stays put until the finger is clearly inside the next slot, so it can't flicker on a boundary.
        let current = ((from + detent) % count + count) % count
        if current < ThreadMenuChoice.reachable, abs(fingerSlot - Double(current)) < 0.65 { return }
        let to = ((slot - detent) % count + count) % count
        guard to != from else { return }
        var next = choices
        next.remove(at: from)
        next.insert(held, at: to)
        HapticManager.shared.select()
        HapticManager.shared.impact(.soft)
        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { order = next }
    }

    /// Holding an item past either end of the arc turns the wheel, so it can travel further than four slots.
    private func startEdgeSpin() {
        edgeSpin?.cancel()
        edgeSpin = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(650))
                guard lifted != nil else { return }
                let beyondEnd = fingerSlot > Double(ThreadMenuChoice.reachable - 1) + 0.3
                let beforeStart = fingerSlot < -0.3
                guard beyondEnd || beforeStart else { continue }
                withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
                    spin += beyondEnd ? -Self.step : Self.step
                }
                lastDetent = detent
                HapticManager.shared.impact(.medium)
                retarget()
            }
        }
    }

    /// Accessibility: move an item one place earlier or later.
    private func nudge(_ choice: ThreadMenuChoice, by offset: Int) {
        var next = choices
        guard let from = next.firstIndex(of: choice) else { return }
        let to = min(max(from + offset, 0), next.count - 1)
        guard to != from else { return }
        next.remove(at: from)
        next.insert(choice, at: to)
        order = next
        orderRaw = ThreadMenuChoice.raw(for: next)
    }

    private func choose(_ choice: ThreadMenuChoice) {
        guard lifted == nil, Date().timeIntervalSince(lastDrop) > 0.4 else { return }
        HapticManager.shared.impact(.light)
        isOpen = false
        Task {
            try? await Task.sleep(for: .milliseconds(220))
            onChoose(choice)
        }
    }
}

private struct WheelLayout: View, Animatable {
    var progress: CGFloat
    var spin: Double
    let hub: CGPoint
    let incognito: Bool
    let choices: [ThreadMenuChoice]
    let lifted: ThreadMenuChoice?
    let liftedPoint: CGPoint
    let onChoose: (ThreadMenuChoice) -> Void
    let onLiftMove: (ThreadMenuChoice, CGPoint) -> Void
    let onLiftEnd: () -> Void
    let onNudge: (ThreadMenuChoice, Int) -> Void
    let onClose: () -> Void

    /// Only the opening animates here; each item animates its own angle, so it travels along the arc.
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        ZStack {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                Color.appBackground.opacity(0.6)
            }
            .opacity(Double(min(max(progress, 0), 1)))
            .ignoresSafeArea()
            .onTapGesture(perform: onClose)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Close menu")

            ForEach(Array(choices.enumerated()), id: \.element) { index, choice in
                WheelItem(
                    angle: ThreadWheelMenu.firstAngle + ThreadWheelMenu.step * Double(index) + spin,
                    heldMix: lifted == choice ? 1 : 0,
                    choice: choice, index: index, count: choices.count,
                    progress: progress, hub: hub, incognito: incognito, liftedPoint: liftedPoint,
                    onChoose: onChoose, onLiftMove: onLiftMove, onLiftEnd: onLiftEnd, onNudge: onNudge
                )
                .zIndex(lifted == choice ? 10 : 0)
            }

            WheelHub(progress: progress, incognito: incognito)
                .position(hub)
                .onTapGesture(perform: onClose)
                .accessibilityLabel("Close menu")
                .accessibilityAddTraits(.isButton)
        }
        .coordinateSpace(name: "wheel")
    }

}

/// One item on the arc. Its angle is what animates, so moving it (a spin, or making room for a dragged
/// item) carries it round the arc instead of cutting across.
private struct WheelItem: View, Animatable {
    /// Unwrapped angle from straight down: first slot plus one step per place, plus the wheel's spin.
    var angle: Double
    /// 0 resting on the arc, 1 held under a finger.
    var heldMix: Double
    let choice: ThreadMenuChoice
    let index: Int
    let count: Int
    let progress: CGFloat
    let hub: CGPoint
    let incognito: Bool
    let liftedPoint: CGPoint
    let onChoose: (ThreadMenuChoice) -> Void
    let onLiftMove: (ThreadMenuChoice, CGPoint) -> Void
    let onLiftEnd: () -> Void
    let onNudge: (ThreadMenuChoice, Int) -> Void

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(angle, heldMix) }
        set { angle = newValue.first; heldMix = newValue.second }
    }

    private let radius: CGFloat = 180
    private let swing: Double = 70
    private var step: Double { ThreadWheelMenu.step }
    private var firstAngle: Double { ThreadWheelMenu.firstAngle }
    private var cycle: Double { step * Double(count) }
    /// The part of the circle that is on screen; items past it wait out of sight until the wheel turns.
    private var window: Double { step * Double(min(count, ThreadMenuChoice.reachable)) }
    private var windowStart: Double { firstAngle - step / 2 }
    /// The bottom slot, nearest the thumb: the item resting here is the selected one.
    private var focus: Double { firstAngle }

    /// Where the angle falls on the circle; items leaving one end return at the other.
    private var slot: Double {
        let raw = angle - windowStart
        return windowStart + raw - cycle * (raw / cycle).rounded(.down)
    }

    private func restingPoint(open: Double) -> CGPoint {
        let theta = (slot + swing * (1 - open)) * .pi / 180
        return CGPoint(
            x: hub.x - CGFloat(sin(theta)) * radius * CGFloat(open),
            y: hub.y + CGFloat(cos(theta)) * radius * CGFloat(open)
        )
    }

    var body: some View {
        let stagger = CGFloat(min(index, ThreadMenuChoice.reachable - 1))
        let raw = (progress - stagger * 0.07) / (1 - 0.07 * CGFloat(ThreadMenuChoice.reachable - 1))
        let q = max(raw, 0)
        let open = Double(min(q, 1))
        let rest = restingPoint(open: open)
        let held = heldMix
        let point = CGPoint(x: rest.x + (liftedPoint.x - rest.x) * held, y: rest.y + (liftedPoint.y - rest.y) * held)
        let nearness = max(0, 1 - abs(slot - focus) / step)
        let edge = min(1, max(0, min(slot - windowStart, windowStart + window - slot) / 10))
        let active = choice == .privateChat && incognito
        let highlight: Double = active ? 1 : min(max((nearness - 0.4) / 0.6, 0), 1)
        let selected = nearness > 0.5
        return ZStack {
            ZStack {
                Circle().fill(Color.appReceivedBubble)
                Circle().fill(Color.appAction).opacity(highlight)
                WheelGlyph(choice: choice, size: 20, active: active)
                    .foregroundColor(highlight > 0.5 ? Color.appOnAction : Color.appInk)
            }
            .frame(width: 52, height: 52)
            .overlay(alignment: .bottom) {
                Text(active ? "Private · On" : choice.title)
                    .font(.appBody(selected || active ? 13 : 12, weight: selected || active ? .semibold : .medium))
                    .foregroundStyle(Color.appInk.opacity(0.62 + 0.38 * max(nearness, active ? 1 : 0)))
                    .lineLimit(1)
                    .fixedSize()
                    .alignmentGuide(.bottom) { d in d[.top] - 8 }
                    .opacity(Double(min(max((q - 0.5) * 2, 0), 1)))
            }
            .scaleEffect((0.4 + 0.6 * min(q, 1)) * (1 + 0.2 * CGFloat(nearness)) * (1 + 0.3 * CGFloat(held)))
            .shadow(color: .black.opacity(0.35 * held), radius: 14, y: 6)
            .opacity(Double(min(q * 1.8, 1)) * (edge + (1 - edge) * held))
        }
        .contentShape(Circle().inset(by: -8))
        .allowsHitTesting(edge > 0.6 || held > 0.5)
        .onTapGesture { onChoose(choice) }
        .gesture(
            LongPressGesture(minimumDuration: 0.4)
                .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("wheel")))
                .onChanged { value in
                    if case .second(true, let drag) = value {
                        onLiftMove(choice, drag?.location ?? rest)
                    }
                }
                .onEnded { _ in onLiftEnd() }
        )
        .position(x: point.x, y: point.y)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(choice.title)
        .accessibilityValue(choice == .privateChat ? (incognito ? "On" : "Off") : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onChoose(choice) }
        .accessibilityAction(named: "Move earlier") { onNudge(choice, -1) }
        .accessibilityAction(named: "Move later") { onNudge(choice, 1) }
    }
}

/// Reorder the wheel. The first four stay on the arc; the rest are a spin away.
struct WheelEditorSheet: View {
    @Binding var orderRaw: String
    @Environment(\.dismiss) private var dismiss

    private var items: [ThreadMenuChoice] { ThreadMenuChoice.ordered(from: orderRaw) }

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Your wheel")
                        .font(.appEditorial(30, weight: 400, soft: 30, wonk: false, relativeTo: .title1))
                        .foregroundStyle(Color.appInk)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { dismiss() } label: {
                        Text("Done")
                            .font(.appBody(15, weight: .semibold))
                            .foregroundStyle(Color.appAccent)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 20)

                Text("The first four stay in reach. Drag to reorder.")
                    .font(.appBody(14))
                    .foregroundStyle(Color.appMuted)
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.bottom, 8)

                List {
                    ForEach(Array(items.enumerated()), id: \.element) { index, choice in
                        HStack(spacing: 14) {
                            AdamDot(solid: index < ThreadMenuChoice.reachable, size: 10)
                            Text(choice.title)
                                .font(.appBody(16, weight: .medium))
                                .foregroundStyle(Color.appInk)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44)
                        .listRowInsets(EdgeInsets(top: 2, leading: AppSpacing.margin, bottom: 2, trailing: AppSpacing.margin))
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(Color.appHairline)
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(index < ThreadMenuChoice.reachable ? "On the wheel" : "A spin away")
                    }
                    .onMove { source, destination in
                        var next = items
                        next.move(fromOffsets: source, toOffset: destination)
                        orderRaw = ThreadMenuChoice.raw(for: next)
                        HapticManager.shared.select()
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.editMode, .constant(.active))

                if !orderRaw.isEmpty {
                    Button {
                        orderRaw = ""
                        HapticManager.shared.impact(.light)
                    } label: {
                        Text("Reset")
                            .font(.appBody(14))
                            .foregroundStyle(Color.appMuted)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 12)
                }
            }
        }
    }
}
