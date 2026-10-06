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
                    case .memory: MemoryView()
                    case .apps: ConnectorsView()
                    case .payments: PaymentsView()
                    case .logins: VaultView()
                    case .displays: PairedDisplaysView()
                    case .settings, .privateChat: AdamYouView()
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
                .frame(width: size * 0.3, height: size * 0.3)
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
    @State private var contextModel = SettingsContextModel()
    @State private var showBackendURLEditor = false
    @State private var versionTapCount = 0
    #if DEBUG
    @State private var showsIndicatorPreview = false
    #endif
    @AppStorage("oxy_custom_backend_url") private var customBackendURL = ""

    private enum Destination: String, Identifiable {
        case you, connections, preferences, account, agents
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 26) {
                        Text("Settings")
                            .font(.heroTitle)
                            .foregroundStyle(Color.appInk)

                        SettingsList {
                            youRow(title: "You", subtitle: youStatus, icon: "person") { destination = .you }
                            SettingsRule(inset: 34)
                            youRow(title: "Connections", subtitle: connectionsStatus, icon: "cube") { destination = .connections }
                            SettingsRule(inset: 34)
                            youRow(title: "Preferences", subtitle: ThreadBackground.current.title, icon: "sun") { destination = .preferences }
                            SettingsRule(inset: 34)
                            youRow(title: "Account", subtitle: appState.userId, icon: "list") { destination = .account }
                        }

                        Spacer(minLength: 40)

                        VStack(spacing: 14) {
                            Button {
                                versionTapCount += 1
                                if versionTapCount >= 5 {
                                    versionTapCount = 0
                                    showBackendURLEditor = true
                                }
                            } label: {
                                VStack(spacing: 10) {
                                    AdamMark().frame(width: 36, height: 36)
                                    Text("adam-0001-alpha")
                                        .font(.system(size: 12, weight: .regular, design: .monospaced))
                                        .foregroundStyle(Color.appMuted)
                                }
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Adam, version adam-0001-alpha")

                            Button { destination = .agents } label: {
                                Text("Advanced")
                                    .font(.appBody(13))
                                    .foregroundStyle(Color.appMuted)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 18)
                    .padding(.bottom, 28)
                    .containerRelativeFrame(.vertical, alignment: .top)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showBackendURLEditor) {
                BackendURLEditorSheet(currentURL: $customBackendURL) { showBackendURLEditor = false }
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
            .task { await contextModel.load(isDemo: appState.isDemoSession) }
        }
        .fullScreenCover(item: $destination) { item in
            destinationView(item).swipeToDismiss()
        }
        #if DEBUG
        .fullScreenCover(isPresented: $showsIndicatorPreview) {
            if ProcessInfo.processInfo.environment["OXY_DEBUG_YOU"] == "transition" { ActivityTransitionPreview() } else { ActivityMarkPreview() }
        }
        .onAppear {
            if let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_YOU"] {
                if raw == "indicator" || raw == "transition" { showsIndicatorPreview = true }
                else if let target = Destination(rawValue: raw) { destination = target }
            }
        }
        #endif
    }

    private func youRow(title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
        SettingsNavRow(title: title, subtitle: subtitle, lead: .icon(icon), action: action)
    }

    private var youStatus: String {
        let name = SettingsStore.load().userName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Your name, home and memory" : name
    }

    private var connectionsStatus: String {
        let apps = contextModel.context?.connectedApps ?? []
        switch apps.count {
        case 0: return "Apps, displays and payments"
        case 1...3: return apps.joined(separator: ", ")
        default: return "\(apps.count) connected"
        }
    }

    @ViewBuilder
    private func destinationView(_ item: Destination) -> some View {
        switch item {
        case .you: YouPage()
        case .connections: ConnectionsPage()
        case .preferences: PreferencesPage()
        case .account: ProfileView()
        case .agents: ModelRoutingView()
        }
    }
}

// MARK: - More View

#Preview {
    MainTabView()
        .environment(AppState())
}
   

#if DEBUG
/// Debug only (OXY_DEBUG_YOU=indicator): the activity mark in each state, small and large.
struct ActivityMarkPreview: View {
    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 34) {
                ForEach([("Working", AdamActivityState.working), ("Listening", .listening), ("Waiting for you", .waiting)], id: \.0) { name, state in
                    HStack(spacing: 24) {
                        AdamActivityMark(state: state, size: 96)
                        VStack(alignment: .leading, spacing: 10) {
                            Text(name).font(.appBody(15, weight: .medium)).foregroundStyle(Color.appInk)
                            AdamActivityMark(state: state, size: 28)
                        }
                    }
                }
                HStack(spacing: 24) {
                    TimelineView(.periodic(from: .now, by: 2.8)) { context in
                        let steps: [AdamActivityState] = [.working, .listening, .waiting]
                        AdamActivityMark(state: steps[Int(context.date.timeIntervalSinceReferenceDate / 2.8) % steps.count], size: 96)
                    }
                    Text("Changing state").font(.appBody(15, weight: .medium)).foregroundStyle(Color.appInk)
                }
                WorkingBubble(label: "Looking at image").padding(.horizontal, -AppSpacing.chatMargin)
            }
            .padding(.horizontal, AppSpacing.margin)
        }
    }
}
#endif

#if DEBUG
/// Debug only (OXY_DEBUG_YOU=transition): one large mark that goes working, then waiting, then back.
struct ActivityTransitionPreview: View {
    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            TimelineView(.periodic(from: .now, by: 3.0)) { context in
                let working = Int(context.date.timeIntervalSinceReferenceDate / 3.0) % 2 == 0
                VStack(spacing: 28) {
                    AdamActivityMark(state: working ? .working : .waiting, size: 220)
                    Text(working ? "Working" : "Waiting for you")
                        .font(.appBody(17, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                }
            }
        }
    }
}
#endif
