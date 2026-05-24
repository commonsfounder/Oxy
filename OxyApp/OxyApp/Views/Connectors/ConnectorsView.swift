import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ConnectorsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @State private var connectors: [Connector] = []
    @State private var isLoading = true
    @State private var googleStatus: GoogleStatus = .idle
    @State private var errorMessage: String?

    enum GoogleStatus: String {
        case idle, connecting, connected, needsReconnect, error
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .tint(Color.oxyStone)
                } else {
                    ScrollView {
                        VStack(spacing: 24) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Google section
                            googleSection

                            // Grouped connectors
                            let nonGoogle = connectors.filter { $0.id != "google" && $0.implemented }
                            let grouped = Dictionary(grouping: nonGoogle) { $0.category }

                            ForEach(grouped.keys.sorted(), id: \.self) { category in
                                if let items = grouped[category] {
                                    connectorSection(title: category, connectors: items)
                                }
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .navigationTitle("Connectors")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task {
                await loadConnectors()
            }
            .refreshable {
                await loadConnectors()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && googleStatus == .connecting {
                    Task { await loadConnectors() }
                }
            }
        }
    }

    // MARK: - Google Section

    private var googleSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Google")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)

            HStack(spacing: 14) {
                AppIconView(candidates: [connectors.first(where: { $0.id == "google" })?.icon ?? "", "google"], fallbackSystemName: "envelope.fill")
                    .frame(width: 44, height: 44)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Google")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.oxyText)

                    Text(googleSubtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.oxySub)
                }

                Spacer()

                Button(action: connectGoogle) {
                    ConnectorPill(
                        label: googleButtonLabel,
                        tint: googleStatus == .connected ? Color.oxyGreen : Color.oxyStone,
                        isBusy: googleStatus == .connecting
                    )
                }
                .disabled(googleStatus == .connecting || googleStatus == .connected)
            }
            .padding(14)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
        }
    }

    private var googleButtonLabel: String {
        switch googleStatus {
        case .idle: return "Connect"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .needsReconnect: return "Reconnect"
        case .error: return "Retry"
        }
    }

    private var googleSubtitle: String {
        switch googleStatus {
        case .connected:
            return "Gmail · Calendar · Connected"
        case .needsReconnect:
            return "Gmail · Calendar · Reconnect needed"
        default:
            return "Gmail · Calendar"
        }
    }

    // MARK: - Connector Section

    private func connectorSection(title: String, connectors: [Connector]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: 12) {
                ForEach(connectors) { connector in
                    ConnectorCard(
                        connector: connector,
                        onAction: { handleConnectorAction(connector) }
                    )
                }
            }
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
                connectors = response.connectors
                if let google = connectors.first(where: { $0.id == "google" }) {
                    googleStatus = GoogleStatus(connector: google)
                } else {
                    googleStatus = .idle
                }
                errorMessage = nil
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                if googleStatus == .connecting {
                    googleStatus = .error
                }
                isLoading = false
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

// MARK: - Connector Card

private struct ConnectorCard: View {
    let connector: Connector
    let onAction: () -> Void

    private var sfSymbol: String {
        switch connector.id {
        case "google":    return "envelope.fill"
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

    var body: some View {
        VStack(spacing: 12) {
            AppIconView(candidates: [connector.icon, connector.id], fallbackSystemName: sfSymbol)
                .frame(width: 44, height: 44)

            VStack(spacing: 2) {
                Text(connector.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                    .lineLimit(1)

                Text(connector.statusText)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(connector.statusColor)
            }

            Button(action: onAction) {
                ConnectorPill(label: connector.actionLabel, tint: connector.actionTint, isBusy: false)
            }
            .disabled(!connector.implemented)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(Color.oxySurface2)
        .opacity(connector.implemented ? 1.0 : 0.45)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }
}

private struct ConnectorPill: View {
    let label: String
    let tint: Color
    let isBusy: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isBusy {
                ProgressView()
                    .scaleEffect(0.65)
                    .tint(tint)
            }
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(tint.opacity(0.12))
        .clipShape(Capsule())
        .overlay(
            Capsule()
                .stroke(tint.opacity(0.28), lineWidth: 1)
        )
    }
}

private struct AppIconView: View {
    let candidates: [String]
    let fallbackSystemName: String

    var body: some View {
        ZStack {
            if let url = firstURL(from: candidates) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        fallback
                    }
                }
            } else if let img = firstAssetImage(from: candidates) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
            } else if let emoji = firstEmoji(from: candidates) {
                Text(emoji)
                    .font(.system(size: 20))
            } else {
                fallback
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.oxySurface3)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }

    private var fallback: some View {
        Image(systemName: fallbackSystemName)
            .font(.system(size: 17))
            .foregroundStyle(Color.oxySub)
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
        return enabled ? "Disconnect" : "Connect"
    }

    var actionTint: Color {
        if !implemented { return Color.oxyDim }
        if connectionState == "needs_reconnect" { return Color.oxyStone }
        return enabled ? Color.oxySub : Color.oxyGreen
    }

    var statusColor: Color {
        switch connectionState {
        case "connected": return Color.oxyGreen
        case "needs_reconnect": return Color.oxyStone
        default: return Color.oxySub
        }
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
