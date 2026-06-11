import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @State private var selectedTab = Tab.today

    enum Tab: String, CaseIterable {
        case chat, today, more

        var icon: String {
            switch self {
            case .chat: return "bubble.left"
            case .today: return "sun.max"
            case .more: return "square.grid.2x2"
            }
        }

        var label: String {
            switch self {
            case .chat: return "Chat"
            case .today: return "Today"
            case .more: return "More"
            }
        }
    }

    var body: some View {
        // A true paged TabView for buttery 1:1 horizontal swiping. The native
        // page style hides the system tab bar, so a slim custom bar is added via
        // safeAreaInset (which also keeps page content clear of it).
        TabView(selection: $selectedTab) {
            ChatHomeView().tag(Tab.chat)
            ProactiveView().tag(Tab.today)
            MoreView().tag(Tab.more)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .animation(.easeInOut(duration: 0.25), value: selectedTab)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar
        }
        .id(accentColor + appTheme)
        .onChange(of: selectedTab) { _, _ in
            HapticManager.shared.select()
        }
        .onAppear {
            HapticManager.shared.prepare()
            // Cold-launch from the "Ask Oxy" Siri intent: the jump-to-chat
            // notification fired before this view subscribed, so peek the bus
            // (ChatView.task consumes the query itself).
            if SiriRequestBus.shared.pendingQuery != nil {
                selectedTab = .chat
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToChat)) { _ in
            withAnimation { selectedTab = .chat }
        }
        .onReceive(NotificationCenter.default.publisher(for: .oxyJumpToMore)) { _ in
            withAnimation { selectedTab = .more }
        }
    }

    // MARK: - Custom bottom bar

    private var bottomBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5)

            HStack(spacing: 0) {
                ForEach(Tab.allCases, id: \.self) { tab in
                    tabButton(tab)
                }
            }
            .padding(.top, 10)
            .padding(.bottom, 4)
        }
        .background(Color.black)
    }

    private func tabButton(_ tab: Tab) -> some View {
        let selected = selectedTab == tab
        return Button {
            withAnimation(.easeInOut(duration: 0.25)) { selectedTab = tab }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: selected ? "\(tab.icon).fill" : tab.icon)
                    .font(.system(size: 19, weight: .regular))
                    .frame(width: 34, height: 34)
                    .modifier(TabGlassModifier(selected: selected))
                Text(tab.label)
                    .font(.system(size: 10, weight: selected ? .semibold : .medium))
            }
            .foregroundStyle(selected ? Color.nmlInk : Color.nmlMuted)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Gives the active tab's icon a Liquid Glass pill on iOS 26+ (a frosted
/// circle approximation on earlier versions); unselected icons stay bare.
private struct TabGlassModifier: ViewModifier {
    let selected: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if selected {
            content.nmlGlass(Circle())
        } else {
            content
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
                VStack(spacing: 0) {
                    ScreenHeaderView(title: "More")
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
            }
            .toolbar(.hidden, for: .navigationBar)
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
