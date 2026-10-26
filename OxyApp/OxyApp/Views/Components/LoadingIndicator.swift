import SwiftUI

struct OxySkeletonCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var height: CGFloat = 84
    var cornerRadius: CGFloat = 12
    var base: Color = .appFillSubtle
    var highlight: Color = .appAdaptive(dark: .white, light: .black).opacity(0.06)

    @State private var shimmer = false

    private var motionReduced: Bool {
        #if DEBUG
        if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_REDUCE_MOTION"] == "1" { return true }
        #endif
        return reduceMotion
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(base)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay {
                if !motionReduced {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, highlight, .clear], startPoint: .leading, endPoint: .trailing)
                            .offset(x: shimmer ? proxy.size.width : -proxy.size.width)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .onAppear { shimmer = !motionReduced }
            .onChange(of: reduceMotion) { _, _ in shimmer = !motionReduced }
            .animation(motionReduced ? nil : .linear(duration: 1.25).repeatForever(autoreverses: false), value: shimmer)
            .accessibilityHidden(true)
    }
}
