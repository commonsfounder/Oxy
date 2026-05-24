import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedTab = Tab.chat

    enum Tab: String {
        case chat, history, connectors, memory, settings
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatView()
                .tabItem {
                    Image(systemName: "bubble.left.fill")
                    Text("Chat")
                }
                .tag(Tab.chat)

            HistoryView()
                .tabItem {
                    Image(systemName: "clock.fill")
                    Text("History")
                }
                .tag(Tab.history)

            ConnectorsView()
                .tabItem {
                    Image(systemName: "link")
                    Text("Connectors")
                }
                .tag(Tab.connectors)

            MemoryView()
                .tabItem {
                    Image(systemName: "brain.head.profile")
                    Text("Memory")
                }
                .tag(Tab.memory)

            SettingsView()
                .tabItem {
                    Image(systemName: "gearshape.fill")
                    Text("Settings")
                }
                .tag(Tab.settings)
        }
        .tint(Color.oxyStone)
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
