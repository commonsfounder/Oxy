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
        nmlGlassContainer(spacing: 16) {
            HStack(spacing: 10) {
                if let onBack {
                    Button(action: onBack) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.white.opacity(0.85))
                            .frame(width: circle, height: circle)
                            .nmlGlass(Circle(), interactive: true)
                    }
                    .buttonStyle(.nmlScale)
                    .accessibilityLabel("Back")
                }

                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.nmlInk)

                Spacer()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // Opaque, and extended up through the status-bar inset, so scrolled content
        // can never ghost above or behind the header at the very top of the screen.
        .background(Color.nmlObsidian.ignoresSafeArea(edges: .top))
    }
}

#Preview {
    VStack(spacing: 0) {
        ScreenHeaderView(title: "Profile", onBack: {})
        ScreenHeaderView(title: "More")
        Spacer()
    }
    .background(Color.nmlObsidian)
}
