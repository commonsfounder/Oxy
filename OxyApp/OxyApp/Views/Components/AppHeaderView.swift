import SwiftUI

struct GhostIcon: View {
    var active: Bool

    var body: some View {
        GhostShape()
            .fill(active ? Color.appAdaptive(dark: Color(red: 0.08, green: 0.08, blue: 0.10), light: .white) : Color.appMuted,
                  style: FillStyle(eoFill: true))
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

