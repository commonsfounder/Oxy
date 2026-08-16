import SwiftUI
import UIKit

// MARK: - Task session

struct AgentTaskSessionView: View {
    @Bindable var session: AgentTaskSession
    var onDismiss: () -> Void
    var onComplete: (String) -> Void
    var onOpenChat: (String?) -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var ink: Color {
        Color.appInk
    }

    var body: some View {
        ZStack {
            AgenticWashBackground().ignoresSafeArea()

            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                if let errorMessage = session.errorMessage {
                    ErrorBanner(message: errorMessage, onRetry: {
                        Task { await session.retry() }
                    })
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                }

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
                    .background(Color.appSurface, in: Circle())
                    .overlay(Circle().strokeBorder(Color.appHairline, lineWidth: 0.5))
            }
            .buttonStyle(.appScale)

            Text(session.title)
                .font(.appBody(15, weight: .semibold))
                .foregroundStyle(ink)
                .lineLimit(1)

            Spacer()

            if let progress = session.progressText {
                Text(progress)
                    .font(.appBody(13, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.5))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.appSurface, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.5))
            }
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        if let step = session.currentStep {
            VStack(alignment: .leading, spacing: 0) {
                switch step.ui {
                case .paymentConfirm(let details):
                    PaymentConfirmStepView(details: details, ink: ink)
                case .productDetail(let details):
                    ProductDetailStepView(details: details, ink: ink)
                case .rideConfirm(let details):
                    RideConfirmStepView(details: details, ink: ink)
                case .linkResult(let details):
                    LinkResultStepView(details: details, ink: ink)
                case .assistantAsk(let text):
                    AssistantAskStepView(text: text, ink: ink, isSending: session.isWorking) { reply in
                        Task { await session.sendReply(reply) }
                    }
                case .workingHero(let status):
                    WorkingHeroStepView(title: step.title, status: status, ink: ink)
                }

                if !session.liveSteps.isEmpty, isStepThatShowsTrace(step.ui) {
                    LiveStepsTraceView(steps: session.liveSteps, ink: ink)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                SessionDoneStepView(title: session.title, ink: ink)
                if !session.liveSteps.isEmpty {
                    LiveStepsTraceView(steps: session.liveSteps, ink: ink)
                }
            }
        }
    }

    private func isStepThatShowsTrace(_ ui: StepUI) -> Bool {
        switch ui {
        case .paymentConfirm, .productDetail, .rideConfirm, .linkResult: return true
        case .workingHero, .assistantAsk: return false
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
                    Text("Chat")
                        .font(.appBody(14, weight: .medium))
                }
                .foregroundStyle(ink.opacity(0.75))
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity)
                .background(Color.appSurface, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.6))
            }
            .buttonStyle(.appScale)

            if session.isComplete {
                Button {
                    HapticManager.shared.impact(.medium)
                    onComplete(session.title)
                } label: {
                    primaryLabel("Done")
                }
                .buttonStyle(.appScale(0.96))
            } else if let step = session.currentStep, !isAssistantAsk(step.ui) {
                Button {
                    HapticManager.shared.impact(.medium)
                    switch step.ui {
                    case .paymentConfirm:
                        Task { await session.confirmPayment() }
                    case .rideConfirm(let details):
                        openRideLink(details)
                        withAnimation(.appSpring) { session.advance() }
                    default:
                        withAnimation(.appSpring) { session.advance() }
                    }
                } label: {
                    primaryLabel(step.ctaLabel)
                }
                .buttonStyle(.appScale(0.96))
                .disabled(!step.canAdvance || session.isWorking)
                .opacity(step.canAdvance && !session.isWorking ? 1 : 0.4)
            }
        }
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.2 : 0.05), radius: 6, y: 2)
    }

    private func isAssistantAsk(_ ui: StepUI) -> Bool {
        if case .assistantAsk = ui { return true }
        return false
    }

    private func openRideLink(_ details: RideDetails) {
        if let link = details.deepLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        } else if let link = details.webLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        }
    }

    private func primaryLabel(_ text: String) -> some View {
        Text(text)
            .font(.appBody(14, weight: .semibold))
            .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 13)
            .background(ink, in: Capsule())
            .fixedSize(horizontal: true, vertical: false)
    }
}
