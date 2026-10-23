import SwiftUI

/// Shared navigation and title geometry for the app's detail surfaces.
struct ScreenHeaderView: View {
    let title: String
    /// Provide for pushed/presented screens; leave nil for tab roots (e.g. More).
    var onBack: (() -> Void)? = nil

    private let circle: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let onBack {
                // Raw chevron on its own line, so the title below lines up with the content.
                Button(action: onBack) {
                    AppIcon("chevron-left", size: 17)
                        .foregroundStyle(Color.appInk)
                        .frame(width: circle, height: circle, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("Back")
            }

            Text(title)
                .font(.pageTitle)
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, onBack == nil ? 8 : 0)
                .padding(.bottom, 20)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, minHeight: onBack == nil ? 64 : nil, alignment: .topLeading)
        .padding(.horizontal, AppSpacing.margin)
        .padding(.top, 2)
        // Opaque, and extended up through the status-bar inset, so scrolled content
        // can never ghost above or behind the header at the very top of the screen.
        .background(Color.appBackground.ignoresSafeArea(edges: .top))
    }
}

#Preview {
    VStack(spacing: 0) {
        ScreenHeaderView(title: "Profile", onBack: {})
        ScreenHeaderView(title: "More")
        Spacer()
    }
    .background(Color.appBackground)
}
