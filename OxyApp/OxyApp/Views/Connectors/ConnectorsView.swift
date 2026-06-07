import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Connector IDs that are not yet meaningfully integrated
private let hiddenConnectorIDs: Set<String> = ["netflix", "deliveroo", "trainline", "ubereats", "uber_eats"]

struct ConnectorsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectors: [Connector] = []
    @State private var isLoading = true
    @State private var googleStatus: GoogleStatus = .idle
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

                if isLoading {
                    VStack(spacing: 14) {
                        OxySkeletonCard(height: 120)
                        OxySkeletonCard(height: 180)
                        OxySkeletonCard(height: 180)
                    }
                    .padding(20)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 40) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Device — native OS permissions, kept distinct from
                            // third-party services since they govern what the
                            // pendant itself is allowed to sense and use.
                            if let caps = capabilities {
                                sectionHeader("On This Device", caption: "Permissions the device itself relies on")
                                deviceSection(caps)
                                    .opacity(cardsVisible ? 1 : 0)
                                    .offset(y: cardsVisible ? 0 : 18)
                                    .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.0), value: cardsVisible)
                            }

                            // Third-party integrations
                            VStack(alignment: .leading, spacing: 28) {
                                sectionHeader("Integrations", caption: "Services connected to your account")

                                googleSection
                                    .opacity(cardsVisible ? 1 : 0)
                                    .offset(y: cardsVisible ? 0 : 18)
                                    .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.06), value: cardsVisible)

                                let visible = connectors.filter { $0.implemented && !hiddenConnectorIDs.contains($0.id) }
                                let others = visible.filter { $0.id != "google" }

                                if !others.isEmpty {
                                    integrationList(others)
                                        .opacity(cardsVisible ? 1 : 0)
                                        .offset(y: cardsVisible ? 0 : 18)
                                        .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.12), value: cardsVisible)
                                }
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                        .padding(.bottom, 40)
                    }
                }
            }
            .navigationTitle("Connectors")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.nmlObsidian, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.nmlMuted)
                            .frame(width: 30, height: 30)
                            .overlay(Circle().strokeBorder(Color.nmlHairline, lineWidth: 0.5))
                    }
                }
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
                        if googleStatus == .connecting { await loadConnectors() }
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

    // MARK: - Section header

    /// An eyebrow + quiet caption pairing — replaces the old all-caps section
    /// label with something that reads like a masthead, not a settings group.
    private func sectionHeader(_ title: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .nmlEyebrow()
            Text(caption)
                .font(.system(size: 13, weight: .light))
                .foregroundStyle(Color.nmlMuted)
        }
    }

    // MARK: - Device Section

    private func deviceSection(_ caps: NativeCapabilities) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(NativeCapabilityItem.all(from: caps).enumerated()), id: \.element.id) { index, item in
                NativeCapabilityRow(item: item) {
                    await handleNativeAction(item)
                }
                if index != NativeCapabilityItem.all(from: caps).count - 1 {
                    Rectangle()
                        .fill(Color.nmlHairline)
                        .frame(height: 0.5)
                        .padding(.leading, 64)
                }
            }
        }
        .background(Color.nmlSurface)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
        )
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
            symbolName: "envelope.fill",
            tint: Color(red: 66 / 255, green: 133 / 255, blue: 244 / 255),
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

    // MARK: - Integrations List

    /// A single spacious, hairline-bordered list — replaces the old card grid.
    /// Each row carries its own quiet glowing-dot indicator and monospace detail.
    private func integrationList(_ items: [Connector]) -> some View {
        VStack(spacing: 12) {
            ForEach(items) { connector in
                IntegrationRow(
                    symbolName: IntegrationRow.symbol(for: connector.id),
                    tint: IntegrationRow.tint(for: connector.id),
                    name: connector.name,
                    detail: connector.statusText.uppercased(),
                    isConnected: connector.connectionState == "connected",
                    actionLabel: connector.actionLabel,
                    isBusy: false,
                    action: { handleConnectorAction(connector) }
                )
            }
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
        updateConnector(connector, enabled: !connector.enabled)
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

    var body: some View {
        HStack(spacing: 16) {
            NamelessStatusDot(isLive: item.status == .granted)

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
                    .font(.nmlMono(11, weight: .medium))
                    .tracking(1.2)
                    .foregroundStyle(Color.nmlTitanium)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
    }

    private var statusLabel: String {
        switch item.status {
        case .granted:       return "ENABLED"
        case .denied:        return "SETTINGS"
        case .notDetermined: return "ENABLE"
        }
    }
}

// MARK: - Integration Row

/// A single spacious, hairline-bordered row for a connected service: real SF
/// Symbol on a brand-tinted ground, name, monospace status detail, a quiet
/// glowing dot in place of a loud "Active" badge, and a plain-text action —
/// no filled pill buttons, nothing that shouts.
private struct IntegrationRow: View {
    let symbolName: String
    let tint: Color
    let name: String
    let detail: String
    let isConnected: Bool
    let actionLabel: String
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(tint.opacity(0.14))
                Image(systemName: symbolName)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(tint)
            }
            .frame(width: 46, height: 46)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.nmlHairline, lineWidth: 0.5))

            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                Text(detail)
                    .font(.nmlMono(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(Color.nmlMuted)
            }

            Spacer()

            NamelessStatusDot(isLive: isConnected, diameter: 5)

            Button(action: action) {
                if isBusy {
                    ProgressView()
                        .scaleEffect(0.6)
                        .tint(Color.nmlMuted)
                } else {
                    Text(actionLabel.uppercased())
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1.2)
                        .foregroundStyle(Color.nmlTitanium)
                }
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
        }
        .padding(20)
        .background(Color.nmlSurface)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.nmlHairline, lineWidth: 0.5))
    }

    static func symbol(for connectorID: String) -> String {
        switch connectorID {
        case "google":    return "envelope.fill"
        case "imessage":  return "message.fill"
        case "whatsapp":  return "phone.fill"
        case "spotify":   return "music.note"
        case "reminders": return "checklist"
        case "telegram":  return "paperplane.fill"
        case "monzo":     return "banknote.fill"
        case "homekit":   return "house.fill"
        case "maps":      return "map.fill"
        case "notion":    return "doc.text.fill"
        case "betfair":   return "chart.line.uptrend.xyaxis"
        case "uber":      return "car.fill"
        default:          return "puzzlepiece.fill"
        }
    }

    static func tint(for connectorID: String) -> Color {
        switch connectorID {
        case "google":    return Color(red: 66 / 255, green: 133 / 255, blue: 244 / 255)
        case "imessage":  return Color(red: 76 / 255, green: 175 / 255, blue: 130 / 255)
        case "whatsapp":  return Color(red: 76 / 255, green: 217 / 255, blue: 100 / 255)
        case "spotify":   return Color(red: 30 / 255, green: 215 / 255, blue: 96 / 255)
        case "telegram":  return Color(red: 42 / 255, green: 171 / 255, blue: 238 / 255)
        case "monzo":     return Color(red: 255 / 255, green: 82 / 255, blue: 105 / 255)
        case "homekit":   return Color(red: 255 / 255, green: 159 / 255, blue: 10 / 255)
        case "maps":      return Color(red: 66 / 255, green: 133 / 255, blue: 244 / 255)
        case "betfair":   return Color(red: 255 / 255, green: 178 / 255, blue: 0 / 255)
        default:          return Color.nmlTitanium
        }
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

    enum CodingKeys: String, CodingKey {
        case id, name, icon, category, enabled, implemented, connectionState, statusText
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
    }

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
