import SwiftUI

/// No bar: the thread runs to the top of the screen and fades out under the status bar.
/// The only control is the menu hub, floating top right, with a small dot for live state.
struct ThreadHeader: View {
    var isIncognito: Bool
    var isWorking: Bool
    var speakerOnline: Bool
    @Binding var wheelOpen: Bool
    @Binding var hubCenter: CGPoint

    var body: some View {
        ZStack(alignment: .top) {
            if isIncognito {
                Text("Private")
                    .font(.appBody(12, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.appAction))
                    .padding(.top, 14)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityLabel("Private chat is on")
            }

            HStack {
                Spacer()
                Button {
                    HapticManager.shared.impact(.light)
                    wheelOpen = true
                } label: {
                    WheelHub(progress: 0, incognito: isIncognito)
                        .overlay(alignment: .topTrailing) { statusDot }
                }
                .buttonStyle(.appScale)
                .opacity(wheelOpen ? 0 : 1)
                .onGeometryChange(for: CGPoint.self) { proxy in
                    let frame = proxy.frame(in: .global)
                    return CGPoint(x: frame.midX, y: frame.midY)
                } action: { hubCenter = $0 }
                .accessibilityLabel("Menu")
                .accessibilityValue(statusDescription)
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 18)
        .background {
            LinearGradient(
                stops: [
                    .init(color: Color.appBackground, location: 0),
                    .init(color: Color.appBackground.opacity(0.92), location: 0.55),
                    .init(color: Color.appBackground.opacity(0), location: 1)
                ],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        }
        .animation(.appSpring, value: isIncognito)
        .animation(.appStandard, value: isWorking)
        .animation(.appStandard, value: speakerOnline)
    }

    @ViewBuilder
    private var statusDot: some View {
        if isWorking {
            PulsingDot(color: .appWorking)
        } else if speakerOnline {
            Circle().fill(Color.appDone)
                .frame(width: 9, height: 9)
                .overlay(Circle().strokeBorder(Color.appBackground, lineWidth: 2))
        }
    }

    private var statusDescription: String {
        if isWorking { return "Adam is working" }
        if speakerOnline { return "Speaker online" }
        return ""
    }
}

private struct PulsingDot: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle().fill(color)
            .frame(width: 9, height: 9)
            .overlay(Circle().strokeBorder(Color.appBackground, lineWidth: 2))
            .background(
                Circle().fill(color.opacity(0.35))
                    .scaleEffect(on && !reduceMotion ? 2.2 : 1)
                    .opacity(on && !reduceMotion ? 0 : 0.8)
            )
            .onAppear {
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true }
            }
    }
}
