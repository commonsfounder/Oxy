import SwiftUI

/// What the wheel can open.
enum ThreadMenuChoice: String, CaseIterable, Identifiable {
    case activity, home, settings, privateChat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .activity: return "Activity"
        case .home: return "Your home"
        case .settings: return "Settings"
        case .privateChat: return "Private mode"
        }
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
            case .settings: AppIcon("list", size: size)
            case .privateChat: GhostIcon(active: active).frame(width: size, height: size)
            }
        }
    }
}

/// The closed button: the Adam mark in a circle. It turns into a cross as the wheel opens.
struct WheelHub: View {
    var progress: CGFloat
    var incognito: Bool

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
            } else {
                AdamMark()
                    .frame(width: 22, height: 16)
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
    var onChoose: (ThreadMenuChoice) -> Void

    @State private var progress: CGFloat = 0
    @State private var spin: Double = 0
    @State private var dragBase: (angle: Double, spin: Double)?
    @State private var lastDetent = 0
    @State private var mounted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Four items share one quarter circle: 5°, 33°, 61°, 89° from straight down.
    static let step: Double = 28

    var body: some View {
        ZStack {
            if mounted {
                WheelLayout(progress: progress, spin: spin, hub: hub, incognito: incognito,
                            onChoose: choose, onClose: { isOpen = false })
                    .simultaneousGesture(dragGesture)
            }
        }
        .allowsHitTesting(mounted)
        .onChange(of: isOpen) { _, open in
            if open {
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
                guard let base = dragBase else { return }
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

    private func choose(_ choice: ThreadMenuChoice) {
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
    let onChoose: (ThreadMenuChoice) -> Void
    let onClose: () -> Void

    var animatableData: AnimatablePair<CGFloat, Double> {
        get { AnimatablePair(progress, spin) }
        set { progress = newValue.first; spin = newValue.second }
    }

    private let radius: CGFloat = 180
    private let firstAngle: Double = 5
    private let swing: Double = 70

    private var step: Double { ThreadWheelMenu.step }
    private var cycle: Double { step * Double(ThreadMenuChoice.allCases.count) }
    private var windowStart: Double { firstAngle - step / 2 }
    /// The bottom slot, nearest the thumb: the item resting here is the selected one.
    private var focus: Double { firstAngle }

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

            ForEach(Array(ThreadMenuChoice.allCases.enumerated()), id: \.element) { index, choice in
                item(choice, index: index)
            }

            WheelHub(progress: progress, incognito: incognito)
                .position(hub)
                .onTapGesture(perform: onClose)
                .accessibilityLabel("Close menu")
                .accessibilityAddTraits(.isButton)
        }
    }

    /// Where an item sits on the arc once spin is applied; items leaving one end return at the other.
    private func slotAngle(_ index: Int) -> Double {
        let raw = firstAngle + step * Double(index) + spin - windowStart
        let wrapped = raw - cycle * (raw / cycle).rounded(.down)
        return windowStart + wrapped
    }

    private func item(_ choice: ThreadMenuChoice, index: Int) -> some View {
        let raw = (progress - CGFloat(index) * 0.07) / (1 - 0.07 * CGFloat(ThreadMenuChoice.allCases.count - 1))
        let q = max(raw, 0)
        let open = Double(min(q, 1))
        let slot = slotAngle(index)
        let angle = (slot + swing * (1 - open)) * .pi / 180
        let offset = WheelHub.slotOffset(choice)
        // Every item ends exactly `radius` from the hub; only the stagger is per item.
        let x = hub.x + offset.width * CGFloat(1 - open) - CGFloat(sin(angle)) * radius * CGFloat(open)
        let y = hub.y + offset.height * CGFloat(1 - open) + CGFloat(cos(angle)) * radius * CGFloat(open)
        let nearness = max(0, 1 - abs(slot - focus) / step)
        let edge = min(1, max(0, min(slot - windowStart, windowStart + cycle - slot) / 10))
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
            .scaleEffect((0.4 + 0.6 * min(q, 1)) * (1 + 0.2 * CGFloat(nearness)))
            .opacity(Double(min(q * 1.8, 1)) * edge)
        }
        .contentShape(Circle().inset(by: -8))
        .onTapGesture { onChoose(choice) }
        .position(x: x, y: y)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(choice.title)
        .accessibilityValue(choice == .privateChat ? (incognito ? "On" : "Off") : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onChoose(choice) }
    }
}
