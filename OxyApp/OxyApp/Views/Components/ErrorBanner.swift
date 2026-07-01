import SwiftUI

struct ErrorBanner: View {
    let message: String
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Text(message)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.appDanger)
                .lineLimit(2)

            Spacer(minLength: 8)

            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.appBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.appTitanium)
                        // Pad the label to a ~40pt tap target without distorting the row.
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }

            if let onDismiss {
                Button(action: onDismiss) {
                    Text("Dismiss")
                        .font(.appBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.appMuted)
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color.appObsidian)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.appFillSubtle).frame(height: 0.5)
        }
    }
}

#Preview {
    ErrorBanner(message: "Network connection lost", onRetry: {}, onDismiss: {})
        .background(Color.appObsidian)
}
