import SwiftUI

struct ErrorBanner: View {
    let message: String
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            AppIcon("wifi-alert", size: 14)
                .foregroundStyle(Color.appMuted)

            Text(message)
                .font(Font.appBody(13))
                .foregroundStyle(Color.appMuted)
                .lineLimit(2)

            Spacer(minLength: 8)

            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.appBody(12, weight: .semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.appAccent)
                        // Pad the label to a ~40pt tap target without distorting the row.
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }

            if let onDismiss {
                Button(action: onDismiss) {
                    AppIcon("xmark", size: 12)
                        .foregroundStyle(Color.appMuted)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
        .padding(.horizontal, 12)
    }
}

#Preview {
    ErrorBanner(message: "Network connection lost", onRetry: {}, onDismiss: {})
        .background(Color.appObsidian)
}
