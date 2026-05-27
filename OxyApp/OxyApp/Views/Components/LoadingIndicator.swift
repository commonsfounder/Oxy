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

#Preview {
    VStack(spacing: 16) {
        LoadingIndicator()
        OxyThinkingIndicator()
        OxyThinkingIndicator(label: "Thinking")
    }
}
