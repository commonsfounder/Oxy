import SwiftUI
import UIKit

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    /// North star: agentic Home is the product. Chat is history / deep work, not identity.
    @State private var selectedTab = Tab.home

    enum Tab: String, CaseIterable {
        case home, chat, more

        /// Bundled asset key (no SF Symbols).
        var icon: String {
            switch self {
            case .home: return "tab-home"
            case .chat: return "tab-chat"
            case .more: return "tab-more"
            }
        }

        var label: String {
            switch self {
            case .home: return "Home"
            case .chat: return "Chat"
            case .more: return "More"
            }
        }
    }

    private func tabLabel(_ tab: Tab) -> some View {
        Label {
            Text(tab.label)
        } icon: {
            Image("ic-\(tab.icon)").renderingMode(.template)
        }
    }

    var body: some View {
        // System TabView keeps iOS liquid-glass chrome. A second custom bar used to
        // stack on top of it (double tab bar); do not reintroduce that overlay.
        TabView(selection: $selectedTab) {
            AgenticHomeView()
                .tag(Tab.home)
                .tabItem { tabLabel(.home) }
            ChatHomeView()
                .tag(Tab.chat)
                .tabItem { tabLabel(.chat) }
            MoreView()
                .tag(Tab.more)
                .tabItem { tabLabel(.more) }
        }
        .tint(Color.appAccent)
        // Environment still provided so scroll helpers / previews that read it stay safe;
        // we no longer drive a custom floating bar from it.
        .environment(TabBarVisibility())
        .onChange(of: selectedTab) { _, _ in
            HapticManager.shared.select()
        }
        .id(accentColor)
        .onAppear {
            HapticManager.shared.prepare()
            #if DEBUG
            if let tab = ProcessInfo.processInfo.environment["OXY_DEBUG_TAB"],
               let t = Tab(rawValue: tab) {
                selectedTab = t
                return
            }
            if ProcessInfo.processInfo.environment["OXY_DEBUG_AUTOLOGIN"] == "1" {
                selectedTab = .home
                return
            }
            #endif
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
        case profile, pendant, connectors, memory, settings, payments
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                // The Gleb pastel wash, same living mesh as Home — glass menu plates
                // float over it so More reads as one piece with the agentic surfaces
                // instead of a flat settings list.
                GlebChrome.pastelBlob.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        identityHeader
                            .appEntrance(appeared, riseOffset: 16, delay: 0.04)
                        menuSection
                            .appEntrance(appeared, riseOffset: 12, delay: 0.14)
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
                    case .payments: PaymentsView()
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
                    .appHeroTracking(28)
                    .foregroundStyle(Color.appInk)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)

                if !accountEmail.isEmpty {
                    Text(accountEmail)
                        .font(.appBody(12))
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

    private var pendantDot: AppStatusDot.Kind {
        switch pendant.connectionState {
        case .connected: return .live
        case .scanning, .connecting: return .degraded
        case .disconnected: return .off
        case .error: return .error
        }
    }

    // MARK: - Menu (flat list, ordered: account, device, memory, connections, payments, settings)

    private var menuSection: some View {
        VStack(spacing: 0) {
            AppRow(title: "Account") { destination = .profile }
            rowDivider
            AppRow(title: "Pendant", onTap: { destination = .pendant }) {
                HStack(spacing: 8) {
                    AppStatusDot(kind: pendantDot, diameter: 5)
                    if let s = pendantStatusText {
                        Text(s).font(.rowSecondary).foregroundStyle(Color.appMuted)
                    }
                }
            }
            rowDivider
            AppRow(title: "Memory") { destination = .memory }
            rowDivider
            AppRow(title: "Connections") { destination = .connectors }
            rowDivider
            AppRow(title: "Payments") { destination = .payments }
            rowDivider
            AppRow(title: "Settings") { destination = .settings }
        }
        .padding(.horizontal, 16)
        // Rows sit on a glass plate that refracts the wash behind it.
        .background { MissionGlassPlate() }
        .padding(.top, 24)
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
