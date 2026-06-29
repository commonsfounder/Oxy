import SwiftUI

/// Consent gate in the Nameless language: obsidian ground, editorial serif
/// header, custom fill-box checkboxes (no green switches), and a single stark
/// white pill to proceed. Continuing is blocked until both boxes are filled.
struct LegalConsentView: View {
    var onContinue: () -> Void = {}

    @State private var agreedTerms = false
    @State private var agreedPrivacy = false

    private var canContinue: Bool { agreedTerms && agreedPrivacy }

    var body: some View {
        ZStack {
            Color.edCanvas.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                Text("AGREEMENT")
                    .font(.nmlBody(11, weight: .semibold))
                    .tracking(2.4)
                    .foregroundStyle(Color.nmlMuted)

                Text("Before we begin.")
                    .font(.nmlDisplay(36, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                    .padding(.top, 18)

                Text("Yours alone. Confirm you've read how your data is handled before continuing.")
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 14)

                VStack(spacing: 0) {
                    consentRow(
                        isOn: $agreedTerms,
                        lead: "I agree to the",
                        emphasis: "Terms of Service"
                    )
                    NamelessDivider()
                    consentRow(
                        isOn: $agreedPrivacy,
                        lead: "I have read the",
                        emphasis: "Privacy Policy"
                    )
                }
                .padding(.top, 40)

                Spacer(minLength: 0)

                NamelessPrimaryButton(title: "AGREE AND CONTINUE", action: onContinue)
                    .disabled(!canContinue)
                    .opacity(canContinue ? 1 : 0.4)
                    .animation(.nmlFast, value: canContinue)
            }
            .padding(.horizontal, 28)
            .padding(.top, 80)
            .padding(.bottom, 44)
        }
    }

    private func consentRow(isOn: Binding<Bool>, lead: String, emphasis: String) -> some View {
        Button {
            HapticManager.shared.impact(.rigid)
            withAnimation(.nmlSpring) { isOn.wrappedValue.toggle() }
        } label: {
            HStack(alignment: .center, spacing: 16) {
                NamelessCheckbox(isOn: isOn.wrappedValue)
                (
                    Text(lead + " ")
                        .foregroundColor(Color.nmlMuted)
                    + Text(emphasis)
                        .foregroundColor(Color.nmlInk)
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

/// A 16×16 box that simply fills with soft silver when selected — no checkmark,
/// no animation theatrics, just presence or absence.
private struct NamelessCheckbox: View {
    let isOn: Bool

    var body: some View {
        Rectangle()
            .fill(isOn ? Color.nmlInk : Color.clear)
            .frame(width: 16, height: 16)
            .overlay(
                Rectangle()
                    .strokeBorder(isOn ? Color.clear : Color.white.opacity(0.3), lineWidth: 1)
            )
            // A small overshoot as it fills — presence with a little life, not a hard flip.
            .scaleEffect(isOn ? 1.08 : 1.0)
            .animation(.nmlSpring, value: isOn)
    }
}

#Preview {
    LegalConsentView()
}
