import SwiftUI

/// Pairing screen: a mono sub-header, a quiet tabletop-device glyph standing in
/// for real artwork, a single line of instruction, and a thin rotating silver
/// arc at the foot — quiet, expensive, patient.
struct SetupPendantView: View {
    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                Text("CONNECTING DEVICE")
                    .font(.appBody(11, weight: .semibold))
                    .tracking(2.4)
                    .foregroundStyle(Color.appMuted)

                HomeDeviceGlyph()
                    .frame(width: 168, height: 126)
                    .padding(.top, 56)

                Text("Place your home device on its charger to begin pairing.")
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(Color.appMuted)
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

/// A minimal tabletop-device stand-in, drawn in thin titanium strokes.
/// Placeholder until the physical industrial design artwork lands.
private struct HomeDeviceGlyph: View {
    var body: some View {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Color.appTitanium, lineWidth: 1)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Color.appAdaptive(dark: .white, light: .black).opacity(0.03))
                )
                .frame(width: 142, height: 88)
                .overlay(
                    Capsule()
                        .fill(Color.appTitanium.opacity(0.35))
                        .frame(width: 24, height: 3)
                        .offset(y: 28)
                )
            Capsule()
                .strokeBorder(Color.appTitanium, lineWidth: 1)
                .frame(width: 166, height: 14)
                .offset(y: -3)
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
            .stroke(Color.appTitanium, style: StrokeStyle(lineWidth: 1, lineCap: .round))
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
