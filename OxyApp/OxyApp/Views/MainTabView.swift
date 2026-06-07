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
                Color.oxyBg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        moreSection(title: "Workspace") {
                            moreRow(icon: "app.connected.to.app.below.fill", title: "Connectors", subtitle: "Link your accounts and devices", color: .oxyStone) {
                                destination = .connectors
                            }
                            Divider().overlay(Color.oxyLine).padding(.leading, 58)
                            moreRow(icon: "brain.head.profile", title: "Memory", subtitle: "What Oxy remembers about you", color: .purple) {
                                destination = .memory
                            }
                        }

                        moreSection(title: "App") {
                            moreRow(icon: "gearshape.fill", title: "Settings", subtitle: "Appearance, voice, account", color: .oxySub) {
                                destination = .settings
                            }
                        }
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
                case .connectors: ConnectorsView()
                case .memory: MemoryView()
                case .settings: SettingsView()
                }
            }
        }
    }

    private func moreSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)
                .padding(.leading, 4)

            VStack(spacing: 0, content: content)
                .background(Color.oxySurface2)
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    private func moreRow(icon: String, title: String, subtitle: String, color: Color, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(color)
                    .frame(width: 32, height: 32)
                    .background(color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Color.oxyText)
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxyDim)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyDim)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
