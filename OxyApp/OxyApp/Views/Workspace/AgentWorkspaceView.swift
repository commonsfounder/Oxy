import SwiftUI

struct AgentWorkspaceView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: AgentWorkspaceSnapshot?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showingSessionComposer = false
    @State private var sessionTitle = ""
    @State private var isCreatingSession = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "Workspace", onBack: { dismiss() })

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: {
                                Task { await load() }
                            })
                        }

                        if isLoading {
                            ForEach(0..<3, id: \.self) { _ in
                                OxySkeletonCard(height: 92, cornerRadius: AppRadius.card)
                            }
                        } else if let snapshot {
                            workspaceHeader(snapshot)
                            filesSection(snapshot.files)
                            sessionsSection(snapshot.sessions)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await load() }
            .alert("New session", isPresented: $showingSessionComposer) {
                TextField("Session name", text: $sessionTitle)
                Button("Create") { createSession() }
                    .disabled(sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreatingSession)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Keep a project or working session here.")
            }
        }
    }

    private func workspaceHeader(_ snapshot: AgentWorkspaceSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AppIcon("doc", size: 18)
                    .foregroundStyle(Color.appAccent)
                    .frame(width: 40, height: 40)
                    .background(Color.appAccent.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(snapshot.workspace.name)
                        .font(.appDisplay(AppText.title, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    Text(snapshot.files.count == 1 ? "1 file" : "\(snapshot.files.count) files")
                        .font(.appBody(AppText.caption))
                        .foregroundStyle(Color.appMuted)
                }
                Spacer(minLength: 0)
            }
            Text(snapshot.capabilities.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: " · ").capitalized)
                .font(.appBody(AppText.caption))
                .foregroundStyle(Color.appMuted)
        }
        .padding(18)
        .background { MissionGlassPlate() }
    }

    @ViewBuilder
    private func filesSection(_ files: [AgentWorkspaceFile]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Files")
                .font(.appDisplay(AppText.title, weight: .semibold))
                .foregroundStyle(Color.appInk)
            if files.isEmpty {
                Text("No files yet.")
                    .font(.appBody(AppText.body))
                    .foregroundStyle(Color.appMuted)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { MissionGlassPlate() }
            } else {
                VStack(spacing: 0) {
                    ForEach(files) { file in
                        HStack(spacing: 10) {
                            AppIcon(file.kind == "folder" ? "dotted" : "doc", size: 15)
                                .foregroundStyle(Color.appAccent)
                            Text(file.path)
                                .font(.appBody(AppText.body))
                                .foregroundStyle(Color.appInk)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            if let size = file.sizeBytes {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                                    .font(.appBody(AppText.micro))
                                    .foregroundStyle(Color.appMuted)
                            }
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        }
    }

    @ViewBuilder
    private func sessionsSection(_ sessions: [AgentWorkspaceSession]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Sessions")
                    .font(.appDisplay(AppText.title, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                Spacer()
                Button("New") {
                    sessionTitle = ""
                    showingSessionComposer = true
                }
                .font(.appBody(AppText.footnote, weight: .semibold))
                .foregroundStyle(Color.appAccent)
            }
            if sessions.isEmpty {
                Text("Persistent working sessions will appear here.")
                    .font(.appBody(AppText.body))
                    .foregroundStyle(Color.appMuted)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background { MissionGlassPlate() }
            } else {
                VStack(spacing: 0) {
                    ForEach(sessions) { session in
                        HStack(spacing: 10) {
                            AppIcon("dotted", size: 15)
                                .foregroundStyle(Color.appAccent)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.title)
                                    .font(.appBody(AppText.body, weight: .medium))
                                    .foregroundStyle(Color.appInk)
                                Text(session.kind.capitalized + " session")
                                    .font(.appBody(AppText.micro))
                                    .foregroundStyle(Color.appMuted)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        }
    }

    private func load() async {
        do {
            let fetched = try await AgentWorkspaceService.fetch()
            await MainActor.run {
                snapshot = fetched
                isLoading = false
                errorMessage = nil
            }
        } catch {
            await MainActor.run {
                isLoading = false
                if snapshot == nil { errorMessage = "Could not load the workspace." }
            }
        }
    }

    private func createSession() {
        let title = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        isCreatingSession = true
        Task {
            do {
                _ = try await AgentWorkspaceService.createSession(title: title)
                await MainActor.run {
                    isCreatingSession = false
                    showingSessionComposer = false
                }
                await load()
            } catch {
                await MainActor.run {
                    isCreatingSession = false
                    errorMessage = "Could not create that session."
                }
            }
        }
    }
}

#Preview {
    AgentWorkspaceView()
        .environment(AppState())
}
