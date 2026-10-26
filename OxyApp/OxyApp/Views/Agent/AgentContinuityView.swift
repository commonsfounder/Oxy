import SwiftUI
import UniformTypeIdentifiers

struct AgentContinuityView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var snapshot: AgentContinuitySnapshot?
    @State private var showingImporter = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var historyError: String?
    @State private var selectedFileName: String?
    @State private var successMessage: String?

    @State private var pendingData: Data?
    @State private var preview: AgentContinuityPreview?

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            VStack(spacing: 0) {
                ScreenHeaderView(title: "Import your chats", onBack: { dismiss() })
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let preview {
                            previewCard(preview)
                        } else {
                            importCard
                            if let successMessage {
                                SettingsStatement(text: successMessage, solid: true)
                            }
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }
                            if let historyError {
                                ErrorBanner(message: historyError, onRetry: { Task { await load() } })
                            }
                            if let snapshot {
                                history(snapshot.imports)
                            } else if isLoading {
                                OxySkeletonCard(height: 88)
                            }
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 16)
                    .padding(.bottom, 40)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if preview != nil {
                importActions
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.vertical, 12)
                    .background(Color.appBackground)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await load()
            #if DEBUG
            if PreviewData.isIsolated, let state = ProcessInfo.processInfo.environment["OXY_DEBUG_IMPORT"], ["review", "failure"].contains(state) {
                preview = AgentContinuityPreview(source: "chatgpt",
                    counts: AgentContinuityPreviewCounts(conversations: 12, messages: 56, projects: 1, documents: 2, instructions: 0, memories: 3, workflows: 2, scheduledWorkflows: 1, eventWorkflows: 1),
                    coverage: [:], workflows: [
                        AgentContinuityWorkflow(name: "Morning update", triggerKind: "schedule", intervalMinutes: 1440, activeAtSource: true, prompt: "Sample morning update"),
                        AgentContinuityWorkflow(name: "On request", triggerKind: "event", intervalMinutes: nil, activeAtSource: false, prompt: "Sample on-request workflow")
                    ])
                pendingData = Data("[]".utf8)
                selectedFileName = "sample-chatgpt-export.zip"
                if state == "failure" { await confirmImport() }
            }
            #endif
        }
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
            Text("Choose a ChatGPT or Claude export (.zip or .json).")
                .font(.appBody(16))
                .foregroundStyle(Color.appMuted)
            Button {
                showingImporter = true
            } label: {
                HStack {
                    Text(isWorking ? "Reading…" : "Choose file")
                    Spacer()
                    AppIcon("arrow-up-right", size: 13)
                }
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(Color.appOnAction)
                .padding(.horizontal, 20)
                .frame(minHeight: 44)
                .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.97))
            .disabled(isWorking)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Confirm

    private func previewCard(_ preview: AgentContinuityPreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(sourceName(preview.source)) export")
                .font(.rowTitle)
                .foregroundStyle(Color.appInk)
            if let selectedFileName {
                Text(selectedFileName).font(.appBody(14)).foregroundStyle(Color.appMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 12) {
                ForEach(coverageRows(preview), id: \.label) { row in
                    let layout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                        : AnyLayout(HStackLayout(spacing: 10))
                    layout {
                        Text(row.label)
                            .font(.appBody(16, weight: .medium))
                            .foregroundStyle(Color.appInk)
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 12) }
                        Text(row.detail)
                            .font(.appBody(15))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if !preview.workflows.isEmpty {
                SettingsDivider()
                VStack(alignment: .leading, spacing: 10) {
                    Text("Automations")
                        .font(.rowTitle)
                        .foregroundStyle(Color.appInk)
                    Text("Imported automations start switched off. Disable matching automations in \(sourceName(preview.source)) before enabling them here.")
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)
                    ForEach(preview.workflows.prefix(8)) { workflow in
                        HStack(alignment: .top, spacing: 10) {
                            AppIcon(workflow.isScheduled ? "bolt" : "dotted", size: 12)
                                .foregroundStyle(workflow.isScheduled ? Color.appAccent : Color.appMuted)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workflow.name)
                                    .font(.appBody(13, weight: .medium))
                                    .foregroundStyle(Color.appInk)
                                Text(workflow.isScheduled ? cadence(workflow.intervalMinutes) : "Event trigger")
                                    .font(.appBody(12))
                                    .foregroundStyle(Color.appMuted)
                            }
                        }
                    }
                    if preview.workflows.count > 8 {
                        Text("and \(preview.workflows.count - 8) more")
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                    }
                }
            }

            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var importActions: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            Button { Task { await confirmImport() } } label: {
                Text(isWorking ? "Importing…" : "Import")
                    .font(.appBody(16, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Color.appAction, in: Capsule())
            }
            .buttonStyle(.appScale)
            .disabled(isWorking)
            Button("Cancel") { reset() }
                .font(.appBody(16, weight: .medium))
                .foregroundStyle(Color.appAccent)
                .frame(minWidth: 64, minHeight: 44)
                .buttonStyle(.appScale)
                .disabled(isWorking)
        }
    }

    private func sourceName(_ source: String) -> String {
        switch source.lowercased() {
        case "chatgpt": return "ChatGPT"
        case "claude": return "Claude"
        default: return source.capitalized
        }
    }

    private struct CoverageRow { let label: String; let detail: String; let found: Bool }

    private func coverageRows(_ preview: AgentContinuityPreview) -> [CoverageRow] {
        let counts = preview.counts
        var rows: [CoverageRow] = [
            CoverageRow(label: "Conversations", detail: "\(counts.conversations)", found: counts.conversations > 0),
            CoverageRow(label: "Messages", detail: "\(counts.messages)", found: counts.messages > 0),
            CoverageRow(label: "Instructions", detail: counts.instructions > 0 ? "\(counts.instructions)" : "Not included", found: counts.instructions > 0),
            CoverageRow(label: "Memory", detail: counts.memories > 0 ? "\(counts.memories)" : "Not included", found: counts.memories > 0)
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
            Text("Import history")
                .font(.sectionLabel)
                .foregroundStyle(Color.appMuted)
                .padding(.horizontal, 4)
            if imports.isEmpty {
                Text("Nothing imported yet.")
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
            } else {
                ForEach(imports) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        let layout = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                            : AnyLayout(HStackLayout())
                        layout {
                            Text(sourceName(item.source)).font(.appBody(14, weight: .semibold))
                            if !typeSize.isAccessibilitySize { Spacer() }
                            Text(item.status.capitalized)
                                .font(.appBody(12, weight: .semibold))
                                .foregroundStyle(item.status == "failed" ? Color.appDestructive : Color.appMuted)
                        }
                        Text("\(item.conversationCount) conversations · \(item.messageCount) messages · \(item.memoryCount) memories")
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                    }
                    .padding(.vertical, 12)
                }
            }
        }
    }

    // MARK: - Actions

    private func load() async {
        isLoading = true
        historyError = nil
        do {
            snapshot = try await AgentContinuityService.fetch()
        } catch {
            historyError = "Couldn't load import history."
        }
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
            selectedFileName = url.lastPathComponent
        } catch {
            errorMessage = "Couldn't read that export."
        }
        isWorking = false
    }

    private func confirmImport() async {
        guard let pendingData, !isWorking else { return }
        isWorking = true
        errorMessage = nil
        do {
            let result = try await AgentContinuityService.import(fileData: pendingData)
            let counts = result.imported
            var parts = ["\(counts.messages) messages", "\(counts.memories) memories"]
            if counts.workflows > 0 { parts.append("\(counts.workflows) automations, switched off") }
            successMessage = "Imported " + parts.joined(separator: ", ") + "."
            reset()
            await load()
        } catch {
            errorMessage = "Couldn't import these chats. Try again."
        }
        isWorking = false
    }

    private func reset() {
        preview = nil
        pendingData = nil
        selectedFileName = nil
        errorMessage = nil
    }
}
