import SwiftUI

struct OxySkeletonCard: View {
    var height: CGFloat = 84
    var cornerRadius: CGFloat = 0
    var base: Color = .appAdaptive(dark: .white, light: .black).opacity(0.03)
    var highlight: Color = .appAdaptive(dark: .white, light: .black).opacity(0.06)

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

