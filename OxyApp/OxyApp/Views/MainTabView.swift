import SwiftUI
import UIKit

struct MainTabView: View {
    @AppStorage("oxy_accentColor") private var accentColor = "stone"

    /// Home is the root screen. Chat and account open from here.
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

    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }

    enum MoreDestination: Identifiable {
        case profile, history, connectors, settings
        var id: String { "\(self)" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                GlebChrome.pastelBlob.ignoresSafeArea()
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
                    case .history: ChatHomeView(showHistoryOnAppear: true)
                    case .connectors: ConnectorsView()
                    case .settings: SettingsView()
                    }
                }
                .swipeToDismiss()
                .environment(\.colorScheme, lightMode ? .light : .dark)
            }
        }
    }

    // MARK: - Identity

    private var identityHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandWordmark(height: 20, color: Color.appInk)
                .padding(.bottom, 28)

            Text(displayName)
                .font(.heroDisplay())
                .appHeroTracking(AppText.display)
                .foregroundStyle(Color.appInk)
                .lineLimit(2)
                .minimumScaleFactor(0.7)

            if !accountEmail.isEmpty {
                Text(accountEmail)
                    .font(.appBody(AppText.caption))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.top, 6)
            }

            if appState.isDemoSession {
                Text("Demo/Test session")
                    .appEyebrow(.appAccent)
                    .padding(.top, 10)
            }

            Rectangle()
                .fill(Color.appHairline)
                .frame(height: AppBorder.hairline)
                .padding(.top, 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var displayName: String {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data),
           !saved.userName.trimmingCharacters(in: .whitespaces).isEmpty {
            let name = saved.userName.trimmingCharacters(in: .whitespaces)
            if !["user", "demo", "demo user", "test"].contains(name.lowercased()) {
                return name
            }
        }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? appState.userId
        let first = local.split(whereSeparator: { ".-_0123456789".contains($0) }).first.map(String.init) ?? ""
        if first.count >= 2, first.count <= 20,
           !["user", "demo", "test"].contains(first.lowercased()) {
            return first.prefix(1).uppercased() + first.dropFirst().lowercased()
        }
        return "Your Account"
    }

    /// The email account id, when available.
    private var accountEmail: String {
        let id = appState.userId.trimmingCharacters(in: .whitespaces)
        return id.contains("@") ? id : ""
    }

    // MARK: - Menu

    private var menuSection: some View {
        VStack(spacing: 0) {
            AppRow(title: "Account") { destination = .profile }
            rowDivider
            AppRow(title: "History") { destination = .history }
            rowDivider
            AppRow(title: "Connections") { destination = .connectors }
            rowDivider
            AppRow(title: "Settings") { destination = .settings }
        }
        .padding(.horizontal, 16)
        .background { MissionGlassPlate() }
        .padding(.top, 24)
    }

    private var rowDivider: some View {
        Rectangle()
            .fill(Color.appHairline)
            .frame(height: AppBorder.hairline)
    }

}

#Preview {
    MainTabView()
        .environment(AppState())
}
