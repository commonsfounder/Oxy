import SwiftUI

/// Consent gate.
struct LegalConsentView: View {
    var onContinue: () -> Void = {}

    @State private var agreedTerms = false
    @State private var agreedPrivacy = false

    private var canContinue: Bool { agreedTerms && agreedPrivacy }

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                Text("Agreement")
                    .font(.appBody(13, weight: .medium))
                    .foregroundStyle(Color.appMuted)

                Text("Before we begin.")
                    .font(.appDisplay(36, weight: .regular))
                    .foregroundStyle(Color.appInk)
                    .padding(.top, 18)

                Text("Review how your data is handled before continuing.")
                    .font(.appBody(15))
                    .foregroundStyle(Color.appMuted)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 14)

                VStack(spacing: 0) {
                    consentRow(
                        isOn: $agreedTerms,
                        lead: "I agree to the",
                        emphasis: "Terms of Service"
                    )
                    AppDivider()
                    consentRow(
                        isOn: $agreedPrivacy,
                        lead: "I have read the",
                        emphasis: "Privacy Policy"
                    )
                }
                .padding(.top, 40)

                Spacer(minLength: 0)

                AppPrimaryButton(title: "Agree and continue", action: onContinue)
                    .disabled(!canContinue)
                    .opacity(canContinue ? 1 : 0.4)
                    .animation(.appFast, value: canContinue)
            }
            .padding(.horizontal, 28)
            .padding(.top, 80)
            .padding(.bottom, 44)
        }
    }

    private func consentRow(isOn: Binding<Bool>, lead: String, emphasis: String) -> some View {
        Button {
            HapticManager.shared.impact(.rigid)
            withAnimation(.appSpring) { isOn.wrappedValue.toggle() }
        } label: {
            HStack(alignment: .center, spacing: 16) {
                AppCheckbox(isOn: isOn.wrappedValue)
                (
                    Text(lead + " ")
                        .foregroundColor(Color.appMuted)
                    + Text(emphasis)
                        .foregroundColor(Color.appInk)
                )
                .font(.system(size: 14, weight: .regular))
                Spacer(minLength: 0)
            }
            .padding(.vertical, 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct AppCheckbox: View {
    let isOn: Bool

    var body: some View {
        Rectangle()
            .fill(isOn ? Color.appInk : Color.clear)
            .frame(width: 16, height: 16)
            .overlay(
                Rectangle()
                    .strokeBorder(isOn ? Color.clear : Color.appAdaptive(dark: .white, light: .black).opacity(0.3), lineWidth: 1)
            )
            .animation(.appFast, value: isOn)
    }
}

#Preview {
    LegalConsentView()
}
