import SwiftUI

/// Silent-luxury screen header that matches the chat screen's `AppHeaderView`:
/// pure black, no system nav-bar chrome. A title on the left and, when a back
/// action is provided, a soft circular Liquid Glass chevron beside it. Used by
/// the More-tab sub-screens (Profile, Pendant, Memory, Connectors, Settings) and
/// the More root so they no longer show chunky `.large` system title bars.
struct ScreenHeaderView: View {
    let title: String
    /// Provide for pushed/presented screens; leave nil for tab roots (e.g. More).
    var onBack: (() -> Void)? = nil

    private let circle: CGFloat = 38

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
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .padding(.top, onBack == nil ? 8 : 0)
                .padding(.bottom, 8)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
