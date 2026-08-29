import SwiftUI

struct LoadingIndicator: View {
    var label: String = "Loading…"
    var tint: Color = .appMuted

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            ProgressView()
                .tint(tint)
            Text(label)
                .font(.appBody(AppText.caption))
                .foregroundStyle(Color.appMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBackground)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct OxyThinkingIndicator: View {
    var label: String?
    var compact: Bool = false

    @State private var active = false

    var body: some View {
        HStack(spacing: compact ? 7 : 9) {
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.appHairline)
                    .frame(width: compact ? 22 : 28, height: 3)
                Capsule()
                    .fill(Color.appAccent.opacity(0.72))
                    .frame(width: compact ? 8 : 10, height: 3)
                    .offset(x: active ? (compact ? 14 : 18) : 0)
                    .animation(
                        .easeInOut(duration: 0.9)
                            .repeatForever(autoreverses: true),
                        value: active
                    )
            }
            if let label, !label.isEmpty {
                Text(label)
                    .font(.appBody(compact ? 12 : 13))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, label == nil ? 0 : (compact ? 0 : 2))
        .frame(minHeight: compact ? 18 : 24, alignment: .leading)
        .accessibilityLabel(label ?? "Thinking")
        .onAppear { active = true }
    }
}

/// A placeholder shaped like the thing it stands in for. It defaults to the card
/// radius, because a square block standing in for a 16pt-radius card is the moment
/// the loading state stops looking like the screen it precedes.
struct OxySkeletonCard: View {
    var height: CGFloat = 84
    var cornerRadius: CGFloat = AppRadius.card
    var base: Color = .appAdaptive(dark: .white, light: .black).opacity(0.03)
    var highlight: Color = .appAdaptive(dark: .white, light: .black).opacity(0.06)

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shimmer = false

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    var body: some View {
        shape
            .fill(base)
            .frame(height: height)
            .overlay {
                if !reduceMotion {
                    LinearGradient(
                        colors: [.clear, highlight, .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .rotationEffect(.degrees(8))
                    .offset(x: shimmer ? 260 : -260)
                }
            }
            .clipShape(shape)
            .onAppear { shimmer = true }
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 1.25).repeatForever(autoreverses: false),
                value: shimmer
            )
            .accessibilityHidden(true)
    }
}

/// The standard "this screen is loading" placeholder: cards at the same spacing
/// and margin the loaded screen uses, so nothing shifts sideways when it arrives.
struct AppSkeletonList: View {
    var heights: [CGFloat] = [92, 148, 148]
    var cornerRadius: CGFloat = AppRadius.card

    var body: some View {
        VStack(spacing: AppSpacing.md) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, height in
                OxySkeletonCard(height: height, cornerRadius: cornerRadius)
            }
        }
        .padding(.horizontal, AppSpacing.margin)
        .padding(.top, AppSpacing.lg)
        .accessibilityHidden(true)
    }
}

extension View {
    /// Crossfades a loading state into the content it precedes, instead of the
    /// content popping into place. Apply to both branches of the swap.
    func appLoadingSwap(_ isLoading: Bool) -> some View {
        transition(.opacity)
            .animation(.appStandard, value: isLoading)
    }
}

#Preview {
    VStack(spacing: 16) {
        LoadingIndicator()
        OxyThinkingIndicator()
        OxyThinkingIndicator(label: "Thinking")
    }
    .background(Color.appObsidian)
}
