import SwiftUI
import UIKit

struct MainTabView: View {
    @AppStorage("oxy_accentColor") private var accentColor = "stone"
    @AppStorage(ThreadBackground.storageKey) private var backgroundRaw = ThreadBackground.automatic.rawValue
    @State private var opened: ThreadMenuChoice?

    private var background: ThreadBackground { ThreadBackground(rawValue: backgroundRaw) ?? .automatic }

    var body: some View {
        ChatView(onMenuChoice: { opened = $0 })
            .tint(Color.appAccent)
            .preferredColorScheme(background.scheme)
            .id(accentColor + backgroundRaw)
            .sheet(item: $opened) { choice in
                Group {
                    switch choice {
                    case .activity: AdamActivityView()
                    case .home: YourHomeView()
                    default: AdamYouView()
                    }
                }
                .presentationDragIndicator(.visible)
            }
            .onReceive(NotificationCenter.default.publisher(for: AskAdam.notification)) { _ in
                opened = nil
            }
            .onAppear {
                HapticManager.shared.prepare()
                #if DEBUG
                if let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_OPEN"],
                   let choice = ThreadMenuChoice(rawValue: raw) { opened = choice }
                #endif
            }
    }
}

struct AdamPresence: View {
    enum PresenceState {
        case idle, listening, thinking, speaking, complete
    }

    var state: PresenceState = .idle
    var size: CGFloat = 96

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.State private var breathing = false
    @SwiftUI.State private var rotating = false

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.appSurface)
                .shadow(color: Color.appAccent.opacity(0.12), radius: 22)

            Circle()
                .strokeBorder(Color.appHairline, lineWidth: 1)
                .padding(size * 0.08)

            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.appAccent.opacity(0.42), Color.appAccent.opacity(0.08), .clear],
                        center: state == .listening ? .topLeading : .center,
                        startRadius: 2,
                        endRadius: size * 0.44
                    )
                )
                .padding(size * 0.13)
                .rotationEffect(.degrees(rotating ? 360 : 0))

            AdamMark()
                .frame(width: size * 0.35, height: size * 0.25)
        }
        .frame(width: size, height: size)
        .scaleEffect(reduceMotion ? 1 : (breathing ? activeScale : 1))
        .animation(
            reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: state == .idle ? 2.6 : 0.8).repeatForever(autoreverses: true),
            value: breathing
        )
        .animation(
            reduceMotion ? .easeInOut(duration: 0.2) : .linear(duration: 6).repeatForever(autoreverses: false),
            value: rotating
        )
        .onAppear {
            breathing = true
            rotating = state == .thinking || state == .speaking
        }
        .onChange(of: state) { _, newState in
            rotating = newState == .thinking || newState == .speaking
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var activeScale: CGFloat {
        switch state {
        case .idle: return 1.018
        case .listening: return 1.05
        case .thinking, .speaking: return 1.025
        case .complete: return 0.98
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .idle: return "Adam is ready"
        case .listening: return "Adam is listening"
        case .thinking: return "Adam is thinking"
        case .speaking: return "Adam is speaking"
        case .complete: return "Adam finished"
        }
    }
}

private struct AdamYouView: View {
    @Environment(AppState.self) private var appState
    @State private var destination: Destination?
    @State private var showsBackgroundPicker = false

