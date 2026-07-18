import SwiftUI

// MARK: - Generated-for-the-job step content (real-data native buy flow)
//
// Each case swaps the whole body of AgentTaskSessionView. Shared shell (title,
// glass plates) lives here; every field on a step comes from the real backend
// pipeline chat already uses — see Models/AgentTaskSession.swift.

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

// MARK: - Payment confirm (trust surface)

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

            Text("You can cancel any time before this is charged.")
                .font(.system(size: 12))
                .foregroundStyle(ink.opacity(0.4))
                .padding(.top, 12)
        }
    }
}

// MARK: - Product detail (buy job — real backend data)

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
                    Text("PRICE")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(ink.opacity(0.45))
                    Text(priceText)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(ink)
                }
            }

            heroImage

            if !details.colorOptions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("OPTIONS")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
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
                                            Capsule().fill(.ultraThinMaterial)
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

    // Real photo (og:image, or the largest visible <img> the browser-task agent
    // found) when present — same fade-in AsyncImage pattern as chat's product image
    // row. Falls back to an honest placeholder plate only when there's genuinely no
    // photo, never a stand-in picture for a specific item.
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
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.7), lineWidth: 0.7)
            )
            .shadow(color: .black.opacity(0.06), radius: 16, y: 8)
        } else {
            placeholderPlate
                .frame(height: 190)
                .frame(maxWidth: .infinity)
                .shadow(color: .black.opacity(0.06), radius: 16, y: 8)
        }
    }

    private var placeholderPlate: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.white.opacity(0.45))
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.white.opacity(0.7), lineWidth: 0.7)
            AppIcon("cube", size: 60)
                .foregroundStyle(ink.opacity(0.4))
                .shadow(color: .black.opacity(0.08), radius: 12, y: 6)
        }
    }
}

// MARK: - Working hero (holographic search)

struct WorkingHeroStepView: View {
    let title: String
    let status: String
    var ink: Color
    @State private var pulse = false
    @State private var rotation: Double = 0

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 40)

            ZStack {
                // Radar rings
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .strokeBorder(
                            AngularGradient(
                                colors: [
                                    Color(red: 0.7, green: 0.85, blue: 1.0).opacity(0.0),
                                    Color(red: 0.6, green: 0.8, blue: 1.0).opacity(0.45),
                                    Color(red: 1.0, green: 0.85, blue: 0.7).opacity(0.25),
                                    Color(red: 0.7, green: 0.85, blue: 1.0).opacity(0.0)
                                ],
                                center: .center
                            ),
                            lineWidth: 1.2
                        )
                        .frame(width: CGFloat(150 + i * 44), height: CGFloat(150 + i * 44))
                        .scaleEffect(pulse ? 1.04 : 0.96)
                        .opacity(pulse ? 0.9 : 0.55)
                        .rotationEffect(.degrees(rotation + Double(i * 20)))
                }

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(red: 0.75, green: 0.88, blue: 1.0).opacity(0.55),
                                Color(red: 1.0, green: 0.9, blue: 0.8).opacity(0.25),
                                .clear
                            ],
                            center: .center,
                            startRadius: 6,
                            endRadius: 90
                        )
                    )
                    .frame(width: 150, height: 150)
                    .scaleEffect(pulse ? 1.02 : 0.98)
            }
            .frame(height: 240)
            .onAppear {
                withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) {
                    pulse = true
                }
                withAnimation(.linear(duration: 12).repeatForever(autoreverses: false)) {
                    rotation = 360
                }
            }

            VStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(ink)
                Text(status)
                    .font(.system(size: 14))
                    .foregroundStyle(ink.opacity(0.5))
                    .animation(.appFast, value: status)
            }

            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity)
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
            Text("All set — this will land on Home as a status card.")
                .font(.system(size: 14))
                .foregroundStyle(ink.opacity(0.55))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }
}
