import SwiftUI

struct LoadingIndicator: View {
    var label: String = "Loading…"
    var tint: Color = .nmlTitanium

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(tint)
            Text(label)
                .font(.system(size: 12, weight: .light))
                .foregroundStyle(Color.nmlMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }
}

struct OxyThinkingIndicator: View {
    var label: String?
    var compact: Bool = false

    @State private var active = false

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.nmlMuted)
                    .frame(width: 5, height: 5)
                    .opacity(active ? 1 : 0.3)
                    .animation(
                        .easeInOut(duration: 0.7)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: active
                    )
            }
            if let label, !label.isEmpty {
                Text(label)
                    .font(.system(size: compact ? 12 : 13, weight: .regular))
                    .foregroundStyle(Color.nmlMuted)
                    .lineLimit(1)
                    .padding(.leading, 4)
            }
        }
        .accessibilityLabel(label ?? "Thinking")
        .onAppear { active = true }
    }
}

struct OxySkeletonCard: View {
    var height: CGFloat = 84
    var cornerRadius: CGFloat = 16

    @State private var shimmer = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(Color.white.opacity(0.03))
            .frame(height: height)
            .overlay(
                LinearGradient(
                    colors: [.clear, Color.white.opacity(0.06), .clear],
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
    .background(Color.black)
}
