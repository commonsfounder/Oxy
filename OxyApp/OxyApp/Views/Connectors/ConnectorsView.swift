import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Connector IDs that are not yet meaningfully integrated
private let hiddenConnectorIDs: Set<String> = ["trainline"]

struct ConnectorsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectors: [Connector] = []
    @State private var isLoading = true
    @State private var googleStatus: GoogleStatus = .idle
    @State private var oauthConnecting = false
    @State private var errorMessage: String?
    @State private var cardsVisible = false
    @State private var capabilities: NativeCapabilities?

    enum GoogleStatus: String {
        case idle, connecting, connected, needsReconnect, error
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.mgBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Apps", onBack: { dismiss() })

                if isLoading {
                    VStack(spacing: 0) {
                        ForEach(0..<6, id: \.self) { _ in
                            OxySkeletonCard(height: 56, cornerRadius: 0)
                            MilgrainDivider()
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 36) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Device — native OS permissions, kept distinct from
                            // third-party services since they govern what the
                            // pendant itself is allowed to sense and use.
                            if let caps = capabilities {
                                VStack(alignment: .leading, spacing: 4) {
                                    MilgrainSectionHeader(title: "On This Device")
                                        .padding(.bottom, 12)
                                    deviceSection(caps)
                                }
                                .opacity(cardsVisible ? 1 : 0)
                                .offset(y: cardsVisible ? 0 : 18)
                                .animation(.nmlSpring.delay(0.0), value: cardsVisible)
                            }

                            // Connected apps
                            VStack(alignment: .leading, spacing: 4) {
                                MilgrainSectionHeader(title: "Apps")
                                    .padding(.bottom, 12)

                                let visible = connectors.filter { $0.implemented && !hiddenConnectorIDs.contains($0.id) }
                                let others = visible.filter { $0.id != "google" }

                                googleSection
                                if !others.isEmpty {
                                    ForEach(others) { connector in
                                        MilgrainDivider()
                                        integrationRow(connector)
                                    }
                                }
                            }
                            .opacity(cardsVisible ? 1 : 0)
                            .offset(y: cardsVisible ? 0 : 18)
                            .animation(.nmlSpring.delay(0.08), value: cardsVisible)
                        }
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 44)
                    }
                }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sensoryFeedback(trigger: errorMessage != nil) { _, failed in
                failed ? .warning : nil
            }
            .task {
                await loadAll()
            }
            .refreshable {
                await loadAll()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task {
                        if googleStatus == .connecting || oauthConnecting {
                            oauthConnecting = false
                            await loadConnectors()
                        }
                        capabilities = await NativeIntegrationManager.shared.currentCapabilities()
                    }
                }
            }
            // Edge-swipe-to-dismiss comes from `.swipeToDismiss()` on the presenting
            // fullScreenCover (MoreView); no per-screen recognizer needed.
        }
    }

    // MARK: - Device Section

    private func deviceSection(_ caps: NativeCapabilities) -> some View {
        let items = NativeCapabilityItem.all(from: caps)
        return VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index != 0 { MilgrainDivider() }
                NativeCapabilityRow(item: item) {
                    await handleNativeAction(item)
                }
            }
        }
    }

    private func handleNativeAction(_ item: NativeCapabilityItem) async {
        let nim = NativeIntegrationManager.shared
        switch item.status {
        case .denied:
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
        case .notDetermined:
            switch item.id {
            case "contacts":       await nim.requestContactsAccess()
            case "location":       LocationManager.shared.requestAlwaysPermission()
            case "health":         await nim.requestHealthAccess()
            case "reminders":      await nim.requestRemindersAccess()
            case "music":          await nim.requestMusicAccess()
            case "notifications":  await nim.requestNotificationPermission(userId: appState.userId)
            default: break
            }
            capabilities = await nim.currentCapabilities()
        case .granted:
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
        }
    }

    // MARK: - Google Section

    private var googleConnector: Connector? {
        connectors.first(where: { $0.id == "google" })
    }

    private var googleSection: some View {
        IntegrationRow(
            iconSlug: "google",
            name: "Google",
            detail: googleDetail,
            isConnected: googleStatus == .connected,
            actionLabel: googleButtonLabel,
            isBusy: googleStatus == .connecting,
            action: handleGoogleAction
        )
    }

    private var googleButtonLabel: String {
        switch googleStatus {
        case .idle: return "Connect"
        case .connecting: return "Connecting"
        case .connected: return "Disable"
        case .needsReconnect: return "Reconnect"
        case .error: return "Retry"
        }
    }

    private var googleDetail: String {
        switch googleStatus {
        case .connected:
            return "GMAIL · CALENDAR · LINKED"
        case .needsReconnect:
            return "GMAIL · CALENDAR · NEEDS RECONNECT"
        case .connecting:
            return "GMAIL · CALENDAR · LINKING"
        default:
            return "GMAIL · CALENDAR"
        }
    }

    // MARK: - Integration Row

    private func integrationRow(_ connector: Connector) -> some View {
        IntegrationRow(
            iconSlug: connector.icon,
            name: connector.name,
            detail: connector.statusText.uppercased(),
            isConnected: connector.connectionState == "connected",
            actionLabel: connector.actionLabel,
            isBusy: false,
            action: { handleConnectorAction(connector) }
        )
    }

    // MARK: - Actions

    private func loadAll() async {
        async let connTask: Void = loadConnectors()
        async let capsTask = NativeIntegrationManager.shared.currentCapabilities()
        await connTask
        capabilities = await capsTask
    }

    private func loadConnectors() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/connectors/\(appState.userId)"
            )
            let response = try JSONDecoder().decode(ConnectorsResponse.self, from: data)
            await MainActor.run {
                connectors = response.connectors
                if let google = connectors.first(where: { $0.id == "google" }) {
                    googleStatus = GoogleStatus(connector: google)
                } else {
                    googleStatus = .idle
                }
                errorMessage = nil
                isLoading = false
                cardsVisible = false
                DispatchQueue.main.async {
                    cardsVisible = true
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                if googleStatus == .connecting {
                    googleStatus = .error
                }
                isLoading = false
                cardsVisible = true
            }
        }
    }

    private func connectGoogle() {
        googleStatus = .connecting
        Task {
            do {
                let data = try await APIClient.shared.request(
                    path: "/auth/google/start",
                    queryItems: [URLQueryItem(name: "userId", value: appState.userId)]
                )
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let urlStr = json["url"] as? String,
                   let url = URL(string: urlStr) {
                    await MainActor.run {
                        errorMessage = nil
                        UIApplication.shared.open(url)
                    }
                } else {
                    await MainActor.run {
                        googleStatus = .error
                        errorMessage = "Google connect failed."
                    }
                }
            } catch {
                await MainActor.run {
                    googleStatus = .error
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func handleGoogleAction() {
        guard let connector = googleConnector else {
            connectGoogle()
            return
        }
        if connector.enabled && connector.connectionState == "connected" {
            updateConnector(connector, enabled: false)
        } else {
            connectGoogle()
        }
    }

    private func handleConnectorAction(_ connector: Connector) {
        guard connector.implemented else { return }
        if connector.id == "google" && (!connector.enabled || connector.connectionState == "needs_reconnect") {
            connectGoogle()
            return
        }
        // OAuth connectors (GitHub, Microsoft) launch the browser flow when not
        // yet connected; once connected, the toggle disables them.
        if connector.usesOAuth {
            if connector.enabled && connector.connectionState == "connected" {
                updateConnector(connector, enabled: false)
            } else {
                connectOAuth(connector)
            }
            return
        }
        updateConnector(connector, enabled: !connector.enabled)
    }

    private func connectOAuth(_ connector: Connector) {
        oauthConnecting = true
        Task {
            do {
                let data = try await APIClient.shared.request(
                    path: "/auth/\(connector.id)/start",
                    queryItems: [URLQueryItem(name: "userId", value: appState.userId)]
                )
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let urlStr = json["url"] as? String,
                   let url = URL(string: urlStr) {
                    await MainActor.run {
                        errorMessage = nil
                        UIApplication.shared.open(url)
                    }
                } else {
                    await MainActor.run {
                        oauthConnecting = false
                        errorMessage = "\(connector.name) connect failed."
                    }
                }
            } catch {
                await MainActor.run {
                    oauthConnecting = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func updateConnector(_ connector: Connector, enabled: Bool) {
        Task {
            do {
                let _ = try await APIClient.shared.request(
                    path: "/connectors",
                    method: "POST",
                    body: [
                        "userId": appState.userId,
                        "connectorId": connector.id,
                        "enabled": enabled
                    ]
                )
                await MainActor.run {
                    if let idx = connectors.firstIndex(where: { $0.id == connector.id }) {
                        connectors[idx].enabled = enabled
                        connectors[idx].connectionState = enabled ? "connected" : "available"
                        connectors[idx].statusText = enabled ? "Connected" : "Available"
                        if connector.id == "google" {
                            googleStatus = enabled ? .connected : .idle
                        }
                        // A success note as a service comes online (softer tick when disabling).
                        if enabled { HapticManager.shared.success() } else { HapticManager.shared.impact(.soft) }
                        errorMessage = nil
                    }
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Native Capability Model

struct NativeCapabilityItem {
    enum Status { case granted, denied, notDetermined }

    let id: String
    let title: String
    let subtitle: String
    let systemImage: String
    let status: Status

    @MainActor static func all(from caps: NativeCapabilities) -> [NativeCapabilityItem] {
        let locStatus = LocationManager.shared.authorizationStatus
        let locCapStatus: Status = locStatus == .authorizedAlways || locStatus == .authorizedWhenInUse
            ? .granted : (locStatus == .denied || locStatus == .restricted ? .denied : .notDetermined)

        return [
            NativeCapabilityItem(
                id: "contacts",
                title: "Contacts",
                subtitle: "Message and call people by name",
                systemImage: "person.crop.circle",
                status: caps.contacts ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "location",
                title: "Location",
                subtitle: "Rides, directions, local context",
                systemImage: "location",
                status: locCapStatus
            ),
            NativeCapabilityItem(
                id: "health",
                title: "Health",
                subtitle: "Activity, heart rate, sleep",
                systemImage: "heart",
                status: caps.healthKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "reminders",
                title: "Reminders",
                subtitle: "Create and manage tasks",
                systemImage: "checklist",
                status: caps.reminders ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "music",
                title: "Music",
                subtitle: "Control Apple Music playback",
                systemImage: "music.note",
                status: caps.musicKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "notifications",
                title: "Notifications",
                subtitle: "Briefings and action alerts",
                systemImage: "bell",
                status: caps.notifications ? .granted : .notDetermined
            ),
        ]
    }
}

// MARK: - Native Capability Row

private struct NativeCapabilityRow: View {
    let item: NativeCapabilityItem
    let onAction: () async -> Void

    var body: some View {
        HStack(spacing: 14) {
            // A neutral system-glyph tile so device permissions sit in the same rhythm as
            // the branded app rows below.
            Image(systemName: item.systemImage)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(Color.mgHeading)
                .frame(width: 38, height: 38)
                .background(Color.mgOff.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 38 * 14 / 64, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 38 * 14 / 64, style: .continuous)
                        .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
                Text(item.subtitle)
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Color.mgSecondary)
            }

            Spacer()

            Button {
                Task { await onAction() }
            } label: {
                Text(statusLabel)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(statusColor)
            }
            .buttonStyle(.nmlScale)
        }
        .padding(.vertical, 18)
    }

    // Granted reads as a quiet "Connected" (#555); actionable states keep an
    // affordance verb in #888 so the permission can still be granted or fixed.
    private var statusLabel: String {
        switch item.status {
        case .granted:       return "Connected"
        case .denied:        return "Settings"
        case .notDetermined: return "Enable"
        }
    }

    private var statusColor: Color {
        item.status == .granted ? Color.mgCaption : Color.mgSecondary
    }
}

// MARK: - Integration Row

/// A flat row for a service — no icon tile, no card, no status dot. Just raw
/// typography: the name in white, a quiet detail line, and a text state on the
/// right. "Connected" reads muted (#555); when disconnected the right side keeps
/// an affordance verb (#888) so the row can still be acted on.
private struct IntegrationRow: View {
    let iconSlug: String
    let name: String
    let detail: String
    let isConnected: Bool
    let actionLabel: String
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            ConnectorIcon(slug: iconSlug, name: name)
            VStack(alignment: .leading, spacing: 5) {
                Text(name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
                Text(detail)
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Color.mgCaption)
            }

            Spacer()

            Button(action: action) {
                if isBusy {
                    ProgressView()
                        .scaleEffect(0.6)
                        .tint(Color.mgSecondary)
                } else {
                    Text(isConnected ? "Connected" : actionLabel)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(isConnected ? Color.mgCaption : Color.mgSecondary)
                }
            }
            .buttonStyle(.nmlScale)
            .disabled(isBusy)
        }
        .padding(.vertical, 18)
    }
}

// MARK: - Connector Icon

/// A 38pt brand tile for an app row. Renders the bundled self-contained brand asset
/// (a rounded tile with the logo baked in) when one exists for the slug; otherwise a
/// clean monogram chip so every row still reads as an app, never a blank gap. A faint
/// outline (pure black, low opacity) gives the tile a crisp edge on any surface.
private struct ConnectorIcon: View {
    let slug: String
    let name: String

    private var hasAsset: Bool { UIImage(named: slug) != nil }
    private let side: CGFloat = 38
    private var radius: CGFloat { side * 14 / 64 }  // iOS app-icon corner ratio (64→~14)

    // The few slugs with no App Store artwork (system apps like Apple Wallet) get a real
    // system glyph on a brand-appropriate tile — never a letter monogram.
    private var fallbackSymbol: String { slug == "wallet" ? "wallet.pass.fill" : "app.dashed" }
    private var fallbackDark: Bool { slug == "wallet" }

    var body: some View {
        Group {
            if hasAsset {
                Image(slug)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: fallbackSymbol)
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(fallbackDark ? .white : Color.mgHeading)
                    .frame(width: side, height: side)
                    .background(fallbackDark ? Color.black : Color.mgOff.opacity(0.5))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }
}

// MARK: - Models

struct Connector: Codable, Identifiable {
    let id: String
    let name: String
    let icon: String
    let category: String
    var enabled: Bool
    let implemented: Bool
    var connectionState: String
    var statusText: String
    /// "oauth" for connectors that authenticate via a browser OAuth flow
    /// (Google, GitHub, Microsoft); nil/"" for toggle-only connectors.
    let auth: String

    enum CodingKeys: String, CodingKey {
        case id, name, icon, category, enabled, implemented, connectionState, statusText, auth
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "🔌"
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "Other"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        implemented = try c.decodeIfPresent(Bool.self, forKey: .implemented) ?? false
        connectionState = try c.decodeIfPresent(String.self, forKey: .connectionState) ?? (enabled ? "connected" : "available")
        statusText = try c.decodeIfPresent(String.self, forKey: .statusText) ?? (enabled ? "Connected" : "Available")
        auth = try c.decodeIfPresent(String.self, forKey: .auth) ?? ""
    }

    var usesOAuth: Bool { auth == "oauth" }

    var actionLabel: String {
        if connectionState == "needs_reconnect" { return "Reconnect" }
        if connectionState == "needs_setup" { return "Setup" }
        if connectionState == "degraded" { return enabled ? "Enabled" : "Enable" }
        return enabled ? "Disconnect" : "Connect"
    }
}

private extension ConnectorsView.GoogleStatus {
    init(connector: Connector) {
        if connector.connectionState == "needs_reconnect" {
            self = .needsReconnect
        } else if connector.enabled {
            self = .connected
        } else {
            self = .idle
        }
    }
}

struct ConnectorsResponse: Codable {
    let connectors: [Connector]
}

#Preview {
    ConnectorsView()
        .environment(AppState())
}
