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
    @State private var cardsVisible = false

    enum GoogleStatus: String {
        case idle, connecting, connected, needsReconnect, error
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if isLoading {
                    VStack(spacing: 12) {
                        OxySkeletonCard(height: 92)
                        OxySkeletonCard(height: 148)
                        OxySkeletonCard(height: 148)
                    }
                    .padding(16)
                } else {
                    ScrollView {
                        VStack(spacing: 24) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Google section
                            googleSection
                                .opacity(cardsVisible ? 1 : 0)
                                .offset(y: cardsVisible ? 0 : 18)
                                .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.02), value: cardsVisible)

                            // Consumer-friendly grouping: Real smarts vs Quick opens (easiest thing ever)
                            let nonGoogle = connectors.filter { $0.id != "google" && $0.implemented }
                            let realActions = nonGoogle.filter { $0.type == "api" || $0.type == nil }
                            let quickOpens = nonGoogle.filter { $0.type == "handoff" || $0.type == "hybrid" }

                            // Show "Oxy can do this for you" first (real actions), then "Quick opens" (super easy handoffs)
                            if !realActions.isEmpty {
                                connectorSection(title: "I can handle for you", connectors: realActions)
                            }
                            if !quickOpens.isEmpty {
                                connectorSection(title: "Quick opens (I pre-fill everything)", connectors: quickOpens)
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

    private var googleConnector: Connector? {
        connectors.first(where: { $0.id == "google" })
    }

    private var googleSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Google")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)

            HStack(spacing: 14) {
                AppIconView(candidates: [googleConnector?.icon ?? "", "google"], fallbackSystemName: "envelope.fill")
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

                Button(action: handleGoogleAction) {
                    ConnectorPill(
                        label: googleButtonLabel,
                        tint: googleStatus == .connected ? Color.oxySub : Color.oxyText,
                        isBusy: googleStatus == .connecting
                    )
                }
                .disabled(googleStatus == .connecting)
            }
            .padding(14)
        }
    }

    private var googleButtonLabel: String {
        switch googleStatus {
        case .idle: return "Connect"
        case .connecting: return "Connecting…"
        case .connected: return "Disable"
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
                ForEach(Array(connectors.enumerated()), id: \.element.id) { index, connector in
                    ConnectorCard(
                        connector: connector,
                        onAction: { handleConnectorAction(connector) }
                    )
                    .opacity(cardsVisible ? 1 : 0)
                    .offset(y: cardsVisible ? 0 : 22)
                    .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(Double(index) * 0.08), value: cardsVisible)
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
        .overlay(alignment: .topTrailing) {
            if connector.enabled {
                ConnectorCheckmark()
                    .padding(10)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let t = connector.type, t != "api" {
                Text(t == "handoff" ? "Opens app" : "Hybrid")
                    .font(.system(size: 9, weight: .medium))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Color.oxyStone.opacity(0.15))
                    .foregroundStyle(Color.oxyStone)
                    .clipShape(Capsule())
                    .padding(.leading, 8)
                    .padding(.bottom, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .opacity(connector.implemented ? 1.0 : 0.45)
    }
}

private struct ConnectorCheckmark: View {
    @State private var isDrawn = false

    var body: some View {
        Circle()
            .fill(Color.oxyGreen)
            .frame(width: 18, height: 18)
            .overlay {
                CheckmarkShape()
                    .trim(from: 0, to: isDrawn ? 1 : 0)
                    .stroke(Color.oxyOnAccent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .frame(width: 8, height: 7)
            }
            .scaleEffect(isDrawn ? 1 : 0.72)
            .onAppear { isDrawn = true }
            .animation(.easeOut(duration: 0.25), value: isDrawn)
    }
}

private struct CheckmarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX * 0.82, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

private struct ConnectorPill: View {
    let label: String
    let tint: Color
    let isBusy: Bool

    // No fill, no border, no pill shape — tracked-out uppercase type carries the
    // affordance per the pure-black minimalist directive.
    var body: some View {
        HStack(spacing: 6) {
            if isBusy {
                ProgressView()
                    .scaleEffect(0.65)
                    .tint(tint)
            }
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1.2)
                .textCase(.uppercase)
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }
}

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

    enum CodingKeys: String, CodingKey {
        case id, name, icon, category, enabled, implemented, connectionState, statusText, type
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
    }

    var actionLabel: String {
        if connectionState == "needs_reconnect" { return "Reconnect" }
        if connectionState == "needs_setup" { return "Setup" }
        if connectionState == "degraded" { return enabled ? "Enabled" : "Enable" }
        return enabled ? "Disconnect" : "Connect"
    }

    var actionTint: Color {
        if !implemented { return Color.oxyDim }
        if connectionState == "needs_reconnect" || connectionState == "needs_setup" || connectionState == "degraded" { return Color.oxyStone }
        return enabled ? Color.oxySub : Color.oxyText
    }

    var statusColor: Color {
        switch connectionState {
        case "connected": return Color.oxyGreen
        case "needs_reconnect", "needs_setup", "degraded": return Color.oxyStone
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
