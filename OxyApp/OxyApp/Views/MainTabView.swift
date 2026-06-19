import SwiftUI
import UIKit

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @State private var selectedTab = Tab.today
    // The bar slides out of the way while the keyboard is up (e.g. composing in chat) and
    // returns when the keyboard dismisses — which the interactive scroll-to-dismiss makes a
    // natural "swipe near that area to bring it back" gesture.
    @State private var keyboardUp = false

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
        .animation(.nmlStandard, value: selectedTab)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar
                .offset(y: keyboardUp ? 130 : 0)
                .opacity(keyboardUp ? 0 : 1)
                .allowsHitTesting(!keyboardUp)
                .animation(.nmlStandard, value: keyboardUp)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
        .id(accentColor)
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

    // A floating Liquid Glass bar (Apple iOS 26 style): the whole bar is one
    // refractive glass surface that hovers above the bottom edge, with a soft
    // highlight capsule marking the active tab.
    private var bottomBar: some View {
        nmlGlassContainer(spacing: 4) {
            HStack(spacing: 4) {
                ForEach(Tab.allCases, id: \.self) { tab in
                    tabButton(tab)
                }
            }
            .padding(6)
            // Passive glass: an `interactive` surface here captures presses for the whole bar
            // and starves the individual tab Buttons (the "tap 50 times" bug). The buttons own
            // their own gesture + highlight.
            .nmlGlass(Capsule(), interactive: false)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 4)
    }

    private func tabButton(_ tab: Tab) -> some View {
        let selected = selectedTab == tab
        return Button {
            withAnimation(.nmlStandard) { selectedTab = tab }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: selected ? "\(tab.icon).fill" : tab.icon)
                    .font(.system(size: 18, weight: .regular))
                Text(tab.label)
                    .font(.system(size: 10, weight: selected ? .semibold : .medium))
            }
            .foregroundStyle(selected ? Color.nmlInk : Color.nmlMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background {
                if selected {
                    Capsule().fill(Color.nmlFillSubtle)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - More View

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: MoreDestination?
    @State private var showSignOutConfirm = false

    private var pendant: PendantBLEManager { NativeIntegrationManager.shared.pendant }

    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.nmlObsidian.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        identityHeader
                        menuSection
                        signOutButton
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 32)
                    .padding(.bottom, 48)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .fullScreenCover(item: $destination) { dest in
                Group {
                    switch dest {
                    case .profile: ProfileView()
                    case .pendant: PendantStatusView()
                    case .connectors: ConnectorsView()
                    case .memory: MemoryView()
                    case .settings: SettingsView()
                    }
                }
                .swipeToDismiss()
            }
            .alert("Sign Out", isPresented: $showSignOutConfirm) {
                Button("Sign Out", role: .destructive) { appState.logout() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Are you sure you want to sign out?")
            }
        }
    }

    // MARK: - Identity header (Milgrain editorial)

    private var identityHeader: some View {
        Button {
            HapticManager.shared.impact(.light)
            destination = .profile
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                BrandWordmark()
                    .padding(.bottom, 28)

                Text(displayName)
                    .font(.nmlDisplay(38, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                    .lineLimit(2)
                    .minimumScaleFactor(0.75)

                if !accountEmail.isEmpty {
                    Text(accountEmail)
                        .font(.nmlBody(12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.top, 6)
                }

                // Hairline rule separating identity from navigation
                Rectangle()
                    .fill(Color.nmlHairline)
                    .frame(height: 0.5)
                    .padding(.top, 28)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var displayName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data),
           !saved.userName.trimmingCharacters(in: .whitespaces).isEmpty {
            return saved.userName.trimmingCharacters(in: .whitespaces)
        }
        // Derive a readable first name from the account id (email local-part)
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? appState.userId
        let first = local.split(whereSeparator: { ".-_0123456789".contains($0) }).first.map(String.init) ?? ""
        if first.count >= 2, first.count <= 20 {
            return first.prefix(1).uppercased() + first.dropFirst().lowercased()
        }
        return "Your Account"
    }

    /// Shows the email portion of the account id, or nothing if it doesn't look like one.
    private var accountEmail: String {
        let id = appState.userId.trimmingCharacters(in: .whitespaces)
        return id.contains("@") ? id : ""
    }

    private var pendantStatusText: String? {
        switch pendant.connectionState {
        case .connected: return "Connected"
        case .scanning, .connecting: return "Pairing…"
        case .error: return "Error"
        case .disconnected: return nil
        }
    }

    // MARK: - Menu (no icons — typographic rows)

    private var menuSection: some View {
        VStack(spacing: 0) {
            editorialRow("Memory") { destination = .memory }
            rowDivider
            editorialRow("Connectors") { destination = .connectors }
            rowDivider
            editorialRow("Settings") { destination = .settings }
            rowDivider
            editorialRow(
                "Pendant",
                trailing: pendantStatusText,
                trailingLive: pendant.isConnected
            ) { destination = .pendant }
        }
        .padding(.top, 4)
    }

    private var rowDivider: some View {
        Rectangle()
            .fill(Color.nmlHairline)
            .frame(height: 0.5)
    }

    private func editorialRow(
        _ title: String,
        trailing: String? = nil,
        trailingLive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 0) {
                Text(title)
                    .font(.nmlBody(17, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Spacer()
                if let trailing {
                    HStack(spacing: 6) {
                        if trailingLive {
                            NamelessStatusDot(isLive: true, diameter: 5)
                        }
                        Text(trailing)
                            .font(.nmlBody(12, weight: .regular))
                            .foregroundStyle(trailingLive ? Color.nmlLive : Color.nmlMuted)
                    }
                    .padding(.trailing, 10)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .light))
                    .foregroundStyle(Color.nmlMuted.opacity(0.5))
            }
            .padding(.vertical, 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Sign out

    private var signOutButton: some View {
        Button {
            HapticManager.shared.impact(.light)
            showSignOutConfirm = true
        } label: {
            Text("Sign Out")
                .font(.nmlBody(13, weight: .regular))
                .foregroundStyle(Color.nmlMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 16)
    }

}

#Preview {
    MainTabView()
        .environment(AppState())
}
