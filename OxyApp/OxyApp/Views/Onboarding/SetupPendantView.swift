import SwiftUI

/// Pairing screen: a mono sub-header, a high-contrast pendant glyph standing in
/// for real artwork, a single line of instruction, and a thin rotating silver
/// arc at the foot — quiet, expensive, patient.
struct SetupPendantView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                Text("CONNECTING DEVICE")
                    .font(.nmlBody(11, weight: .semibold))
                    .tracking(2.4)
                    .foregroundStyle(Color.nmlMuted)

                PendantGlyph()
                    .frame(width: 120, height: 168)
                    .padding(.top, 56)

                Text("Connect your pendant to the charger to begin pairing.")
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 48)
                    .padding(.top, 56)

                Spacer()

                SilverArcSpinner()
                    .padding(.bottom, 64)
            }
        }
    }
}

/// A minimal, high-contrast pendant stand-in: the Core disc on its bail loop,
/// drawn in thin titanium strokes. Placeholder until real artwork lands.
private struct PendantGlyph: View {
    var body: some View {
        VStack(spacing: 0) {
            // Bail loop
            Circle()
                .strokeBorder(Color.nmlTitanium, lineWidth: 1)
                .frame(width: 22, height: 22)
                .zIndex(1)

            // Core disc
            Circle()
                .strokeBorder(Color.nmlTitanium, lineWidth: 1)
                .background(
                    Circle().fill(Color.white.opacity(0.03))
                )
                .frame(width: 116, height: 116)
                .overlay(
                    Circle()
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                        .padding(16)
                )
                .offset(y: -8)
        }
    }
}

/// A single thin silver arc, rotating forever — a 1px loading indicator with no
/// track, no fill, no fuss.
private struct SilverArcSpinner: View {
    @State private var spinning = false

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.18)
            .stroke(Color.nmlTitanium, style: StrokeStyle(lineWidth: 1, lineCap: .round))
            .frame(width: 28, height: 28)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
            .accessibilityLabel("Pairing")
    }
}

#Preview {
    SetupPendantView()
}