    private enum Destination: String, Identifiable {
        case profile, memory, connections, agents, privacy, settings
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 30) {
                        Text("Settings")
                            .font(.title.weight(.semibold))
                            .appHeroTracking(28)
                            .foregroundStyle(Color.appInk)

                        identityHeader

                        youGroup {
                            youRow(title: "What Adam remembers", subtitle: "See it and change it", icon: "person") { destination = .memory }
                            AppDivider(inset: 50)
                            youRow(title: "Connected apps", subtitle: "Mail, calendar, messages and more", icon: "cube") { destination = .connections }
                        }

                        youGroup {
                            youRow(title: "Privacy and safety", subtitle: "What Adam asks you first", icon: "shield-check") { destination = .privacy }
                            AppDivider(inset: 50)
                            youRow(title: "Account and preferences", subtitle: "Your details, alerts and more", icon: "list") { destination = .settings }
                            AppDivider(inset: 50)
                            youRow(title: "Appearance", subtitle: ThreadBackground.current.title, icon: "sun") { showsBackgroundPicker = true }
                        }

                        youSection("Advanced") {
                            youRow(title: "Which AI Adam uses", subtitle: "For people who like to choose", icon: "waveform") { destination = .agents }
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 18)
                    .padding(.bottom, 40)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .fullScreenCover(item: $destination) { item in
            destinationView(item).swipeToDismiss()
        }
        .sheet(isPresented: $showsBackgroundPicker) { BackgroundPicker() }
        #if DEBUG
        .onAppear {
            if let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_YOU"],
               let target = Destination(rawValue: raw) { destination = target }
        }
        #endif
    }

    private var identityHeader: some View {
        HStack(spacing: 16) {
            Text(initials)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.appInk)
                .frame(width: 50, height: 50)
                .background(Color.appReceivedBubble, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(displayName)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Color.appInk)
            }
            Spacer()
            Button { destination = .profile } label: {
                AppIcon("chevron-right", size: 13)
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.appScale)
            .accessibilityLabel("Open profile")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.appReceivedBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func youSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.appInk)
            VStack(spacing: 0) { content() }
                .padding(.horizontal, 16)
                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func youGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, 16)
            .background(Color.appReceivedBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func youRow(title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 13) {
                AppIcon(icon, size: 17)
                    .foregroundStyle(Color.appInk)
                    .frame(width: 36, height: 36)
                    .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.appInk)
                    Text(subtitle).font(.footnote).foregroundStyle(Color.appMuted)
                }
                Spacer()
                AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
    }

    @ViewBuilder
    private func destinationView(_ item: Destination) -> some View {
        switch item {
        case .profile: ProfileView()
        case .memory: MemoryView()
        case .connections: ConnectorsView()
        case .agents: ModelRoutingView()
        case .privacy: TrustCenterView()
        case .settings: SettingsView()
        }
    }

    private var displayName: String {
        let saved = savedSettings.userName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !saved.isEmpty, !["user", "demo", "test"].contains(saved.lowercased()) { return saved }
        let local = appState.userId.split(separator: "@").first.map(String.init) ?? ""
        return local.isEmpty ? "You" : local.prefix(1).uppercased() + local.dropFirst()
    }

    private var initials: String {
        let parts = displayName.split(separator: " ").prefix(2)
        let value = parts.compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? "Y" : value.uppercased()
    }

    private var savedSettings: OxySettings {
        guard let data = UserDefaults.standard.data(forKey: "oxy_settings"),
              let settings = try? JSONDecoder().decode(OxySettings.self, from: data) else { return OxySettings() }
        return settings
    }
}

private struct BackgroundPicker: View {
    @AppStorage(ThreadBackground.storageKey) private var backgroundRaw = ThreadBackground.automatic.rawValue
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("Appearance")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.appInk)
            HStack(spacing: 16) {
                ForEach(ThreadBackground.allCases) { option in
                    Button {
                        HapticManager.shared.select()
                        backgroundRaw = option.rawValue
                        dismiss()
                    } label: {
                        VStack(spacing: 8) {
                            Circle()
                                .fill(option.swatch)
                                .frame(width: 58, height: 58)
                                .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
                                .overlay(Circle().strokeBorder(Color.appInk, lineWidth: backgroundRaw == option.rawValue ? 2.5 : 0).padding(-4))
                            Text(option.title)
                                .font(.footnote)
                                .foregroundStyle(Color.appInk)
                        }
                        .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.appScale)
                    .accessibilityAddTraits(backgroundRaw == option.rawValue ? .isSelected : [])
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appBackground.ignoresSafeArea())
        .presentationDetents([.height(220)])
    }
}

// MARK: - More View

#Preview {
    MainTabView()
        .environment(AppState())
}
   
