import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Everything Adam can connect to, grouped by what it is for, in plain words.
struct ConnectorsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    @State private var connectors: [Connector] = []
    @State private var catalogueOn = false
    @State private var catalogueConnected: Set<String> = []
    @State private var pending: String?
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var ownLoaded = false
    @State private var catalogueLoaded = false
    @State private var message: String?
    @State private var manage: Entry?
    @State private var place: Place?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var typeSize

    private enum Place: String, Identifiable {
        case displays, payments, logins
        var id: String { "\(self)" }
    }

    private let oauthProviders: Set<String> = ["google", "microsoft"]

    // MARK: Directory

    enum Source { case own(String), catalogue(String) }

    struct Entry: Identifiable {
        let name: String
        let line: String
        let source: Source
        var key: String {
            switch source { case .own(let id): return id; case .catalogue(let slug): return slug }
        }
        var id: String { key }
    }

    private struct Section: Identifiable {
        let title: String
        let entries: [Entry]
        var id: String { title }
    }

    private static func own(_ id: String, _ name: String, _ line: String) -> Entry { Entry(name: name, line: line, source: .own(id)) }
    private static func app(_ slug: String, _ name: String, _ line: String) -> Entry { Entry(name: name, line: line, source: .catalogue(slug)) }

    private static let directory: [Section] = [
        Section(title: "Mail and calendar", entries: [
            own("google", "Gmail and Calendar", "Mail and diary"),
            own("microsoft", "Outlook and Calendar", "Mail and diary")
        ]),
        Section(title: "Messages", entries: [
            own("telegram", "Telegram", "Message people"),
            app("whatsapp", "WhatsApp", "Messages")
        ]),
        Section(title: "Photos and files", entries: [
            app("googlephotos", "Google Photos", "Find your photos"),
            app("googledrive", "Google Drive", "Find your files"),
            app("dropbox", "Dropbox", "Find your files")
        ]),
        Section(title: "Plans and lists", entries: [
            app("todoist", "Todoist", "Your to-do list"),
            app("googletasks", "Google Tasks", "Your to-do list"),
            own("notion", "Notion", "Save notes"),
            app("splitwise", "Splitwise", "Shared bills"),
            app("eventbrite", "Eventbrite", "Events and tickets"),
            app("ticketmaster", "Ticketmaster", "Concerts and shows")
        ]),
        Section(title: "Health and fitness", entries: [
            own("strava", "Strava", "Runs and rides"),
            own("oura", "Oura", "Sleep and readiness")
        ]),
        Section(title: "Video and social", entries: [
            app("youtube", "YouTube", "Videos and channels"),
            app("instagram", "Instagram", "Posts and messages"),
            app("facebook", "Facebook", "Pages and events"),
            app("pinterest", "Pinterest", "Boards and ideas"),
            app("reddit", "Reddit", "Communities"),
            app("discord", "Discord", "Servers and friends")
        ]),
        Section(title: "Work", entries: [
            own("slack", "Slack", "Post for you"),
            app("zoom", "Zoom", "Your meetings"),
            // Only shown once connected: it is a developer tool.
            own("github", "GitHub", "Code and issues")
        ])
    ]

    // MARK: State per entry

    private func connector(_ entry: Entry) -> Connector? {
        if case .own(let id) = entry.source { return connectors.first { $0.id == id } }
        return nil
    }

    private func isVisible(_ entry: Entry) -> Bool {
        switch entry.source {
        case .own(let id):
            guard let c = connector(entry), c.implemented else { return false }
            return id != "github" || c.enabled
        case .catalogue:
            return catalogueOn
        }
    }

    private func isConnected(_ entry: Entry) -> Bool {
        switch entry.source {
        case .own: return connector(entry)?.enabled == true
        case .catalogue(let slug): return catalogueConnected.contains(slug)
        }
    }

    private var sections: [Section] {
        Self.directory.compactMap { section in
            let visible = section.entries.filter(isVisible)
            return visible.isEmpty ? nil : Section(title: section.title, entries: visible)
        }
    }

    private var connectedCount: Int { sections.flatMap(\.entries).filter(isConnected).count }

    // MARK: Body

    var body: some View {
        SettingsPage(title: "Apps", isRoot: true) {
            if isLoading {
                VStack(spacing: 12) {
                    OxySkeletonCard(height: 92)
                    OxySkeletonCard(height: 148)
                }
            } else {
                if ownLoaded && catalogueLoaded {
                    if connectedCount == 0 {
                        Text("No apps connected")
                            .font(.appBody(16))
                            .foregroundStyle(Color.appInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    ErrorBanner(message: "Couldn't load all your apps.", onRetry: { Task { await load() } })
                        .disabled(isRefreshing)
                }

                if let message {
                    Text(message).font(.appBody(13)).foregroundStyle(Color.appMuted)
                }

                let connected = sections.flatMap(\.entries).filter(isConnected)
                if !connected.isEmpty {
                    Text(ownLoaded && catalogueLoaded ? "\(connectedCount) connected" : "Connected")
                        .font(.appBody(15, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    if typeSize.isAccessibilitySize {
                        VStack(spacing: 12) {
                            ForEach(connected) { entry in tile(entry) }
                        }
                    } else {
                        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                            ForEach(Array(stride(from: 0, to: connected.count, by: 2)), id: \.self) { index in
                                GridRow {
                                    tile(connected[index])
                                    if index + 1 < connected.count {
                                        tile(connected[index + 1])
                                    } else {
                                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                                    }
                                }
                            }
                        }
                    }
                }

                ForEach(sections) { section in
                    let open = section.entries.filter { !isConnected($0) }
                    if !open.isEmpty {
                        SettingsGroup(title: section.title) {
                            SettingsList {
                                ForEach(Array(open.enumerated()), id: \.element.id) { index, entry in
                                    row(entry)
                                    if index < open.count - 1 { SettingsRule(inset: 48) }
                                }
                            }
                        }
                    }
                }

                SettingsGroup(title: "Devices and payments") {
                    SettingsList {
                        SettingsNavRow(title: "Displays") { place = .displays }
                        SettingsRule()
                        SettingsNavRow(title: "Payment methods") { place = .payments }
                        SettingsRule()
                        SettingsNavRow(title: "Saved logins") { place = .logins }
                    }
                }

            }
        }
        .fullScreenCover(item: $place) { destination in
            Group {
                switch destination {
                case .displays: PairedDisplaysView()
                case .payments: PaymentsView()
                case .logins: VaultView()
                }
            }
            .swipeToDismiss()
            .environment(\.revealClose, nil)
            .environment(\.colorScheme, colorScheme)
        }
        .task { await load() }
        #if DEBUG
        .task {
            if PreviewData.isIsolated, let raw = ProcessInfo.processInfo.environment["OXY_DEBUG_APPS"] {
                try? await Task.sleep(for: .milliseconds(700))
                place = Place(rawValue: raw)
            }
        }
        #endif
        .refreshable { await load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        .confirmationDialog(
            manage.map { "Disconnect \($0.name)?" } ?? "Disconnect app?",
            isPresented: Binding(get: { manage != nil }, set: { if !$0 { manage = nil } }),
            titleVisibility: .visible
        ) {
            if let entry = manage {
                Button("Disconnect", role: .destructive) { Task { await disconnect(entry) } }
            }
            Button("Cancel", role: .cancel) { manage = nil }
        } message: {
            Text("Adam will stop using this app until you connect it again.")
        }
    }

    /// A connected app as an object: its logo, its name and a quiet status, one tap to manage.
    private func tile(_ entry: Entry) -> some View {
        Button { manage = entry } label: {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(HStackLayout(alignment: .top, spacing: 12))
                : AnyLayout(VStackLayout(alignment: .leading, spacing: 24))
            layout {
                AppIconView(candidates: iconCandidates(entry))
                    .frame(width: 38, height: 38)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.name).font(.appRounded(17, weight: .semibold, relativeTo: .headline)).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Circle().fill(Color.appSuccess).frame(width: 6, height: 6)
                        Text(pending == entry.key ? "Working" : "Connected").font(.appBody(12, weight: .medium)).foregroundStyle(Color.appMuted)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.settingsRaised))

            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.appScale(0.97))
        .accessibilityLabel("\(entry.name), connected")
        .accessibilityHint("Opens the option to disconnect")
    }

    private func row(_ entry: Entry) -> some View {
        HStack(spacing: 12) {
            AppIconView(candidates: iconCandidates(entry))
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(.appBody(15, weight: .medium)).foregroundStyle(Color.appInk)
                Text(entry.line).font(.appBody(13)).foregroundStyle(Color.appMuted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing(entry)
        }
        .padding(.vertical, 10)
        .frame(minHeight: 60)
    }

    private func iconCandidates(_ entry: Entry) -> [String] {
        let logo = "app-\(entry.key)"
        if let c = connector(entry) { return [c.icon, c.id, logo] }
        return [logo, entry.name]
    }

    @ViewBuilder
    private func trailing(_ entry: Entry) -> some View {
        if pending == entry.key {
            ProgressView().scaleEffect(0.65).tint(Color.appMuted)
        } else if isConnected(entry) {
            Button { manage = entry } label: {
                HStack(spacing: 6) {
                    Circle().fill(Color.appSuccess).frame(width: 6, height: 6)
                    Text("Connected").font(.appBody(13, weight: .medium)).foregroundStyle(Color.appSuccess)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.97))
        } else {
            Button { Task { await connect(entry) } } label: {
                Text(connector(entry)?.connectionState == "needs_reconnect" ? "Reconnect" : "Connect")
                    .font(.appBody(14, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                    .overlay(Capsule().strokeBorder(Color.appHairline, lineWidth: 0.7))
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.97))
        }
    }

    // MARK: Loading

    private func load() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        async let own = loadOwn()
        async let catalogue = loadCatalogue()
        let results = await (own, catalogue)
        await MainActor.run {
            ownLoaded = results.0
            catalogueLoaded = results.1
            isLoading = false
            isRefreshing = false
            pending = nil
        }
    }

    private func loadOwn() async -> Bool {
        guard let data = try? await APIClient.shared.request(path: "/connectors/\(appState.userId)"),
              let response = try? JSONDecoder().decode(ConnectorsResponse.self, from: data) else {
            return false
        }
        await MainActor.run { connectors = response.connectors.filter { $0.kind == "connection" }; message = nil }
        return true
    }

    private func loadCatalogue() async -> Bool {
        guard let data = try? await APIClient.shared.request(path: "/connectors/apps"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let configured = json["configured"] as? Bool,
              let items = json["connections"] as? [[String: Any]] else { return false }
        await MainActor.run {
            catalogueOn = configured
            catalogueConnected = Set(items.compactMap { ($0["connected"] as? Bool) == true ? $0["toolkit"] as? String : nil })
        }
        return true
    }

    // MARK: Actions

    private func connect(_ entry: Entry) async {
        await MainActor.run { pending = entry.key; message = nil }
        do {
            switch entry.source {
            case .catalogue(let slug):
                let data = try await APIClient.shared.request(path: "/connectors/apps/connect", method: "POST", body: ["toolkit": slug])
                try await open(data, key: "redirectUrl")
            case .own(let id) where oauthProviders.contains(id):
                let path = id == "microsoft" ? "/auth/microsoft/start" : "/auth/google/start"
                let data = try await APIClient.shared.request(path: path, queryItems: [URLQueryItem(name: "userId", value: appState.userId)])
                try await open(data, key: "url")
            case .own(let id):
                _ = try await APIClient.shared.request(path: "/connectors", method: "POST", body: ["userId": appState.userId, "connectorId": id, "enabled": true])
                await load()
            }
        } catch {
            await MainActor.run { pending = nil; message = "Couldn't connect \(entry.name). Try again." }
        }
    }

    private func open(_ data: Data, key: String) async throws {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json[key] as? String, let url = URL(string: text) else {
            await MainActor.run { pending = nil; message = "Couldn't open the sign-in page." }
            return
        }
        await MainActor.run { UIApplication.shared.open(url) }
    }

    private func disconnect(_ entry: Entry) async {
        await MainActor.run { manage = nil; pending = entry.key }
        do {
            switch entry.source {
            case .catalogue(let slug):
                _ = try await APIClient.shared.request(path: "/connectors/apps/\(slug)", method: "DELETE")
            case .own(let id):
                _ = try await APIClient.shared.request(path: "/connectors", method: "POST", body: ["userId": appState.userId, "connectorId": id, "enabled": false])
            }
            await load()
        } catch {
            await MainActor.run { pending = nil; message = "Couldn't disconnect \(entry.name). Try again." }
        }
    }
}

// MARK: - AppIconView

struct AppIconView: View {
    let candidates: [String]

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
                    .font(.appBody(20))
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
                AppIcon("cube", size: 18)
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
        if names.contains("slack") { return ("Slack", Color(red: 74/255, green: 21/255, blue: 75/255), .white, 11) }
        if names.contains("oura") { return ("Oura", .black, .white, 12) }
        let initial = candidates.first.map { String($0.prefix(1)).uppercased() }
        return (initial, Color.oxySurface3, Color.oxySub, 17)
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

struct ConnectorsResponse: Codable {
    let connectors: [Connector]
}

