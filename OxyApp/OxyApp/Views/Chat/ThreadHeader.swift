import SwiftUI

/// Navigation has its own space, clear of the conversation.
struct ThreadHeader: View {
    var isIncognito: Bool
    var isWorking: Bool
    var activity: AdamActivityState? = nil
    var deviceOnline: Bool
    var isDemo = false
    @Binding var wheelOpen: Bool
    @Binding var hubCenter: CGPoint

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(isIncognito ? "Private" : "Adam")
                        .font(.appRounded(28, relativeTo: .title2))
                        .foregroundStyle(Color.appInk)
                    if isDemo {
                        Text("Sample")
                            .font(.appBody(12, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                }
                if let status = visibleStatus {
                    Text(status)
                        .font(.appBody(13, weight: .medium))
                        .foregroundStyle(activity == .waiting ? Color.appNeedsYou : Color.appMuted)
                }
            }
            Spacer(minLength: 8)
            Button {
                HapticManager.shared.impact(.light)
                wheelOpen = true
            } label: {
                HStack(spacing: 8) {
                    Text("Menu")
                        .font(.appBody(14, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                    WheelHub(progress: 0, incognito: isIncognito, activity: activity)
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
        .padding(.horizontal, AppSpacing.chatMargin)
        .padding(.vertical, 12)
        .frame(minHeight: 72)
        .background(Color.appBackground.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.appHairline).frame(height: 0.5)
        }
        .animation(.appStandard, value: activity)
        .animation(.appStandard, value: deviceOnline)
    }

    @ViewBuilder
    private var statusDot: some View {
        if !isWorking && deviceOnline {
            Circle().fill(Color.appDone)
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
