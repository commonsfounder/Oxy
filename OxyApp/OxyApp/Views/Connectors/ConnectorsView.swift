import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ConnectorsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var connectors: [Connector] = []
    @State private var isLoading = true
    // Keyed by connector id — both Google and Microsoft go through the same
    // browser-redirect OAuth dance, so they share this rather than each getting their own
    // single-value state var (which is how Google alone used to work here).
    @State private var oauthStatus: [String: OAuthStatus] = [:]
    @State private var errorMessage: String?

    private let oauthProviders: Set<String> = ["google", "microsoft"]

    enum OAuthStatus: String {
        case idle, connecting, connected, needsReconnect, error
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Connections", onBack: { dismiss() })

                    if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 92)
                            OxySkeletonCard(height: 148)
                            OxySkeletonCard(height: 148)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage)
                                }

                                // Every remaining connector is a genuine account connection
                                // (kind == "connection"), so there's just Connected/Available —
                                // no handoff/hybrid items land on this screen anymore.
                                let connectedRows = connectors.filter { $0.enabled }
                                let availableRows = connectors.filter { $0.implemented && !$0.enabled }

                                if !connectedRows.isEmpty {
                                    section(title: "Connected", connectors: connectedRows)
                                }
                                if !availableRows.isEmpty {
                                    section(title: "Available", connectors: availableRows)
                                }
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await loadConnectors()
            }
            .refreshable {
                await loadConnectors()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && oauthProviders.contains(where: { oauthStatus[$0] == .connecting }) {
                    Task { await loadConnectors() }
                }
            }
        }
    }

    // MARK: - Sections

    private func section(title: String, connectors: [Connector]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: title)
                .padding(.bottom, 12)

            VStack(spacing: 0) {
                ForEach(Array(connectors.enumerated()), id: \.element.id) { index, connector in
                    connectorRow(connector)
                    if index < connectors.count - 1 {
                        AppDivider()
                    }
                }
            }
        }
    }

    // MARK: - Row

    private func connectorRow(_ connector: Connector) -> some View {
        HStack(spacing: 14) {
            AppIconView(candidates: [connector.icon, connector.id], fallbackSystemName: sfSymbol(connector.id))
                .frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 9))

            VStack(alignment: .leading, spacing: 2) {
                Text(connector.name)
                    .font(.rowTitle)
                    .foregroundStyle(Color.appInk)

                Text(capabilityCaption(connector))
                    .font(.rowSecondary)
                    .foregroundStyle(Color.appMuted)
            }

            Spacer(minLength: 8)

            trailingControl(connector)
        }
        .padding(.vertical, 14)
        .frame(minHeight: 44)
        .opacity(connector.implemented ? 1.0 : 0.45)
    }

    private func capabilityCaption(_ connector: Connector) -> String {
        if connector.id == "google" { return "Gmail · Calendar" }
        if connector.id == "microsoft" { return "Outlook · Calendar" }
        return connector.category
    }

    @ViewBuilder
    private func trailingControl(_ connector: Connector) -> some View {
        if oauthProviders.contains(connector.id) && oauthStatus[connector.id] == .connecting {
            ProgressView()
                .scaleEffect(0.65)
                .tint(Color.appMuted)
        } else if connector.enabled {
            Button {
                handleConnectorAction(connector)
            } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.appAccent)
                        .frame(width: 6, height: 6)
                    Text("Connected")
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                }
            }
            .disabled(!connector.implemented)
            .buttonStyle(.appScale(0.97))
        } else if connector.connectionState == "needs_reconnect" {
            Button {
                if oauthProviders.contains(connector.id) {
                    connectOAuth(providerId: connector.id)
                } else {
                    handleConnectorAction(connector)
                }
            } label: {
                Text("Reconnect")
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(Color.appAccent)
            }
            .disabled(!connector.implemented)
            .buttonStyle(.appScale(0.97))
        } else {
            Button {
                handleConnectorAction(connector)
            } label: {
                Text("Connect")
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
            }
            .disabled(!connector.implemented)
            .buttonStyle(.appScale(0.97))
        }
    }

    private func sfSymbol(_ id: String) -> String {
        switch id {
        case "google":    return "envelope.fill"
        case "microsoft": return "envelope.fill"
        case "imessage":  return "message.fill"
        case "whatsapp":  return "phone.fill"
        case "spotify":   return "music.note"
        case "reminders": return "checklist"
        case "deliveroo": return "takeoutbag.and.cup.and.straw.fill"
        case "uber":      return "car.fill"
        case "telegram":  return "paperplane.fill"
        case "monzo":     return "banknote.fill"
        case "homekit":   return "house.fill"
        case "trainline": return "tram.fill"
        case "maps":      return "map.fill"
        case "notion":    return "doc.text.fill"
        case "betfair":   return "chart.line.uptrend.xyaxis"
        case "netflix":   return "play.tv.fill"
        default:          return "puzzlepiece.fill"
        }
    }

    // MARK: - Actions

    private func loadConnectors() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/connectors/\(appState.userId)"
            )
            let response = try JSONDecoder().decode(ConnectorsResponse.self, from: data)
            await MainActor.run {
                // Only genuine external-account connections belong here — a functionality
                // (server-side API key, deep-link handoff, in-app plumbing) has no account to
                // connect and just works when invoked from chat.
                connectors = response.connectors.filter { $0.kind == "connection" }
                for providerId in oauthProviders {
                    if let provider = connectors.first(where: { $0.id == providerId }) {
                        oauthStatus[providerId] = OAuthStatus(connector: provider)
                    } else {
                        oauthStatus[providerId] = .idle
                    }
                }
                errorMessage = nil
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                for providerId in oauthProviders where oauthStatus[providerId] == .connecting {
                    oauthStatus[providerId] = .error
                }
                isLoading = false
            }
        }
    }

    private func oauthStartPath(for providerId: String) -> String {
        providerId == "microsoft" ? "/auth/microsoft/start" : "/auth/google/start"
    }

    private func connectOAuth(providerId: String) {
        oauthStatus[providerId] = .connecting
        Task {
            do {
                let data = try await APIClient.shared.request(
                    path: oauthStartPath(for: providerId),
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
                        oauthStatus[providerId] = .error
                        errorMessage = "Connect failed."
                    }
                }
            } catch {
                await MainActor.run {
                    oauthStatus[providerId] = .error
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func handleConnectorAction(_ connector: Connector) {
        guard connector.implemented else { return }
        if oauthProviders.contains(connector.id) && (!connector.enabled || connector.connectionState == "needs_reconnect") {
            connectOAuth(providerId: connector.id)
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
                        if oauthProviders.contains(connector.id) {
                            oauthStatus[connector.id] = enabled ? .connected : .idle
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

// MARK: - AppIconView

private struct AppIconView: View {
    let candidates: [String]
    let fallbackSystemName: String

    var body: some View {
        Group {
            if let img = firstAssetImage(from: candidates) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
            } else if let url = firstURL(from: candidates) {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        brandFallback
                    }
                }
            } else if let emoji = firstEmoji(from: candidates) {
                Text(emoji)
                    .font(.system(size: 20))
            } else {
                brandFallback
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var brandFallback: some View {
        let brand = brandStyle
        return ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(brand.background)
            if let text = brand.text {
                Text(text)
                    .font(.system(size: brand.fontSize, weight: .bold))
                    .foregroundStyle(brand.foreground)
                    .minimumScaleFactor(0.55)
                    .lineLimit(1)
                    .padding(.horizontal, 4)
            } else {
                Image(systemName: fallbackSystemName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(brand.foreground)
            }
        }
    }

    private var brandStyle: (text: String?, background: Color, foreground: Color, fontSize: CGFloat) {
        let names = candidates.map { $0.lowercased() }
        if names.contains("uber") { return ("Uber", .black, .white, 12) }
        if names.contains("ubereats") { return ("Eats", .black, Color(red: 6/255, green: 193/255, blue: 103/255), 11) }
        if names.contains("google") { return ("G", .white, Color(red: 66/255, green: 133/255, blue: 244/255), 21) }
        if names.contains("maps") { return (nil, Color(red: 66/255, green: 133/255, blue: 244/255), .white, 17) }
        if names.contains("telegram") { return (nil, Color(red: 42/255, green: 171/255, blue: 238/255), .white, 17) }
        if names.contains("trainline") { return ("TL", Color(red: 0/255, green: 169/255, blue: 126/255), .white, 15) }
        if names.contains("deliveroo") { return ("D", Color(red: 0/255, green: 204/255, blue: 188/255), .white, 19) }
        if names.contains("netflix") { return ("N", .black, Color(red: 229/255, green: 9/255, blue: 20/255), 21) }
        return (nil, Color.oxySurface3, Color.oxySub, 17)
    }

    private func firstURL(from candidates: [String]) -> URL? {
        for name in candidates {
            if name.lowercased().hasPrefix("http"), let url = URL(string: name) {
                return url
            }
        }
        return nil
    }

    private func firstAssetImage(from candidates: [String]) -> UIImage? {
        #if canImport(UIKit)
        for name in candidates where !name.isEmpty {
            if let img = UIImage(named: name) { return img }
        }
        #endif
        return nil
    }

    private func firstEmoji(from candidates: [String]) -> String? {
        candidates.first { candidate in
            candidate.unicodeScalars.contains { $0.properties.isEmojiPresentation }
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
    let type: String?   // 'api' | 'handoff' | 'hybrid'
    let kind: String?   // 'connection' | 'functionality' — only 'connection' belongs on this screen

    enum CodingKeys: String, CodingKey {
        case id, name, icon, category, enabled, implemented, connectionState, statusText, type, kind
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
        type = try c.decodeIfPresent(String.self, forKey: .type)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
    }
}

private extension ConnectorsView.OAuthStatus {
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
