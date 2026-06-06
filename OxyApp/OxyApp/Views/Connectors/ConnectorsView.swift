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

                            // On This Device — native OS permissions
                            if let caps = capabilities {
                                nativeSection(caps)
                                    .opacity(cardsVisible ? 1 : 0)
                                    .offset(y: cardsVisible ? 0 : 18)
                                    .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.0), value: cardsVisible)
                            }

                            // Google section
                            googleSection
                                .opacity(cardsVisible ? 1 : 0)
                                .offset(y: cardsVisible ? 0 : 18)
                                .animation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.06), value: cardsVisible)

                            // Grouped connectors (filtering out unimplemented/hidden)
                            let visible = connectors.filter { $0.implemented && !hiddenConnectorIDs.contains($0.id) }
                            let grouped = Dictionary(grouping: visible.filter { $0.id != "google" }) { $0.category }

                            ForEach(grouped.keys.sorted(), id: \.self) { category in
                                if let items = grouped[category] {
                                    connectorSection(title: category, connectors: items)
                                }
                            }
                        }
                        .padding(16)
                        .padding(.bottom, 24)
                    }
                }
            }
            .navigationTitle("Connectors")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.oxySub)
                            .frame(width: 30, height: 30)
                            .background(Color.oxySurface2)
                            .clipShape(Circle())
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

    // MARK: - Native Section

    private func nativeSection(_ caps: NativeCapabilities) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("On This Device")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.oxySub)
                .textCase(.uppercase)
                .tracking(0.5)

            VStack(spacing: 0) {
                ForEach(NativeCapabilityItem.all(from: caps), id: \.id) { item in
                    NativeCapabilityRow(item: item) {
                        await handleNativeAction(item)
                    }
                    if item.id != NativeCapabilityItem.all(from: caps).last?.id {
                        Divider()
                            .overlay(Color.oxyLine)
                            .padding(.leading, 56)
                    }
                }
            }
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
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
                        tint: googleStatus == .connected ? Color.oxySub : Color.oxyStone,
                        isBusy: googleStatus == .connecting
                    )
                }
                .disabled(googleStatus == .connecting)
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
    let icon: String
    let iconTint: Color
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
                icon: "person.2.fill",
                iconTint: Color(red: 0.27, green: 0.53, blue: 0.99),
                title: "Contacts",
                subtitle: "Message and call people by name",
                status: caps.contacts ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "location",
                icon: "location.fill",
                iconTint: Color(red: 0.0, green: 0.68, blue: 0.36),
                title: "Location",
                subtitle: "Rides, directions, local context",
                status: locCapStatus
            ),
            NativeCapabilityItem(
                id: "health",
                icon: "heart.fill",
                iconTint: Color(red: 0.99, green: 0.25, blue: 0.33),
                title: "Health",
                subtitle: "Activity, heart rate, sleep",
                status: caps.healthKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "reminders",
                icon: "checklist",
                iconTint: Color(red: 1.0, green: 0.58, blue: 0.0),
                title: "Reminders",
                subtitle: "Create and manage tasks",
                status: caps.reminders ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "music",
                icon: "music.note",
                iconTint: Color(red: 0.99, green: 0.23, blue: 0.41),
                title: "Music",
                subtitle: "Control Apple Music playback",
                status: caps.musicKit ? .granted : .notDetermined
            ),
            NativeCapabilityItem(
                id: "notifications",
                icon: "bell.fill",
                iconTint: Color(red: 0.99, green: 0.65, blue: 0.0),
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
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 9)
                    .fill(item.iconTint.opacity(0.15))
                    .frame(width: 36, height: 36)
                Image(systemName: item.icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(item.iconTint)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.oxyText)
                Text(item.subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.oxySub)
            }

            Spacer()

            Button {
                Task { await onAction() }
            } label: {
                nativePill
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var nativePill: some View {
        let (label, color): (String, Color) = {
            switch item.status {
            case .granted:      return ("Active", Color.oxyGreen)
            case .denied:       return ("Settings", Color.oxySub)
            case .notDetermined: return ("Enable", Color.oxyStone)
            }
        }()
        return Text(label)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
            .overlay(Capsule().stroke(color.opacity(0.25), lineWidth: 1))
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
        case "telegram":  return "paperplane.fill"
        case "monzo":     return "banknote.fill"
        case "homekit":   return "house.fill"
        case "maps":      return "map.fill"
        case "notion":    return "doc.text.fill"
        case "betfair":   return "chart.line.uptrend.xyaxis"
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
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
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
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isDrawn)
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
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
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
        if names.contains("google") { return ("G", .white, Color(red: 66/255, green: 133/255, blue: 244/255), 21) }
        if names.contains("maps") { return (nil, Color(red: 66/255, green: 133/255, blue: 244/255), .white, 17) }
        if names.contains("telegram") { return (nil, Color(red: 42/255, green: 171/255, blue: 238/255), .white, 17) }
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

    var actionTint: Color {
        if !implemented { return Color.oxyDim }
        if connectionState == "needs_reconnect" || connectionState == "needs_setup" || connectionState == "degraded" { return Color.oxyStone }
        return enabled ? Color.oxySub : Color.oxyGreen
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
