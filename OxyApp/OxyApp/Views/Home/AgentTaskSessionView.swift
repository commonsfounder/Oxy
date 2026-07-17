import SwiftUI

// MARK: - Agent Task Session shell (Video B pattern)
//
// Persistent chrome: close · task title · step k/n. Body swaps per-step generated
// UI. Bottom dock always offers a way back into free chat. Black pill CTA advances
// the plan; label is contextual per step (set by the plan generator).

struct AgentTaskSessionView: View {
    @Bindable var session: AgentTaskSession
    var onDismiss: () -> Void
    var onComplete: (String) -> Void
    var onOpenChat: (String?) -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var ink: Color {
        colorScheme == .dark
            ? Color(red: 0.95, green: 0.95, blue: 0.94)
            : Color(red: 0.12, green: 0.12, blue: 0.14)
    }

    var body: some View {
        ZStack {
            AgenticWashBackground().ignoresSafeArea()

            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                ScrollView(showsIndicators: false) {
                    stepContent
                        .padding(.horizontal, 20)
                        .padding(.top, 20)
                        .padding(.bottom, 140)
                }
                .animation(.appSpring, value: session.currentIndex)
            }

            VStack {
                Spacer()
                dock
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        // Working-hero steps advance themselves once the "job" settles. Tying this
        // to the step index via .task(id:) means it auto-cancels the moment the
        // step changes or the cover is dismissed — no stray timer can fire late.
        .task(id: session.currentIndex) {
            guard case .workingHero = session.currentStep?.ui else { return }
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.appSpring) { session.advance() }
        }
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                onDismiss()
            } label: {
                AppIcon("xmark", size: 14)
                    .foregroundStyle(ink.opacity(0.8))
                    .frame(width: 34, height: 34)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)

            Text(session.title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ink)
                .lineLimit(1)

            Spacer()

            if let progress = session.progressText {
                Text(progress)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.5))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
            }
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        if let step = session.currentStep {
            switch step.ui {
            case .planBoard(let entries):
                PlanBoardStepView(entries: entries, ink: ink)
            case .timePicker(let slots):
                TimePickerStepView(step: step, slots: slots, ink: ink)
            case .placePicker(let subtitle, let results):
                PlacePickerStepView(step: step, subtitle: subtitle, results: results, ink: ink)
            case .personPicker(let people, let draft):
                PersonPickerStepView(step: step, people: people, draftMessage: draft, ink: ink)
            case .rideConfirm(let details):
                RideConfirmStepView(details: details, ink: ink)
            case .paymentConfirm(let details):
                PaymentConfirmStepView(details: details, ink: ink)
            case .productDetail(let details):
                ProductDetailStepView(details: details, ink: ink)
            case .workingHero(let status):
                WorkingHeroStepView(title: step.title, status: status, ink: ink)
            }
        } else {
            SessionDoneStepView(title: session.title, ink: ink)
        }
    }

    // MARK: - Dock

    private var dock: some View {
        HStack(spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                onOpenChat(nil)
            } label: {
                HStack(spacing: 8) {
                    AppIcon("chat", size: 15)
                    Text("Tap to chat")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(ink.opacity(0.75))
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.1 : 0.65), lineWidth: 0.6))
            }
            .buttonStyle(.plain)

            if session.isComplete {
                Button {
                    HapticManager.shared.impact(.medium)
                    onComplete(session.title)
                } label: {
                    primaryLabel("Done")
                }
                .buttonStyle(.appScale(0.96))
            } else if let step = session.currentStep {
                Button {
                    HapticManager.shared.impact(.medium)
                    withAnimation(.appSpring) { session.advance() }
                } label: {
                    primaryLabel(step.ctaLabel)
                }
                .buttonStyle(.appScale(0.96))
                .disabled(!step.canAdvance)
                .opacity(step.canAdvance ? 1 : 0.4)
            }
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.35 : 0.08), radius: 18, y: 8)
    }

    private func primaryLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 13)
            .background(ink, in: Capsule())
            .fixedSize(horizontal: true, vertical: false)
    }
}
