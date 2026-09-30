import SwiftUI

/// The top of the thread: a contact header like Messages. On the right, one button holds the whole menu.
struct ThreadHeader: View {
    var isIncognito: Bool
    var isWorking: Bool
    @Binding var wheelOpen: Bool
    @Binding var hubCenter: CGPoint

    var body: some View {
        ZStack {
            VStack(spacing: 3) {
                Circle()
                    .fill(Color.appReceivedBubble)
                    .frame(width: 38, height: 38)
                    .overlay(AdamMark().frame(width: 22, height: 16))
                Text("Adam")
                    .font(.appBody(12, weight: .medium))
                    .foregroundStyle(Color.appInk)
                if isIncognito {
                    Text("Private")
                        .font(.appBody(11))
                        .foregroundStyle(Color.appMuted)
                } else if isWorking {
                    Text("Working")
                        .font(.appBody(11))
                        .foregroundStyle(Color.appWorking)
                }
            }
            .animation(.appStandard, value: isWorking)
            .animation(.appStandard, value: isIncognito)
            .accessibilityElement(children: .combine)

            HStack {
                Spacer()
                Button {
                    HapticManager.shared.impact(.light)
                    wheelOpen = true
                } label: {
                    WheelHub(progress: 0, incognito: isIncognito)
                }
                .buttonStyle(.appScale)
                .opacity(wheelOpen ? 0 : 1)
                .onGeometryChange(for: CGPoint.self) { proxy in
                    let frame = proxy.frame(in: .global)
                    return CGPoint(x: frame.midX, y: frame.midY)
                } action: { hubCenter = $0 }
                .accessibilityLabel("Menu")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(Color.appBackground)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.appHairline).frame(height: 0.5)
        }
    }
}
