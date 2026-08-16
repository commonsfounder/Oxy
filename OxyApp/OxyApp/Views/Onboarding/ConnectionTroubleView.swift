import SwiftUI

/// Pairing recovery.
struct ConnectionTroubleView: View {
    var onRetry: () -> Void = {}
    var onSkip: () -> Void = {}

    private let checks = [
        "Is the home device on the charger?",
        "Bluetooth enabled on iPhone?",
        "Home device within 1 meter?"
    ]

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                Text("Device not found")
                    .font(.appBody(13, weight: .medium))
                    .foregroundStyle(Color.appMuted)

                Text("We couldn't reach your home device.")
                    .font(.appDisplay(30, weight: .regular))
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)

                VStack(spacing: 0) {
                    ForEach(Array(checks.enumerated()), id: \.offset) { index, check in
                        if index != 0 { AppDivider() }
                        checkRow(check)
                    }
                }
                .padding(.top, 40)

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    AppPrimaryButton(title: "Try again", action: onRetry)
                    AppOutlineButton(title: "Skip for now", action: onSkip)
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
                .font(.appMono(13))
                .foregroundStyle(Color.appMuted)
            Text(text)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.appInk)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 18)
    }
}

#Preview {
    ConnectionTroubleView()
}
