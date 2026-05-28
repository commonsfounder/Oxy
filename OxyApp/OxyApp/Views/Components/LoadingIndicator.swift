import SwiftUI

struct LoadingIndicator: View {
    var label: String = "Loading..."
    var tint: Color = .oxyStone

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(tint)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Color.oxySub)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.oxyBg)
    }
}

struct OxyThinkingIndicator: View {
    var label: String?
    var compact: Bool = false

    @State private var active = false

    var body: some View {
        HStack(spacing: compact ? 8 : 10) {
            ZStack {
                Circle()
                    .fill(Color.oxyStone.opacity(active ? 0.18 : 0.08))
                    .frame(width: compact ? 20 : 24, height: compact ? 20 : 24)
                    .scaleEffect(active ? 1.06 : 0.92)
                Image(systemName: "sparkle")
                    .font(.system(size: compact ? 9 : 11, weight: .bold))
                    .foregroundStyle(Color.oxyStone)
                    .rotationEffect(.degrees(active ? 8 : -8))
            }
            .animation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true), value: active)

            if let label, !label.isEmpty {
                Text(label)
                    .font(.system(size: compact ? 12 : 13, weight: .semibold))
                    .foregroundStyle(Color.oxySub)
                    .lineLimit(1)
            }
        }
        .accessibilityLabel(label ?? "Oxy is thinking")
        .onAppear { active = true }
    }
}

struct OxySkeletonCard: View {
    var height: CGFloat = 84
    var cornerRadius: CGFloat = 16

    @State private var shimmer = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(Color.oxySurface2)
            .frame(height: height)
            .overlay(
                LinearGradient(
                    colors: [
                        .clear,
                        Color.white.opacity(0.10),
                        .clear
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .rotationEffect(.degrees(8))
                .offset(x: shimmer ? 260 : -260)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
            .onAppear { shimmer = true }
            .animation(.easeInOut(duration: 1.25).repeatForever(autoreverses: false), value: shimmer)
            .accessibilityHidden(true)
    }
}

#Preview {
    VStack(spacing: 16) {
        LoadingIndicator()
        OxyThinkingIndicator()
        OxyThinkingIndicator(label: "Thinking")
    }
}
