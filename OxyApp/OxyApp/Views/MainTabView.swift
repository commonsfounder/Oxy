import SwiftUI
import UIKit

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var selectedTab = Tab.today
    @State private var todaySunPulse = 0

    enum Tab: String, CaseIterable {
        case chat, today, more
    }

    init() {
        MainTabView.applyNamelessTabBarAppearance()
    }

    /// Keeps the translucent "glass" blur but pulls the bar into the Nameless
    /// palette: a deep obsidian tint over the blur, a 0.5px titanium hairline on
    /// top, soft-white selected items and muted-grey unselected ones — no warm
    /// accent colour.
    private static func applyNamelessTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground() // retain the system blur
        appearance.backgroundEffect = UIBlurEffect(style: .systemChromeMaterialDark)
        appearance.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        appearance.shadowColor = UIColor(white: 0.82, alpha: 0.16) // titanium hairline

        let muted = UIColor(white: 0.56, alpha: 1.0)
        let selected = UIColor(red: 240 / 255, green: 239 / 255, blue: 235 / 255, alpha: 1.0)

        for layout in [appearance.stackedLayoutAppearance,
                       appearance.inlineLayoutAppearance,
                       appearance.compactInlineLayoutAppearance] {
            layout.normal.iconColor = muted
            layout.normal.titleTextAttributes = [
                .font: UIFont.systemFont(ofSize: 10, weight: .medium),
                .foregroundColor: muted
            ]
            layout.selected.iconColor = selected
            layout.selected.titleTextAttributes = [
                .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: selected
            ]
        }

        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
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
                    Image(systemName: selectedTab == .today ? "sunrise.fill" : "sunrise")
                        .symbolEffect(.bounce, value: todaySunPulse)
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
        .tint(Color.nmlInk)
        .id(accentColor + appTheme)
        .gesture(
            DragGesture(minimumDistance: 32)
                .onEnded(handleSwipe)
        )
        .onChange(of: selectedTab) { _, newValue in
            HapticManager.shared.select()
            if newValue == .today { todaySunPulse += 1 }
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
    @State private var showSignOutConfirm = false

    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 0) {
                        moreRow(title: "Profile", subtitle: "Your account and assistant name") {
                            destination = .profile
                        }
                        NamelessDivider()
                        moreRow(title: "Pendant", subtitle: "Device status and pairing") {
                            destination = .pendant
                        }
                        NamelessDivider()
                        moreRow(title: "Connectors", subtitle: "Link your accounts and devices") {
                            destination = .connectors
                        }
                        NamelessDivider()
                        moreRow(title: "Memory", subtitle: "What Nameless remembers about you") {
                            destination = .memory
                        }
                        NamelessDivider()
                        moreRow(title: "Settings", subtitle: "Appearance, voice, account") {
                            destination = .settings
                        }

                        // Sign out lives apart, low-contrast, with breathing room.
                        signOutRow
                            .padding(.top, 56)
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .fullScreenCover(item: $destination) { dest in
                switch dest {
                case .profile: ProfileView()
                case .pendant: PendantStatusView()
                case .connectors: ConnectorsView()
                case .memory: MemoryView()
                case .settings: SettingsView()
                }
            }
            .alert("Sign Out", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
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
                        .font(.system(size: 16, weight: .regular))
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
            .padding(.vertical, 21)
        }
        .buttonStyle(.plain)
    }

    private var signOutRow: some View {
        Button {
            HapticManager.shared.impact(.light)
            showSignOutConfirm = true
        } label: {
            HStack {
                Text("Sign Out")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(Color.nmlMuted)
                Spacer()
            }
            .padding(.vertical, 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    MainTabView()
        .environment(AppState())
}
