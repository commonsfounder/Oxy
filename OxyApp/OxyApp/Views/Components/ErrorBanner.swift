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
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)

            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }

            if let onRetry {
                Button(action: onRetry) {
                    Text("Try again")
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appOnAction)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Color.appAction))
                        .contentShape(Capsule())
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
        .background(Color.settingsRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
    }
}

#Preview {
    ErrorBanner(message: "Network connection lost", onRetry: {}, onDismiss: {})
        .background(Color.appObsidian)
}
