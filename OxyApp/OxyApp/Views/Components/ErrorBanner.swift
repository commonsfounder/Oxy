import SwiftUI

struct ErrorBanner: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let message: String
    var onRetry: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(spacing: 10))
        layout {
            AppIcon("wifi-alert", size: 14)
                .foregroundStyle(Color.appMuted)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)

            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }

            if let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(.subheadline.weight(.semibold))
                        .tracking(0.3)
                        .foregroundStyle(Color.appAccent)
                        .padding(.vertical, 11)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }

            if let onDismiss {
                Button(action: onDismiss) {
                    AppIcon("xmark", size: 12)
                        .foregroundStyle(Color.appMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("Dismiss error")
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
