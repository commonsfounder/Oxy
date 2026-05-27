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
        HStack(spacing: compact ? 7 : 9) {
            Image(systemName: "sparkles")
                .font(.system(size: compact ? 13 : 15, weight: .semibold))
                .foregroundStyle(Color.oxyStone)
                .opacity(active ? 1 : 0.45)
                .scaleEffect(active ? 1.08 : 0.92)
                .shadow(color: Color.oxyStone.opacity(active ? 0.22 : 0.04), radius: active ? 8 : 1)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: active)

            if let label, !label.isEmpty {
                Text(label)
                    .font(.system(size: compact ? 12 : 13, weight: .medium))
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
