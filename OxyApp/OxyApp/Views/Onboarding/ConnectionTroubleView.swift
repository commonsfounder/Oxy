import SwiftUI

/// Shown when pairing fails: a restrained warning header, a short checklist with
/// hairline separators, and two actions — a stark white retry and a quiet
/// border-only skip.
struct ConnectionTroubleView: View {
    var onRetry: () -> Void = {}
    var onSkip: () -> Void = {}

    private let checks = [
        "Is the pendant on the charger?",
        "Bluetooth enabled on iPhone?",
        "Pendant within 1 meter?"
    ]

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                Text("[ NO DEVICE FOUND ]")
                    .font(.nmlMono(11, weight: .medium))
                    .tracking(2)
                    .foregroundStyle(Color.nmlMuted)

                Text("We couldn't reach your pendant.")
                    .font(.system(size: 30, weight: .regular, design: .serif))
                    .foregroundStyle(Color.nmlInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)

                VStack(spacing: 0) {
                    ForEach(Array(checks.enumerated()), id: \.offset) { index, check in
                        if index != 0 { NamelessDivider() }
                        checkRow(check)
                    }
                }
                .padding(.top, 40)

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    NamelessPrimaryButton(title: "TRY AGAIN", action: onRetry)
                    NamelessOutlineButton(title: "SKIP FOR NOW", action: onSkip)
                }
            }
            .padding(.horizontal, 28)
            .padding(.top, 80)
            .padding(.bottom, 44)
        }
    }

    private func checkRow(_ text: String) -> some View {
        HStack(spacing: 14) {
            Text("—")
                .font(.nmlMono(13))
                .foregroundStyle(Color.nmlMuted)
            Text(text)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 18)
    }
}

#Preview {
    ConnectionTroubleView()
}
