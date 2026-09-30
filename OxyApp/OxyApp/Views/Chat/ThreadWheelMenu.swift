import SwiftUI

/// What the wheel can open.
enum ThreadMenuChoice: String, CaseIterable, Identifiable {
    case history, home, settings, privateChat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .history: return "History"
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
            case .history: AppIcon("history", size: size)
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
        (.history, CGSize(width: -1, height: -1)), (.home, CGSize(width: 1, height: -1)),
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
struct ThreadWheelMenu: View {
    let hub: CGPoint
    @Binding var isOpen: Bool
    var incognito: Bool
    var onChoose: (ThreadMenuChoice) -> Void

    @State private var progress: CGFloat = 0
    @State private var mounted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if mounted {
                WheelLayout(progress: progress, hub: hub, incognito: incognito, reduceMotion: reduceMotion,
                            onChoose: choose, onClose: { isOpen = false })
            }
        }
        .allowsHitTesting(mounted)
        .onChange(of: isOpen) { _, open in
            if open {
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
    let hub: CGPoint
    let incognito: Bool
    let reduceMotion: Bool
    let onChoose: (ThreadMenuChoice) -> Void
    let onClose: () -> Void

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    private let radius: CGFloat = 150
    private let firstAngle: Double = 6
    private let step: Double = 26
    private let spin: Double = 80

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

    private func item(_ choice: ThreadMenuChoice, index: Int) -> some View {
        let raw = (progress - CGFloat(index) * 0.07) / 0.79
        let q = max(raw, 0)
        let angle = (firstAngle + step * Double(index) + spin * Double(1 - min(q, 1))) * .pi / 180
        let slot = WheelHub.slotOffset(choice)
        let x = hub.x + slot.width * (1 - min(q, 1)) - CGFloat(sin(angle)) * radius * q
        let y = hub.y + slot.height * (1 - min(q, 1)) + CGFloat(cos(angle)) * radius * q
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
                    .font(.appBody(15, weight: .medium))
                    .foregroundStyle(Color.appInk)
                    .lineLimit(1)
                    .fixedSize()
                    .alignmentGuide(.leading) { d in d[.trailing] + 12 }
                    .opacity(Double(min(max((q - 0.5) * 2, 0), 1)))
            }
            .scaleEffect(0.3 + 0.7 * min(q, 1.08))
            .opacity(Double(min(q * 1.8, 1)))
        }
        .buttonStyle(.appScale(0.94))
        .position(x: x, y: y)
        .accessibilityLabel(choice.title)
    }
}
