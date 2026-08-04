import SwiftUI
import UniformTypeIdentifiers

struct AgentContinuityView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: AgentContinuitySnapshot?
    @State private var showingImporter = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    /// Held between preview and confirm so the file is read once and the bytes the user
    /// approved are the bytes that get imported.
    @State private var pendingData: Data?
    @State private var preview: AgentContinuityPreview?

    var body: some View {
        ZStack {
            GlebChrome.pastelBlob.ignoresSafeArea()
            VStack(spacing: 0) {
                ScreenHeaderView(title: "Continuity", onBack: { dismiss() })
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let preview {
                            previewCard(preview)
                        } else {
                            importCard
                        }
                        if let successMessage {
                            Text(successMessage)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.appAccent)
                        }
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.mgDestructive)
                        }
                        if let snapshot {
                            history(snapshot.imports)
                        } else if isLoading {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 16)
                    .padding(.bottom, 40)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.zip, .json],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            Task { await inspect(url) }
        }
    }

    // MARK: - Choose

    private var importCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                AppIcon("dotted", size: 15).foregroundStyle(Color.appAccent)
                AppSectionTitle("Bring your history", size: 20)
            }
            Text("Upload the export from ChatGPT, Claude, or Zapier. The .zip carries your instructions and memory — a single .json holds only conversations.")
                .font(.system(size: 13))
                .foregroundStyle(Color.mgSecondary)
            Button {
                showingImporter = true
            } label: {
                HStack {
                    Text(isWorking ? "Reading…" : "Choose export")
                    Spacer()
                    AppIcon("arrow-up-right", size: 13)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.appInk)
                .padding(.vertical, 15)
                .padding(.horizontal, 16)
                .background(Color.appAccent, in: Capsule())
            }
            .disabled(isWorking)
        }
        .padding(18)
        .background(MissionGlassPlate())
    }

    // MARK: - Confirm

    private func previewCard(_ preview: AgentContinuityPreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                AppIcon("doc", size: 15).foregroundStyle(Color.appAccent)
                AppSectionTitle("\(preview.source.capitalized) export", size: 20)
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(coverageRows(preview), id: \.label) { row in
                    HStack(spacing: 10) {
                        AppIcon(row.found ? "bolt" : "dotted", size: 12)
                            .foregroundStyle(row.found ? Color.appAccent : Color.mgSecondary)
                        Text(row.label)
                            .font(.system(size: 13, weight: row.found ? .medium : .regular))
                            .foregroundStyle(row.found ? Color.mgHeading : Color.mgSecondary)
                        Spacer()
                        Text(row.detail)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.mgSecondary)
                    }
                }
            }

            if !preview.workflows.isEmpty {
                MilgrainDivider()
                VStack(alignment: .leading, spacing: 10) {
                    Text("Automations")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.mgHeading)
                    Text("These arrive switched off. Turn each one off in \(preview.source.capitalized) before enabling it here, or it runs twice.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.mgSecondary)
                    ForEach(preview.workflows.prefix(8)) { workflow in
                        HStack(alignment: .top, spacing: 10) {
                            AppIcon(workflow.isScheduled ? "bolt" : "dotted", size: 12)
                                .foregroundStyle(workflow.isScheduled ? Color.appAccent : Color.mgSecondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workflow.name)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Color.mgHeading)
                                Text(workflow.isScheduled ? cadence(workflow.intervalMinutes) : "Event trigger — runs only when you ask")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Color.mgSecondary)
                            }
                        }
                    }
                    if preview.workflows.count > 8 {
                        Text("and \(preview.workflows.count - 8) more")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.mgSecondary)
                    }
                }
            }

            HStack(spacing: 12) {
                Button {
                    Task { await confirmImport() }
                } label: {
                    Text(isWorking ? "Importing…" : "Import")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity)
                        .background(Color.appAccent, in: Capsule())
                }
                .buttonStyle(.appScale(0.98))
                .disabled(isWorking)

                Button("Cancel") { reset() }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.mgSecondary)
                    .disabled(isWorking)
            }
        }
        .padding(18)
        .background(MissionGlassPlate())
    }

    private struct CoverageRow { let label: String; let detail: String; let found: Bool }

    private func coverageRows(_ preview: AgentContinuityPreview) -> [CoverageRow] {
        let counts = preview.counts
        var rows: [CoverageRow] = [
            CoverageRow(label: "Conversations", detail: "\(counts.conversations)", found: counts.conversations > 0),
            CoverageRow(label: "Messages", detail: "\(counts.messages)", found: counts.messages > 0),
            CoverageRow(label: "Instructions", detail: counts.instructions > 0 ? "\(counts.instructions)" : "not in this export", found: counts.instructions > 0),
            CoverageRow(label: "Memory", detail: counts.memories > 0 ? "\(counts.memories)" : "not in this export", found: counts.memories > 0)
        ]
        if counts.projects > 0 { rows.append(CoverageRow(label: "Projects", detail: "\(counts.projects)", found: true)) }
        if counts.documents > 0 { rows.append(CoverageRow(label: "Documents", detail: "\(counts.documents)", found: true)) }
        if counts.workflows > 0 {
            rows.append(CoverageRow(
                label: "Automations",
                detail: "\(counts.scheduledWorkflows) scheduled, \(counts.eventWorkflows) event",
                found: true
            ))
        }
        return rows
    }

    private func cadence(_ minutes: Int?) -> String {
        guard let minutes else { return "Scheduled" }
        switch minutes {
        case ..<60: return "Every \(minutes) minutes"
        case ..<(60 * 24): return "Every \(minutes / 60) hours"
        case 60 * 24: return "Daily"
        case 60 * 24 * 7: return "Weekly"
        default: return "Every \(minutes / (60 * 24)) days"
        }
    }

    // MARK: - History

    private func history(_ imports: [AgentContinuityImport]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSectionTitle("Imported", size: 20)
            if imports.isEmpty {
                Text("Nothing imported yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.mgSecondary)
            } else {
                ForEach(imports) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(item.source.capitalized).font(.system(size: 14, weight: .semibold))
                            Spacer()
                            Text(item.status.capitalized)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(item.status == "failed" ? Color.mgDestructive : Color.appAccent)
                        }
                        Text("\(item.conversationCount) conversations · \(item.messageCount) messages · \(item.memoryCount) memories")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.mgSecondary)
                    }
                    .padding(.vertical, 12)
                }
            }
        }
    }

    // MARK: - Actions

    private func load() async {
        do { snapshot = try await AgentContinuityService.fetch() } catch { errorMessage = "Couldn't load import history." }
        isLoading = false
    }

    private func inspect(_ url: URL) async {
        isWorking = true
        errorMessage = nil
        successMessage = nil
        do {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            preview = try await AgentContinuityService.preview(fileData: data)
            pendingData = data
        } catch {
            errorMessage = "Couldn't read that export."
        }
        isWorking = false
    }

    private func confirmImport() async {
        guard let pendingData else { return }
        isWorking = true
        errorMessage = nil
        do {
            let result = try await AgentContinuityService.import(fileData: pendingData)
            let counts = result.imported
            var parts = ["\(counts.messages) messages", "\(counts.memories) memories"]
            if counts.workflows > 0 { parts.append("\(counts.workflows) automations, switched off") }
            successMessage = "Imported " + parts.joined(separator: ", ") + "."
            reset()
            snapshot = try await AgentContinuityService.fetch()
        } catch {
            errorMessage = error.localizedDescription
        }
        isWorking = false
    }

    private func reset() {
        preview = nil
        pendingData = nil
    }
}
