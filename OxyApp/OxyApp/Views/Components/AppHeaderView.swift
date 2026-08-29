import SwiftUI

/// Chat header.
struct AppHeaderView: View {
    @Binding var isIncognito: Bool
    var isEmptyChat: Bool = false
    var showsBackButton: Bool = false
    var onLeading: () -> Void = {}
    var onNewChat: (() -> Void)? = nil

    private let circle: CGFloat = 38

    var body: some View {
        HStack {
            Button(action: onLeading) {
                AppIcon(showsBackButton ? "chevron-left" : "menu", size: 18)
                    .foregroundColor(Color.appInk)
                    .frame(width: circle, height: circle)
                    .appGlass(Circle(), interactive: true)
            }
            .buttonStyle(.appScale)
            .accessibilityLabel(showsBackButton ? "Home" : "History")

            Spacer()

            HStack(spacing: 10) {
                if isEmptyChat || isIncognito {
                    Button {
                        withAnimation(.linear(duration: 0.15)) { isIncognito.toggle() }
                    } label: {
                        GhostIcon(active: isIncognito)
                            .frame(width: 18, height: 18)
                            .frame(width: circle, height: circle)
                            .appGlass(Circle(), tint: isIncognito ? Color.appInk : nil, interactive: true)
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel(isIncognito ? "Private chat on" : "Private chat off")
                    .accessibilityHint(isIncognito
                        ? "Private mode is on. Turns are not saved. Double tap to turn off."
                        : "Turn on private chat. Turns will not be saved.")
                }

                if !isEmptyChat, let onNewChat {
                    Button(action: onNewChat) {
                        AppIcon("edit", size: 17)
                            .foregroundColor(Color.appInk)
                            .frame(width: circle, height: circle)
                            .appGlass(Circle(), interactive: true)
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel("New conversation")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.appBackground)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.appHairline)
                .frame(height: AppBorder.hairline)
        }
        .zIndex(10)
    }
}

private struct GhostIcon: View {
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

#Preview {
    VStack(spacing: 0) {
        AppHeaderView(isIncognito: .constant(false), isEmptyChat: true)
        AppHeaderView(isIncognito: .constant(true), isEmptyChat: true)
        AppHeaderView(isIncognito: .constant(false), isEmptyChat: false)
        Spacer()
    }
    .background(Color.appObsidian)
}
