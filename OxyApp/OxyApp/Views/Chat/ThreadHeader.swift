import SwiftUI

/// Navigation has its own space, clear of the conversation.
struct ThreadHeader: View {
    var isIncognito: Bool
    var isWorking: Bool
    var activity: AdamActivityState? = nil
    var deviceOnline: Bool
    var isDemo = false
    var isComposing = false
    var showsStatus = true
    /// Set while in the conversation: the way back to Home.
    var onHome: (() -> Void)? = nil
    @Environment(\.dynamicTypeSize) private var typeSize
    @Binding var wheelOpen: Bool
    @Binding var hubCenter: CGPoint

    var body: some View {
        let titleLayout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        HStack(spacing: 12) {
            if let onHome {
                Button {
                    HapticManager.shared.impact(.light)
                    onHome()
                } label: {
                    HStack(spacing: AppSpacing.xs) {
                        AppIcon("chevron-left", size: 15)
                        Text("Home").font(.role(.body, weight: .semibold))
                    }
                    .foregroundStyle(Color.appAccent)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("Back to Home")
            } else {
                titleLayout {
                    Text(isIncognito ? "Private" : "Adam")
                        .font(.role(.body, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    if isDemo {
                        Text("Sample")
                            .font(.role(.caption, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                }
            }
            Spacer(minLength: 8)
            Button {
                HapticManager.shared.impact(.light)
                wheelOpen = true
            } label: {
                HStack(spacing: 8) {
                    if !typeSize.isAccessibilitySize {
                        Text("Menu")
                            .font(.role(.footnote, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                    WheelHub(progress: 0, incognito: isIncognito)
                        .overlay(alignment: .topTrailing) { statusDot }
                        .onGeometryChange(for: CGPoint.self) { proxy in
                            let frame = proxy.frame(in: .global)
                            return CGPoint(x: frame.midX, y: frame.midY)
                        } action: { hubCenter = $0 }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale)
            .opacity(wheelOpen ? 0 : 1)
            .accessibilityLabel("Menu")
            .accessibilityValue(isIncognito ? "Private mode on" : (visibleStatus ?? ""))
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .padding(.horizontal, AppSpacing.chatMargin)
        .padding(.vertical, 8)
        .frame(minHeight: 60)
        .background(Color.appBackground.ignoresSafeArea(edges: .top))
        .animation(.appStandard, value: activity)
        .animation(.appStandard, value: deviceOnline)
    }

    @ViewBuilder
    private var statusDot: some View {
        if activity != nil || deviceOnline {
            Circle().fill(activity == .waiting ? Color.appNeedsYou : (activity != nil ? Color.appWorking : Color.appDone))
                .frame(width: 9, height: 9)
                .overlay(Circle().strokeBorder(Color.appBackground, lineWidth: 2))
        }
    }

    private var visibleStatus: String? {
        if isIncognito { return "Not saved" }
        switch activity {
        case .listening: return "Listening"
        case .waiting: return "Needs you"
        case .working: return "Working"
        case nil: return nil
        }
    }
}
