import SwiftUI
import UIKit

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage("oxy_appTheme") private var appTheme = "dark"
    @AppStorage("oxy_theme_profile") private var themeProfile = "titanium"
    @State private var selectedTab = Tab.today
    // The bar slides out of the way while the keyboard is up (e.g. composing in chat) and
    // returns when the keyboard dismisses — which the interactive scroll-to-dismiss makes a
    // natural "swipe near that area to bring it back" gesture.
    @State private var keyboardUp = false

    // Two surfaces only: Chat and Today (home). Everything else folds into the profile
    // icon on Today. Order = page order: Chat sits on the LEFT, so swiping right off
    // Today reveals Chat. Today is the default landing page.
    enum Tab: String, CaseIterable {
        case chat, today
    }

    var body: some View {
        // A true paged TabView for buttery 1:1 horizontal swiping. No bottom bar —
        // with only two surfaces, navigation is the swipe itself plus the profile
        // icon on Today (ChatGPT/Claude-style). A pair of hairline dots hints at the swipe.
        TabView(selection: $selectedTab) {
            ChatHomeView().tag(Tab.chat)
            TodayView().tag(Tab.today)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .animation(.easeInOut(duration: 0.25), value: selectedTab)
        .overlay(alignment: .bottom) {
            pageDots
                .opacity(keyboardUp ? 0 : 1)
                .animation(.easeInOut(duration: 0.22), value: keyboardUp)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
        .id(accentColor + appTheme + themeProfile)
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
    }

    // MARK: - Swipe affordance

    private var pageDots: some View {
        HStack(spacing: 7) {
            ForEach(Tab.allCases, id: \.self) { tab in
                Circle()
                    .fill(selectedTab == tab ? Color.nmlInk : Color.nmlMuted.opacity(0.35))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.bottom, 8)
    }
}

// MARK: - More View

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
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
                BloomBackground(intensity: 0.4)
                // No fixed "More" header — let the account header lead, matching Today's
                // scrolling feel. Same breathing obsidian canvas as the rest of the app.
                ScrollView {
                        VStack(alignment: .leading, spacing: 34) {
                            closeButton

                            accountHeader

                            group(title: "Assistant") {
                                moreRow(title: "Memory", subtitle: "What's remembered about you") {
                                    destination = .memory
                                }
                                NamelessDivider()
                                moreRow(title: "Connectors", subtitle: "Accounts, services, device access") {
                                    destination = .connectors
                                }
                                NamelessDivider()
                                moreRow(title: "Settings", subtitle: "Voice, appearance, behaviour") {
                                    destination = .settings
                                }
                            }

                            group(title: "Device") {
                                moreRow(
                                    title: "Pendant",
                                    subtitle: "Pairing, status, hardware",
                                    trailing: pendantStatusText,
                                    trailingLive: pendant.isConnected
                                ) {
                                    destination = .pendant
                                }
                            }

                            signOutRow
                                .padding(.top, 22)
                        }
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 32)
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

    // A visible way out — the sheet has swipe-to-dismiss, but a tappable close is
    // not optional. Top-right chevron, the way ChatGPT/Claude let you leave a sheet.
    private var closeButton: some View {
        HStack {
            Spacer()
            Button {
                HapticManager.shared.impact(.light)
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.nmlInk)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(Color.white.opacity(0.06)))
                    .overlay(Circle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Account header

    private var accountHeader: some View {
        Button {
            HapticManager.shared.impact(.light)
            destination = .profile
        } label: {
            HStack(spacing: 14) {
                // A quiet monogram instead of a colourful avatar — first letter of
                // the assistant name in a hairline ring.
                Text(monogram)
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(Color.white.opacity(0.05)))
                    .overlay(Circle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))

                VStack(alignment: .leading, spacing: 3) {
                    Text("Account")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(Color.nmlInk)
                    Text("Identity, export, sign out")
                        .font(.system(size: 12, weight: .light))
                        .foregroundStyle(Color.nmlMuted)
                }

                Spacer()

                Text("›")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var monogram: String {
        // Derive the account monogram from the signed-in user's id (the product itself
        // is nameless), falling back to a neutral dash.
        let trimmed = appState.userId.trimmingCharacters(in: .whitespaces)
        return String(trimmed.first ?? "—").uppercased()
    }

    private var pendantStatusText: String? {
        switch pendant.connectionState {
        case .connected: return "Connected"
        case .scanning, .connecting: return "Pairing…"
        case .error: return "Error"
        case .disconnected: return "Not connected"
        }
    }

    // MARK: - Grouped rows

    private func group<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NamelessSectionHeader(title: title)
                .padding(.bottom, 6)
            VStack(spacing: 0) { content() }
        }
    }

    private func moreRow(
        title: String,
        subtitle: String,
        trailing: String? = nil,
        trailingLive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
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
                        .fixedSize(horizontal: false, vertical: true)
                }
                .layoutPriority(1)
                Spacer()
                if let trailing {
                    HStack(spacing: 7) {
                        if trailingLive {
                            NamelessStatusDot(isLive: true, diameter: 5)
                        }
                        Text(trailing)
                            .font(.nmlBody(11, weight: .medium))
                            .tracking(0.2)
                            .foregroundStyle(Color.nmlMuted)
                    }
                }
                Text("›")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }
            .padding(.vertical, 18)
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
