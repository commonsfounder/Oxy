import SwiftUI

struct LoadingIndicator: View {
    var label: String = "Loading…"
    var tint: Color = .appTitanium

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(tint)
            Text(label)
                .font(.system(size: 12, weight: .light))
                .foregroundStyle(Color.appMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appObsidian)
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

struct OxySkeletonCard: View {
    var height: CGFloat = 84
    var cornerRadius: CGFloat = 0
    // Light-mode dashboards need a dark-on-light skeleton; default stays dark-on-dark.
    var base: Color = .white.opacity(0.03)
    var highlight: Color = .white.opacity(0.06)

    @State private var shimmer = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(base)
            .frame(height: height)
            .overlay(
                LinearGradient(
                    colors: [.clear, highlight, .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .rotationEffect(.degrees(8))
                .offset(x: shimmer ? 260 : -260)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
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
    .background(Color.appObsidian)
}
