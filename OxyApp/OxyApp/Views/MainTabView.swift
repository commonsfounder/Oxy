import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var selectedTab = Tab.today

    enum Tab: String {
        case today, chat, more
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ProactiveView()
                .tabItem {
                    Image(systemName: selectedTab == .today ? "sun.max.fill" : "sun.max")
                    Text("Today")
                }
                .tag(Tab.today)

            ConversationsView()
                .tabItem {
                    Image(systemName: selectedTab == .chat ? "bubble.left.fill" : "bubble.left")
                    Text("Chat")
                }
                .tag(Tab.chat)

            MoreView()
                .tabItem {
                    Image(systemName: selectedTab == .more ? "square.grid.2x2.fill" : "square.grid.2x2")
                    Text("More")
                }
                .tag(Tab.more)
        }
        .tint(Color.oxyStone)
        .id(accentColor + appTheme)
        .onChange(of: selectedTab) { _, _ in
            HapticManager.shared.select()
        }
        .onAppear { HapticManager.shared.prepare() }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToChat)) { _ in
            withAnimation { selectedTab = .chat }
        }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToMore)) { _ in
            withAnimation { selectedTab = .more }
        }
    }
}

// MARK: - More View

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: MoreDestination?

    enum MoreDestination: Identifiable {
        case connectors, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 0) {
                        moreRow(icon: "link", title: "Connectors", color: .oxyStone, isFirst: true, isLast: false) {
                            destination = .connectors
                        }
                        Divider().overlay(Color.oxyLine).padding(.leading, 58)
                        moreRow(icon: "gearshape.fill", title: "Settings", color: .oxySub, isFirst: false, isLast: true) {
                            destination = .settings
                        }
                    }
                    .background(Color.oxySurface2)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .padding(16)
                }
            }
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .fullScreenCover(item: $destination) { dest in
                switch dest {
                case .connectors: ConnectorsView()
                case .settings: SettingsView()
                }
            }
        }
    }

    private func moreRow(icon: String, title: String, color: Color, isFirst: Bool, isLast: Bool, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                Text(title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyDim)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
