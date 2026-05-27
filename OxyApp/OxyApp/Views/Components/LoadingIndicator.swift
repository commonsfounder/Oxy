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

    private let low: [CGFloat] = [10, 16, 12, 18]
    private let high: [CGFloat] = [18, 10, 20, 12]

    var body: some View {
        HStack(spacing: compact ? 8 : 10) {
            HStack(alignment: .center, spacing: 4) {
                ForEach(0..<4, id: \.self) { index in
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.oxyStone.opacity(0.45),
                                    Color.oxyStone,
                                    Color.oxyStone.opacity(0.72)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .frame(width: compact ? 3 : 4, height: active ? high[index] : low[index])
                        .shadow(color: Color.oxyStone.opacity(active ? 0.25 : 0.08), radius: active ? 7 : 2)
                        .animation(
                            .easeInOut(duration: 0.58)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.09),
                            value: active
                        )
                }
            }
            .frame(width: compact ? 26 : 32, height: compact ? 20 : 26)
            .padding(.horizontal, compact ? 7 : 9)
            .padding(.vertical, compact ? 5 : 6)
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
