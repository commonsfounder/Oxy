import SwiftUI

// MARK: - Task steps

struct StepTitleBlock: View {
    let title: String
    let subtitle: String?
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(ink)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 15))
                    .foregroundStyle(ink.opacity(0.55))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }
}

// MARK: - Payment

struct PaymentConfirmStepView: View {
    let details: PaymentDetails
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: "Confirm payment", subtitle: nil, ink: ink)

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(details.merchant)
                        .font(.system(size: 15))
                        .foregroundStyle(ink.opacity(0.6))
                    Spacer()
                    Text(details.amount)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(ink)
                }
                Divider().overlay(ink.opacity(0.08))
                Text(details.detail)
                    .font(.system(size: 13))
                    .foregroundStyle(ink.opacity(0.5))
            }
            .padding(18)
            .background { MissionGlassPlate() }

            Text("Cancel before payment.")
                .font(.system(size: 12))
                .foregroundStyle(ink.opacity(0.4))
                .padding(.top, 12)
        }
    }
}

// MARK: - Ride

struct RideConfirmStepView: View {
    let details: RideDetails
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitleBlock(title: "Ride ready", subtitle: details.summary, ink: ink)

            if let estimate = details.estimate {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Estimate")
                        .font(.appBody(13, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.45))
                    Text(estimate)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(ink)
                }
                .padding(.bottom, 14)
            }

            HStack(spacing: 6) {
                AppIcon("shield-check", size: 13)
                Text("Uber shows the final fare before you confirm.")
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(ink.opacity(0.45))
        }
    }
}

// MARK: - Email links

struct LinkResultStepView: View {
    let details: LinkResultDetails
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StepTitleBlock(title: "Here's how", subtitle: nil, ink: ink)

            if !details.steps.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(details.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(ink.opacity(0.55))
                                .frame(width: 20, height: 20)
                                .background(ink.opacity(0.08), in: Circle())
                            Text(step)
                                .font(.system(size: 14))
                                .foregroundStyle(ink.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(16)
                .background { MissionGlassPlate() }
            }

            if !details.links.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(details.links) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) {
                                HStack(spacing: 10) {
                                    AppIcon("arrow-up-right", size: 13)
                                    Text(link.label)
                                        .font(.system(size: 14, weight: .semibold))
                                    Spacer(minLength: 0)
                                }
                                .foregroundStyle(ink)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                                    .strokeBorder(Color.appHairline, lineWidth: 0.5))
                            }
                        }
                    }
                }
            }

            HStack(spacing: 6) {
                AppIcon("shield-check", size: 13)
                Text("Links from this email.")
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(ink.opacity(0.45))
        }
    }
}

// MARK: - Product

struct ProductDetailStepView: View {
    let details: ProductDetails
    var ink: Color
    @State private var selectedColorIndex: Int?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitleBlock(title: details.name, subtitle: details.subtitle.isEmpty ? nil : details.subtitle, ink: ink)

            if let priceText = details.priceText {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Price")
                        .font(.appBody(13, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.45))
                    Text(priceText)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(ink)
                }
            }

            heroImage

            if !details.colorOptions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Options")
                        .font(.appBody(13, weight: .semibold))
                        .foregroundStyle(ink.opacity(0.45))
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(details.colorOptions.enumerated()), id: \.offset) { index, option in
                                let isSelected = selectedColorIndex == index
                                Text(option)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(isSelected ? (colorScheme == .dark ? Color.black : Color.white) : ink.opacity(0.75))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 9)
                                    .background {
                                        if isSelected {
                                            Capsule().fill(ink)
                                        } else {
                                            Capsule().fill(Color.appSurface)
                                        }
                                    }
                                    .onTapGesture {
                                        HapticManager.shared.impact(.light)
                                        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                                            selectedColorIndex = index
                                        }
                                    }
                            }
                        }
                    }
                }
            }

            if details.priceText == nil {
                HStack(spacing: 6) {
                    AppIcon("shield-check", size: 13)
                    Text("Final price is confirmed at checkout")
                        .font(.system(size: 12))
                }
                .foregroundStyle(ink.opacity(0.45))
            }
        }
    }

    @ViewBuilder
    private var heroImage: some View {
        if let urlString = details.imageUrls.first, let url = URL(string: urlString) {
            AsyncImage(url: url, transaction: Transaction(animation: .appFast)) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill().transition(.opacity)
                default:
                    placeholderPlate
                }
            }
            .frame(height: 190)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
                    .strokeBorder(Color.appHairline, lineWidth: 0.6)
            )
        } else {
            placeholderPlate
                .frame(height: 190)
                .frame(maxWidth: .infinity)
        }
    }

    private var placeholderPlate: some View {
        ZStack {
            RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
                .fill(Color.appSurface2)
            RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.6)
            AppIcon("cube", size: 60)
                .foregroundStyle(ink.opacity(0.4))
                .shadow(color: .black.opacity(0.08), radius: 12, y: 6)
        }
    }
}

// MARK: - Assistant ask (conversational reply, in-shell — never a handoff to chat)

struct AssistantAskStepView: View {
    let text: String
    var ink: Color
    var isSending: Bool
    var onSend: (String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 10) {
                AppIcon("sparkles", size: 16)
                    .foregroundStyle(ink.opacity(0.5))
                Text(text)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { MissionGlassPlate() }

            HStack(spacing: 8) {
                TextField("Type your answer", text: $draft, axis: .vertical)
                    .font(.system(size: 15))
                    .foregroundStyle(ink)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(isSending)

                Button(action: send) {
                    if isSending {
                        ProgressView()
                            .tint(.white)
                            .frame(width: 30, height: 30)
                            .background(ink.opacity(0.5), in: Circle())
                    } else {
                        AppIcon("arrow-up", size: 14, weight: .bold)
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(ink, in: Circle())
                    }
                }
                .buttonStyle(.appScale(0.94))
                .disabled(isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.appSurface, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.6))
        }
    }

    private func send() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        HapticManager.shared.impact(.light)
        draft = ""
        focused = false
        onSend(trimmed)
    }
}

// MARK: - In progress

struct WorkingHeroStepView: View {
    let title: String
    let status: String
    var ink: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                    .tint(Color.appAccent)
                Text("In progress")
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.68))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.appDisplay(24, weight: .semibold))
                    .foregroundStyle(ink)
                Text(status)
                    .font(.appBody(15))
                    .foregroundStyle(ink.opacity(0.5))
                    .animation(.appFast, value: status)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background { MissionGlassPlate() }
    }
}

// MARK: - Activity

struct LiveStepsTraceView: View {
    let steps: [TaskStep]
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Activity")
                .font(.appBody(13, weight: .semibold))
                .foregroundStyle(ink.opacity(0.45))

            VStack(alignment: .leading, spacing: 8) {
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(ink.opacity(0.35))
                            .frame(width: 5, height: 5)
                            .padding(.top, 6)
                        Text(step.stepName)
                            .font(.system(size: 13))
                            .foregroundStyle(ink.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.top, 18)
    }
}

// MARK: - Session done

struct SessionDoneStepView: View {
    let title: String
    var ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AppIcon("check-circle", size: 30)
                .foregroundStyle(ink.opacity(0.8))
            Text(title)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(ink)
            Text("Added to Home.")
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.55))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }
}
