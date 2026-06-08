import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var selectedTab = Tab.today

    enum Tab: String, CaseIterable {
        case chat, today, more
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatHomeView()
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
        .id(accentColor + appTheme)
        .gesture(
            DragGesture(minimumDistance: 32)
                .onEnded(handleSwipe)
        )
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

    private func handleSwipe(_ value: DragGesture.Value) {
        let horizontal = value.translation.width
        let vertical = value.translation.height
        guard abs(horizontal) > 64, abs(horizontal) > abs(vertical) * 1.8 else { return }
        guard let index = Tab.allCases.firstIndex(of: selectedTab) else { return }
        let nextIndex = horizontal < 0 ? index + 1 : index - 1
        guard Tab.allCases.indices.contains(nextIndex) else { return }
        withAnimation(.easeOut(duration: 0.25)) {
            selectedTab = Tab.allCases[nextIndex]
        }
    }
}

// MARK: - More View

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: MoreDestination?

    enum MoreDestination: Identifiable {
        case connectors, memory, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 36) {
                        moreSection(title: "Workspace") {
                            moreRow(title: "Connectors", subtitle: "Link your accounts and devices") {
                                destination = .connectors
                            }
                            NamelessDivider()
                            moreRow(title: "Memory", subtitle: "What Nameless remembers about you") {
                                destination = .memory
                            }
                        }

                        moreSection(title: "App") {
                            moreRow(title: "Settings", subtitle: "Appearance, voice, account") {
                                destination = .settings
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .fullScreenCover(item: $destination) { dest in
                switch dest {
                case .connectors: ConnectorsView()
                case .memory: MemoryView()
                case .settings: SettingsView()
                }
            }
        }
    }

    private func moreSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: title)
                .padding(.bottom, 10)
            VStack(spacing: 0, content: content)
        }
    }

    private func moreRow(title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Text(subtitle)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .lineLimit(1)
                }
                Spacer()
                Text("›")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
