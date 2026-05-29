import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @State private var selectedTab = Tab.chat

    enum Tab: String {
        case chat, proactive, history, connectors, settings
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatView()
                .tabItem {
                    Image(systemName: "bubble.left.fill")
                    Text("Chat")
                }
                .tag(Tab.chat)

            ProactiveView()
                .tabItem {
                    Image(systemName: "sparkles")
                    Text("Today")
                }
                .tag(Tab.proactive)

            HistoryView()
                .tabItem {
                    Image(systemName: "clock.fill")
                    Text("Chats")
                }
                .tag(Tab.history)

            ConnectorsView()
                .tabItem {
                    Image(systemName: "link")
                    Text("Connectors")
                }
                .tag(Tab.connectors)

            SettingsView()
                .tabItem {
                    Image(systemName: "gearshape.fill")
                    Text("Settings")
                }
                .tag(Tab.settings)
        }
        .tint(Color.oxyStone)
        .id(accentColor)
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToChat)) { _ in
            withAnimation { selectedTab = .chat }
        }
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
