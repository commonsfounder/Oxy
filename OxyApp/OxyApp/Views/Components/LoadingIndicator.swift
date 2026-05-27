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
            HStack(spacing: compact ? 4 : 5) {
                ForEach(0..<3, id: \.self) { index in
                    Capsule()
                        .fill(Color.oxyStone)
                        .frame(width: active ? (compact ? 13 : 15) : (compact ? 7 : 8), height: compact ? 7 : 8)
                        .opacity(active ? 0.95 : 0.42)
                        .scaleEffect(active ? 1 : 0.82)
                        .shadow(color: Color.oxyStone.opacity(active ? 0.22 : 0.04), radius: active ? 7 : 1)
                        .animation(
                            .easeInOut(duration: 0.62)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.13),
                            value: active
                        )
                }
            }
            .frame(width: compact ? 42 : 50, height: compact ? 18 : 22)
            .padding(.horizontal, compact ? 3 : 4)
            .padding(.vertical, compact ? 4 : 5)
            .background(
                Capsule()
                    .fill(Color.oxyStone.opacity(0.12))
                    .overlay(
                        Capsule()
                            .stroke(Color.oxyStone.opacity(0.22), lineWidth: 1)
                    )
            )

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
