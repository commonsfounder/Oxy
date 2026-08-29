import SwiftUI

struct ErrorBanner: View {
    let message: String
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            AppIcon("wifi-alert", size: AppGlyphSize.regular)
                .foregroundStyle(Color.appMuted)

            Text(message)
                .font(Font.appBody(AppText.footnote))
                .foregroundStyle(Color.appMuted)
                .lineLimit(2)

            Spacer(minLength: 8)

            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.appBody(AppText.caption, weight: .semibold))
                        .foregroundStyle(Color.appAccent)
                        // Pad the label to a ~40pt tap target without distorting the row.
                        .padding(.vertical, 12)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }

            if let onDismiss {
                AppIconButton("xmark", label: "Dismiss", size: .small, action: onDismiss)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: AppBorder.hairline)
        )
        .padding(.horizontal, 12)
    }
}

#Preview {
    ErrorBanner(message: "Network connection lost", onRetry: {}, onDismiss: {})
        .background(Color.appObsidian)
}
