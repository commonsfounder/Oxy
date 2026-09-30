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
        case .privateChat: return "Private"
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

/// The closed button: four tiny glyphs sharing one circle. It turns into a cross as the wheel opens.
struct WheelHub: View {
    var progress: CGFloat
    var incognito: Bool

    private static let slots: [(ThreadMenuChoice, CGSize)] = [
        (.activity, CGSize(width: -1, height: -1)), (.home, CGSize(width: 1, height: -1)),
        (.settings, CGSize(width: -1, height: 1)), (.privateChat, CGSize(width: 1, height: 1))
    ]

    static func slotOffset(_ choice: ThreadMenuChoice) -> CGSize {
        let unit = slots.first { $0.0 == choice }?.1 ?? .zero
        return CGSize(width: unit.width * 6.5, height: unit.height * 6.5)
    }

    var body: some View {
        let open = min(max(progress, 0), 1)
        ZStack {
            Circle().fill(Color.appReceivedBubble)
            ForEach(Self.slots, id: \.0) { choice, _ in
                WheelGlyph(choice: choice, size: 10, active: incognito)
                    .foregroundColor(Color.appInk.opacity(0.85))
                    .offset(Self.slotOffset(choice))
                    .opacity(1 - open)
            }
            ZStack {
                Capsule().frame(width: 16, height: 2)
                Capsule().frame(width: 2, height: 16)
            }
            .foregroundColor(Color.appInk)
            .rotationEffect(.degrees(Double(open) * 90 - 45))
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

    static let step: Double = 26

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
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.74)) { progress = 1 }
                }
            } else {
                withAnimation(.spring(response: 0.34, dampingFraction: 0.92)) { progress = 0 }
                Task {
                    try? await Task.sleep(for: .milliseconds(380))
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

    private let radius: CGFloat = 150
    private let firstAngle: Double = 6
    private let swing: Double = 80

    private var step: Double { ThreadWheelMenu.step }
    private var cycle: Double { step * Double(ThreadMenuChoice.allCases.count) }
    private var windowStart: Double { firstAngle - step / 2 }
    private var focus: Double { firstAngle + step * 1.5 }

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
        let raw = (progress - CGFloat(index) * 0.07) / 0.79
        let q = max(raw, 0)
        let open = Double(min(q, 1))
        let slot = slotAngle(index)
        let angle = (slot + swing * (1 - open)) * .pi / 180
        let offset = WheelHub.slotOffset(choice)
        let x = hub.x + offset.width * CGFloat(1 - open) - CGFloat(sin(angle)) * radius * q
        let y = hub.y + offset.height * CGFloat(1 - open) + CGFloat(cos(angle)) * radius * q
        let nearness = max(0, 1 - abs(slot - focus) / step)
        let edge = min(1, max(0, min(slot - windowStart, windowStart + cycle - slot) / 10))
        let active = choice == .privateChat && incognito
        return Button { onChoose(choice) } label: {
            ZStack {
                Circle().fill(active ? Color.appAction : Color.appReceivedBubble)
                WheelGlyph(choice: choice, size: 22, active: active)
                    .foregroundColor(active ? Color.appOnAction : Color.appInk)
            }
            .frame(width: 58, height: 58)
            .overlay(alignment: .leading) {
                Text(active ? "Private on" : choice.title)
                    .font(.appBody(15, weight: nearness > 0.6 ? .semibold : .medium))
                    .foregroundStyle(Color.appInk)
                    .lineLimit(1)
                    .fixedSize()
                    .alignmentGuide(.leading) { d in d[.trailing] + 12 }
                    .opacity(Double(min(max((q - 0.5) * 2, 0), 1)))
            }
            .scaleEffect((0.3 + 0.7 * min(q, 1.08)) * (1 + 0.16 * CGFloat(nearness)))
            .opacity(Double(min(q * 1.8, 1)) * edge)
        }
        .buttonStyle(.appScale(0.94))
        .position(x: x, y: y)
        .accessibilityLabel(choice.title)
    }
}
