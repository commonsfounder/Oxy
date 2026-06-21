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
                Color.nmlObsidian.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Connectors", onBack: { dismiss() })

                if isLoading {
                    VStack(spacing: 0) {
                        ForEach(0..<6, id: \.self) { _ in
                            OxySkeletonCard(height: 56, cornerRadius: 0)
                            NamelessDivider()
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 44) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Device — native OS permissions, kept distinct from
                            // third-party services since they govern what the
                            // pendant itself is allowed to sense and use.
                            if let caps = capabilities {
                                VStack(alignment: .leading, spacing: 4) {
                                    NamelessSectionHeader(title: "On This Device")
                                        .padding(.bottom, 12)
                                    deviceSection(caps)
                                }
                                .opacity(cardsVisible ? 1 : 0)
                                .offset(y: cardsVisible ? 0 : 18)
                                .animation(.nmlSpring.delay(0.0), value: cardsVisible)
                            }

                            // Third-party integrations
                            VStack(alignment: .leading, spacing: 4) {
                                NamelessSectionHeader(title: "Integrations")
                                    .padding(.bottom, 12)

                                let visible = connectors.filter { $0.implemented && !hiddenConnectorIDs.contains($0.id) }
                                let others = visible.filter { $0.id != "google" }

                                googleSection
                                if !others.isEmpty {
                                    ForEach(others) { connector in
                                        NamelessDivider()
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
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.startLocation.x < 60, value.translation.width > 80 {
                            dismiss()
                        }
                    }
            )
        }
    }

    // MARK: - Device Section

    private func deviceSection(_ caps: NativeCapabilities) -> some View {
        let items = NativeCapabilityItem.all(from: caps)
        return VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index != 0 { NamelessDivider() }
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
            name: "Google",
            detail: googleDetail,
            dotKind: googleDotKind,
            actionLabel: googleButtonLabel,
            isBusy: googleStatus == .connecting,
            action: handleGoogleAction
        )
    }

    private var googleDotKind: NamelessStatusDot.Kind {
        switch googleStatus {
        case .connected:      return .enabled
        case .needsReconnect: return .degraded
        case .error:          return .error
        case .idle, .connecting: return .off
        }
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
            name: connector.name,
            detail: connector.statusText.uppercased(),
            dotKind: connectorDotKind(connector),
            actionLabel: connector.actionLabel,
            isBusy: false,
            action: { handleConnectorAction(connector) }
        )
    }

    private func connectorDotKind(_ connector: Connector) -> NamelessStatusDot.Kind {
        switch connector.connectionState {
        case "connected":                   return .enabled
        case "needs_reconnect", "degraded", "needs_setup": return .degraded
        case "error":                       return .error
        default:                            return .off
        }
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
                status: caps.contacts ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "location",
                title: "Location",
                subtitle: "Rides, directions, local context",
                status: locCapStatus
            ),
            NativeCapabilityItem(
                id: "health",
                title: "Health",
                subtitle: "Activity, heart rate, sleep",
                status: caps.healthKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "reminders",
                title: "Reminders",
                subtitle: "Create and manage tasks",
                status: caps.reminders ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "music",
                title: "Music",
                subtitle: "Control Apple Music playback",
                status: caps.musicKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "notifications",
                title: "Notifications",
                subtitle: "Briefings and action alerts",
                status: caps.notifications ? .granted : .notDetermined
            ),
        ]
    }
}

// MARK: - Native Capability Row

private struct NativeCapabilityRow: View {
    let item: NativeCapabilityItem
    let onAction: () async -> Void

    private var dotKind: NamelessStatusDot.Kind {
        switch item.status {
        case .granted:       return .enabled
        case .denied:        return .error
        case .notDetermined: return .off
        }
    }

    var body: some View {
        HStack(spacing: 16) {
            NamelessStatusDot(kind: dotKind)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Text(item.subtitle)
                    .font(.system(size: 12, weight: .light))
                    .foregroundStyle(Color.nmlMuted)
            }

            Spacer()

            Button {
                Task { await onAction() }
            } label: {
                Text(statusLabel)
                    .font(.nmlBody(12, weight: .semibold))
                    .tracking(0.3)
                    .foregroundStyle(Color.nmlTitanium)
            }
            .buttonStyle(.nmlScale)
        }
        .padding(.vertical, 18)
    }

    private var statusLabel: String {
        switch item.status {
        case .granted:       return "Enabled"
        case .denied:        return "Settings"
        case .notDetermined: return "Enable"
        }
    }
}

// MARK: - Integration Row

/// A flat row for a connected service — no icon tile, no card. Just raw
/// typography: the name in clean white, monospace status detail beneath, a
/// quiet glowing dot for connection, and a plain tracked-out text action.
private struct IntegrationRow: View {
    let name: String
    let detail: String
    let dotKind: NamelessStatusDot.Kind
    let actionLabel: String
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(name)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Text(detail)
                    .font(.nmlBody(12, weight: .regular))
                    .foregroundStyle(Color.nmlMuted)
            }

            Spacer()

            NamelessStatusDot(kind: dotKind, diameter: 5)

            Button(action: action) {
                if isBusy {
                    ProgressView()
                        .scaleEffect(0.6)
                        .tint(Color.nmlMuted)
                } else {
                    // Destructive actions (Disconnect / Disable) read in coral so they're
                    // visually distinct from the neutral Connect / Reconnect affordances.
                    let isDestructive = ["DISCONNECT", "DISABLE"].contains(actionLabel.uppercased())
                    Text(actionLabel.uppercased())
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1.2)
                        .foregroundStyle(isDestructive ? Color.nmlDanger : Color.nmlTitanium)
                }
            }
            .buttonStyle(.nmlScale)
            .disabled(isBusy)
        }
        .padding(.vertical, 18)
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
