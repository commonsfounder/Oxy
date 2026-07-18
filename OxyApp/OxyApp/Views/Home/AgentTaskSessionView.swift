import SwiftUI
import UIKit

// MARK: - Agent Task Session shell (real-data native job flows)
//
// Persistent chrome: close · task title · step k/n. Body swaps per-step generated
// UI, driven by real results from the same backend pipeline chat uses. Bottom dock
// always offers a way back into free chat. Black pill CTA advances the flow, or on
// the payment/ride step, calls the real confirm_browser_payment action / opens the
// real Uber deep link.

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

                if let errorMessage = session.errorMessage {
                    ErrorBanner(message: errorMessage, onRetry: {
                        session.errorMessage = nil
                        Task { await session.start(onHandoff: onOpenChat) }
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
        // Real data only: kicks off the hidden pipeline once when the session opens.
        // Tied to the view's identity, so it auto-cancels if the cover is dismissed
        // mid-flight.
        .task {
            await session.start(onHandoff: onOpenChat)
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
            case .paymentConfirm(let details):
                PaymentConfirmStepView(details: details, ink: ink)
            case .productDetail(let details):
                ProductDetailStepView(details: details, ink: ink)
            case .rideConfirm(let details):
                RideConfirmStepView(details: details, ink: ink)
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
                    switch step.ui {
                    case .paymentConfirm:
                        Task { await session.confirmPayment(onHandoff: onOpenChat) }
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
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.35 : 0.08), radius: 18, y: 8)
    }

    // Same deep-link-then-web-link fallback ChatViewModel.openActionLink already
    // uses for book_uber results — one open behavior for the same action result
    // shape, whether it arrived via chat or this hidden pipeline.
    private func openRideLink(_ details: RideDetails) {
        if let link = details.deepLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        } else if let link = details.webLink, let url = URL(string: link) {
            UIApplication.shared.open(url)
        }
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
