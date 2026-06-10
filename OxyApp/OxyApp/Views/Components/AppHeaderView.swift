import SwiftUI

/// Silent-luxury top header: pure black, no nav-bar chrome. A left-aligned
/// monospace system tag (opens history) and a right-aligned "ghost" incognito
/// toggle — naked text that gains a 0.5px white border + faint fill when active.
struct AppHeaderView: View {
    @Binding var isIncognito: Bool
    /// Invoked when the left system tag is tapped (e.g. open history/sidebar).
    var onLeading: () -> Void = {}

    private let muted = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255) // #8E8E93

    var body: some View {
        HStack {
            // Top Left: minimalist monospace telemetry tag
            Button(action: onLeading) {
                Text("NAMELESS.SYS")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundColor(muted)
                    .tracking(1.5)
            }
            .buttonStyle(.plain)

            Spacer()

            // Top Right: ghost button for incognito (shadow) chat
            Button(action: {
                withAnimation(.linear(duration: 0.15)) { isIncognito.toggle() }
            }) {
                Text(isIncognito ? "SHADOW_ACTIVE" : "SHADOW_CHAT")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(isIncognito ? .white : muted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(isIncognito ? Color.white.opacity(0.10) : Color.clear)
                    .border(isIncognito ? Color.white.opacity(0.3) : Color.clear, width: 0.5)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color.black)
    }
}

#Preview {
    VStack(spacing: 0) {
        AppHeaderView(isIncognito: .constant(false))
        AppHeaderView(isIncognito: .constant(true))
        Spacer()
    }
    .background(Color.black)
}
