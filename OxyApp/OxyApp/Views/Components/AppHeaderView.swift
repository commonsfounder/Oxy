import SwiftUI

/// Silent-luxury top header: pure black, no nav-bar chrome. A three-line menu
/// icon on the left (opens history); on an empty chat, a small ghost icon on the
/// right toggles incognito ("shadow") mode — filled white when active.
struct AppHeaderView: View {
    @Binding var isIncognito: Bool
    /// Only show the incognito ghost when the conversation is empty.
    var isEmptyChat: Bool = false
    /// Invoked when the left menu icon is tapped (open history/sidebar).
    var onLeading: () -> Void = {}

    private let muted = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255) // #8E8E93

    var body: some View {
        HStack {
            Button(action: onLeading) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(muted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("History")

            Spacer()

            if isEmptyChat {
                Button {
                    withAnimation(.linear(duration: 0.15)) { isIncognito.toggle() }
                } label: {
                    GhostIcon(active: isIncognito)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isIncognito ? "Shadow chat on" : "Shadow chat off")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color.black)
    }
}

/// A minimal filled ghost glyph with cut-out eyes. Muted when off, white when on.
private struct GhostIcon: View {
    var active: Bool
    private let muted = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255)

    var body: some View {
        GhostShape()
            .fill(active ? Color.white : muted, style: FillStyle(eoFill: true))
    }
}

private struct GhostShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * w, y: rect.minY + y * h)
        }
        var p = Path()
        // Body: left side up, domed head, right side down.
        p.move(to: pt(0.20, 0.90))
        p.addLine(to: pt(0.20, 0.42))
        p.addCurve(to: pt(0.80, 0.42), control1: pt(0.20, 0.04), control2: pt(0.80, 0.04))
        p.addLine(to: pt(0.80, 0.90))
        // Scalloped bottom (three bumps) back to the start.
        p.addQuadCurve(to: pt(0.60, 0.90), control: pt(0.70, 0.76))
        p.addQuadCurve(to: pt(0.40, 0.90), control: pt(0.50, 0.76))
        p.addQuadCurve(to: pt(0.20, 0.90), control: pt(0.30, 0.76))
        p.closeSubpath()
        // Eyes (cut out via even-odd fill).
        let r: CGFloat = 0.075
        p.addEllipse(in: CGRect(x: pt(0.41, 0.40).x - r * w, y: pt(0.41, 0.40).y - r * h, width: 2 * r * w, height: 2 * r * h))
        p.addEllipse(in: CGRect(x: pt(0.59, 0.40).x - r * w, y: pt(0.59, 0.40).y - r * h, width: 2 * r * w, height: 2 * r * h))
        return p
    }
}

#Preview {
    VStack(spacing: 0) {
        AppHeaderView(isIncognito: .constant(false), isEmptyChat: true)
        AppHeaderView(isIncognito: .constant(true), isEmptyChat: true)
        AppHeaderView(isIncognito: .constant(false), isEmptyChat: false)
        Spacer()
    }
    .background(Color.black)
}
