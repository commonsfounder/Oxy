import SwiftUI

struct ErrorBanner: View {
    let message: String
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Text(message)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.nmlDanger)
                .lineLimit(2)

            Spacer(minLength: 8)

            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.nmlBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.nmlTitanium)
                        // Pad the label to a ~40pt tap target without distorting the row.
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale)
            }

            if let onDismiss {
                Button(action: onDismiss) {
                    Text("Dismiss")
                        .font(.nmlBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.nmlMuted)
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.nmlScale)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color.nmlObsidian)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.nmlFillSubtle).frame(height: 0.5)
        }
    }
}

#Preview {
    ErrorBanner(message: "Network connection lost", onRetry: {}, onDismiss: {})
        .background(Color.nmlObsidian)
}
