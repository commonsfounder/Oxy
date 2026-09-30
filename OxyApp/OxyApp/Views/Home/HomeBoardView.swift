import SwiftUI

// MARK: - Home board

// MARK: - Live header

struct PulsingWorkDot: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var big = false

    var body: some View {
        ZStack {
            if !reduceMotion {
                Circle()
                    .fill(Color.appAccent.opacity(0.28))
                    .frame(width: 18, height: 18)
                    .scaleEffect(big ? 1.0 : 0.55)
                    .opacity(big ? 0.0 : 0.9)
            }
            Circle()
                .fill(Color.appAccent)
                .frame(width: 7, height: 7)
        }
        .frame(width: 18, height: 18)
        .onAppear {
            guard active, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.7).repeatForever(autoreverses: false)) {
                big = true
            }
        }
    }
}

// MARK: - Lane

// MARK: - Card

// MARK: - Progress

// MARK: - Relative time

extension Date {
    /// "4m", "2h", "yesterday" — a ledger needs the age of a row at a glance, not a date.
    var oxyRelativeShort: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        let days = Int(seconds / 86400)
        return days == 1 ? "yesterday" : "\(days)d"
    }
}
