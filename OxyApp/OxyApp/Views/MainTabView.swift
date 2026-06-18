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
        .animation(.easeInOut(duration: 0.25), value: selectedTab)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar
                .offset(y: keyboardUp ? 130 : 0)
                .opacity(keyboardUp ? 0 : 1)
                .allowsHitTesting(!keyboardUp)
                .animation(.easeInOut(duration: 0.22), value: keyboardUp)
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
            withAnimation(.easeInOut(duration: 0.25)) { selectedTab = tab }
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
                    Capsule().fill(Color.white.opacity(0.08))
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
                // No fixed "More" header — the tab bar already labels this screen, and a sticky
                // title here read as inconsistent next to Chat/Today. Let the account header lead,
                // matching Today's scrolling feel.
                ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            accountHeader

                            menuCard {
                                moreRow(icon: "brain", title: "Memory") { destination = .memory }
                                rowDivider
                                moreRow(icon: "link", title: "Connectors") { destination = .connectors }
                                rowDivider
                                moreRow(icon: "slider.horizontal.3", title: "Settings") { destination = .settings }
                                rowDivider
                                moreRow(
                                    icon: "dot.radiowave.left.and.right",
                                    title: "Pendant",
                                    trailing: pendantStatusText,
                                    trailingLive: pendant.isConnected
                                ) { destination = .pendant }
                            }

                            Button {
                                HapticManager.shared.impact(.light)
                                showSignOutConfirm = true
                            } label: {
                                Text("Sign Out")
                                    .font(.system(size: 14, weight: .regular))
                                    .foregroundStyle(Color.nmlMuted)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 24)
                        .padding(.bottom, 40)
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

    // MARK: - Account header

    private var accountHeader: some View {
        Button {
            HapticManager.shared.impact(.light)
            destination = .profile
        } label: {
            HStack(spacing: 14) {
                // A quiet monogram in a hairline ring — initial of the user's name.
                Text(monogram)
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Color.white.opacity(0.05)))
                    .overlay(Circle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))

                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.nmlInk)
                        .lineLimit(1)
                    Text(accountSubtitle)
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.nmlMuted)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(cardBackground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The user's name from Profile, or a quiet prompt to set it up.
    private var displayName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data),
           !saved.userName.trimmingCharacters(in: .whitespaces).isEmpty {
            return saved.userName.trimmingCharacters(in: .whitespaces)
        }
        return "Set up your profile"
    }

    private var accountSubtitle: String {
        let id = appState.userId.trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? "Profile · data · sign out" : id
    }

    private var monogram: String {
        let name = displayName
        let source = name == "Set up your profile" ? appState.userId : name
        let trimmed = source.trimmingCharacters(in: .whitespaces)
        return String(trimmed.first ?? "—").uppercased()
    }

    private var pendantStatusText: String? {
        switch pendant.connectionState {
        case .connected: return "Connected"
        case .scanning, .connecting: return "Pairing…"
        case .error: return "Error"
        case .disconnected: return nil
        }
    }

    // MARK: - Menu card

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.nmlSurface)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
            )
    }

    private func menuCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(cardBackground)
    }

    /// Hairline between rows, inset to clear the glyph column so it reads as a list.
    private var rowDivider: some View {
        Rectangle()
            .fill(Color.nmlHairline)
            .frame(height: 0.5)
            .padding(.leading, 54)
    }

    private func moreRow(
        icon: String,
        title: String,
        trailing: String? = nil,
        trailingLive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .light))
                    .foregroundStyle(Color.nmlTitanium)
                    .frame(width: 24, alignment: .center)
                Text(title)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Spacer()
                if let trailing {
                    HStack(spacing: 7) {
                        if trailingLive {
                            NamelessStatusDot(isLive: true, diameter: 5)
                        }
                        Text(trailing)
                            .font(.nmlBody(11, weight: .medium))
                            .tracking(0.2)
                            .foregroundStyle(trailingLive ? Color.nmlLive : Color.nmlMuted)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.nmlMuted.opacity(0.6))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 15)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

}

#Preview {
    MainTabView()
        .environment(AppState())
}
