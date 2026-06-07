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
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                Text("[ AGREEMENT ]")
                    .font(.nmlMono(11, weight: .medium))
                    .tracking(2)
                    .foregroundStyle(Color.nmlMuted)

                Text("Before we begin.")
                    .font(.system(size: 34, weight: .regular, design: .serif))
                    .foregroundStyle(Color.nmlInk)
                    .padding(.top, 18)

                Text("Nameless works for you alone. Confirm you've read how it handles your data before continuing.")
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
                    .animation(.easeInOut(duration: 0.2), value: canContinue)
            }
            .padding(.horizontal, 28)
            .padding(.top, 80)
            .padding(.bottom, 44)
        }
    }

    private func consentRow(isOn: Binding<Bool>, lead: String, emphasis: String) -> some View {
        Button {
            isOn.wrappedValue.toggle()
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
        RoundedRectangle(cornerRadius: 3)
            .fill(isOn ? Color.nmlInk : Color.clear)
            .frame(width: 16, height: 16)
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .strokeBorder(isOn ? Color.clear : Color.white.opacity(0.3), lineWidth: 1)
            )
            .animation(.easeInOut(duration: 0.15), value: isOn)
    }
}

#Preview {
    LegalConsentView()
}
