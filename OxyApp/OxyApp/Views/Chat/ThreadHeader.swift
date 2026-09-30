import SwiftUI

/// The top of the thread: a contact header like Messages, with the menu on the left.
struct ThreadHeader: View {
    @Binding var isIncognito: Bool
    var isEmptyChat: Bool
    var isWorking: Bool
    var onMenu: () -> Void

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
                if isWorking {
                    Text("Working")
                        .font(.appBody(11))
                        .foregroundStyle(Color.appWorking)
                        .transition(.opacity)
                }
            }
            .animation(.appStandard, value: isWorking)
            .accessibilityElement(children: .combine)

            HStack {
                Button(action: onMenu) {
                    AppIcon("menu", size: 18)
                        .foregroundColor(Color.appInk.opacity(0.85))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("Menu")
                Spacer()
                if isEmptyChat || isIncognito {
                    Button {
                        withAnimation(.linear(duration: 0.15)) { isIncognito.toggle() }
                    } label: {
                        GhostIcon(active: isIncognito)
                            .frame(width: 18, height: 18)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel(isIncognito ? "Private chat on" : "Private chat off")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
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
