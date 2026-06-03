import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @State private var selectedTab = Tab.chat

    enum Tab: String {
        case chat, today, more
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatView()
                .tabItem {
                    Image(systemName: selectedTab == .chat ? "bubble.left.fill" : "bubble.left")
                    Text("Chat")
                }
                .tag(Tab.chat)

            ProactiveView()
                .tabItem {
                    Image(systemName: selectedTab == .today ? "sun.max.fill" : "sun.max")
                    Text("Today")
                }
                .tag(Tab.today)

            MoreView()
                .tabItem {
                    Image(systemName: selectedTab == .more ? "square.grid.2x2.fill" : "square.grid.2x2")
                    Text("More")
                }
                .tag(Tab.more)
        }
        .tint(Color.oxyStone)
        .id(accentColor)
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToChat)) { _ in
            withAnimation { selectedTab = .chat }
        }
    }
}

// MARK: - More View (consolidates History, Connectors, Settings)

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: MoreDestination?
    @State private var appeared = false

    enum MoreDestination: Identifiable {
        case history, connectors, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 8) {
                        moreSection {
                            Button { destination = .history } label: {
                                moreRow(icon: "clock.fill", title: "Chats", color: .oxySub)
                            }

                            Button { destination = .connectors } label: {
                                moreRow(icon: "link", title: "Connectors", color: .oxyStone)
                            }
                        }
                        .opacity(appeared ? 1 : 0)
                        .offset(y: appeared ? 0 : 12)

                        moreSection {
                            Button { destination = .settings } label: {
                                moreRow(icon: "gearshape.fill", title: "Settings", color: .oxySub)
                            }
                        }
                        .opacity(appeared ? 1 : 0)
                        .offset(y: appeared ? 0 : 12)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .fullScreenCover(item: $destination) { dest in
                switch dest {
                case .history: HistoryView()
                case .connectors: ConnectorsView()
                case .settings: SettingsView()
                }
            }
            .onAppear {
                withAnimation(.spring(response: 0.5, dampingFraction: 0.8).delay(0.1)) {
                    appeared = true
                }
            }
        }
    }

    private func moreSection<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content()
        }
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func moreRow(icon: String, title: String, color: Color) -> some View {
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
}

#Preview {
    MainTabView()
        .environment(AppState())
}
