import SwiftUI
import UIKit

struct MainTabView: View {
    @AppStorage("oxy_accentColor") private var accentColor = "stone"

    /// Home is the sole root screen — no bottom tab bar. Chat and More are reached
    /// from Home itself (composer / avatar tap / edge swipe), each as a full-screen
    /// cover that swipes back out, mirroring iOS's own Camera↔Photos convention.
    /// See AgenticHomeView for the presentation + gesture wiring.
    var body: some View {
        AgenticHomeView()
            .tint(Color.appAccent)
            .id(accentColor)
            .onAppear {
                HapticManager.shared.prepare()
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
        case profile, pendant, connectors, memory, routines, settings, payments
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                // The Gleb pastel wash, same living mesh as Home — glass menu plates
                // float over it so More reads as one piece with the agentic surfaces
                // instead of a flat settings list.
                GlebChrome.pastelBlob.ignoresSafeArea()
                // Identity + the six-row menu is short, fixed-height content — pinned to
                // the top it left the bottom third of the screen as bare gradient. Center
                // it in the available height instead (falls back to top-anchored, scrolling
                // normally, if the content ever grows past one screen).
                GeometryReader { proxy in
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
                        .frame(minHeight: proxy.size.height, alignment: .center)
                    }
                }
                .onAppear {
                    // fullScreenCover creates a fresh instance each time it's presented,
                    // so this fires — and the entrance stagger replays — every open, which
                    // is the desired feel for a modal cover (unlike the old tab-switch case).
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
                    case .routines: RoutinesListView()
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
        // Static display, not a nav trigger — "Account" is its own row in the menu
        // below, so this doubling as an invisible button to the same screen was a
        // redundant, undiscoverable tap target.
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

    // MARK: - Menu (flat list, ordered: account, device, memory, routines, connections, payments, settings)

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
            AppRow(title: "Routines") { destination = .routines }
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
