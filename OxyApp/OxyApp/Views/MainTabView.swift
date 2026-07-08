import SwiftUI
import UIKit

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @State private var selectedTab = Tab.today
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
        ZStack {
            Color.appBackground.ignoresSafeArea()

            // Standard tab view — reliable muscle memory. No more fussy page swipe + tucked glass.
            // Accent color now drives selection and life in the UI.
            TabView(selection: $selectedTab) {
                ChatHomeView()
                    .tag(Tab.chat)
                    .tabItem { Label(Tab.chat.label, systemImage: Tab.chat.icon) }
                ProactiveView()
                    .tag(Tab.today)
                    .tabItem { Label(Tab.today.label, systemImage: Tab.today.icon) }
                MoreView()
                    .tag(Tab.more)
                    .tabItem { Label(Tab.more.label, systemImage: Tab.more.icon) }
            }
            .tint(Color.appAccent)
            .environment(TabBarVisibility())
            .onChange(of: selectedTab) { _, _ in
                HapticManager.shared.select()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
        .id(accentColor)
        .onAppear {
            HapticManager.shared.prepare()
            if appState.isDemoSession || SiriRequestBus.shared.pendingQuery != nil {
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
}

// MARK: - More View

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: MoreDestination?
    @State private var appeared = false

    private var pendant: PendantBLEManager { NativeIntegrationManager.shared.pendant }
    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }

    enum MoreDestination: Identifiable {
        case profile, pendant, connectors, memory, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                // Transparent over the shared aurora canvas (like Today/Chat) so More
                // takes the same finish instead of its own flat black.
                Color.clear.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        identityHeader
                            .opacity(appeared ? 1 : 0)
                            .offset(y: appeared ? 0 : 16)
                            .animation(.appSpring.delay(0.04), value: appeared)
                        menuSection
                            .opacity(appeared ? 1 : 0)
                            .offset(y: appeared ? 0 : 12)
                            .animation(.appSpring.delay(0.14), value: appeared)
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 32)
                    .padding(.bottom, 48)
                }
                .onAppear {
                    // First visit only — TabView re-fires onAppear on every tab switch,
                    // and replaying the entrance stagger each time reads as a glitch.
                    guard !appeared else { return }
                    withAnimation { appeared = true }
                }
                .hidesTabBarOnScroll()
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
                // fullScreenCover starts a fresh environment, so carry the finish into it.
                .environment(\.colorScheme, lightMode ? .light : .dark)
            }
        }
    }

    // MARK: - Identity header (Milgrain clean)

    private var identityHeader: some View {
        Button {
            HapticManager.shared.impact(.light)
            destination = .profile
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                BrandWordmark(height: 20, color: Color.appInk.opacity(0.85))
                    .padding(.bottom, 28)

                Text(displayName)
                    .font(.heroDisplay(28))
                    .foregroundStyle(Color.appInk)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)

                if !accountEmail.isEmpty {
                    Text(accountEmail)
                        .font(.appBody(12, weight: .light))
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.top, 6)
                }

                if appState.isDemoSession {
                    Text("Demo/Test session")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
                        .foregroundStyle(Color.appAccent)
                        .padding(.top, 10)
                }

                // Hairline rule separating identity from navigation
                Rectangle()
                    .fill(Color.appHairline)
                    .frame(height: 0.5)
                    .padding(.top, 28)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        // A full-bleed 46pt header: scaling it is motion you can't perceive, only cost.
        // Plain = static, the skill's prescription for big surfaces.
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
        case .connected:              return pendant.peripheralName ?? "Connected"
        case .disconnected, .error:   return "Not connected"
        case .scanning, .connecting:  return "Pairing"
        }
    }

    // MARK: - Menu (labelled rows with subtitles)

    private var menuSection: some View {
        VStack(spacing: 0) {
            AppRow(title: "Memory", subtitle: "What I remember about you") { destination = .memory }
            rowDivider
            AppRow(title: "Connections", subtitle: "Apps and services I can use") { destination = .connectors }
            rowDivider
            AppRow(title: "Settings", subtitle: "Preferences and defaults") { destination = .settings }
            rowDivider
            AppRow(title: "Pendant", subtitle: "Your device", onTap: { destination = .pendant }) {
                if let s = pendantStatusText {
                    Text(s).font(.rowSecondary).foregroundStyle(Color.appMuted)
                } else {
                    EmptyView()
                }
            }
            rowDivider
            AppRow(title: "Account", subtitle: "Name, data, and sign out") { destination = .profile }
        }
        .padding(.top, 4)
    }

    private var rowDivider: some View {
        Rectangle()
            .fill(Color.appHairline)
            .frame(height: 0.5)
    }

}

#Preview {
    MainTabView()
        .environment(AppState())
}
