import SwiftUI

/// Work detail, its outstanding decisions, files and recorded events.
struct WorkflowTimelineView: View {
    let workflowId: String
    var onChanged: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var detail: WorkflowDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var resolvingCheckpointID: String?
    @State private var checkpointErrors: [String: String] = [:]
    @State private var submittedIDs: Set<String> = []
    @State private var expiredIDs: Set<String> = []
    @State private var seenEventIDs = Set<String>()
    @State private var currentDate = Date()

    private var shouldPoll: Bool { detail?.workflow.isFinished == false && scenePhase == .active }

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeaderView(title: "Work", onBack: { dismiss() })
            GeometryReader { geometry in
              ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                                .disabled(isLoading)
                        }
                        if let detail {
                            summary(detail.workflow)
                            ForEach(detail.pendingCheckpoints) { checkpoint in
                                checkpointSection(checkpoint)
                                    .id("decision-\(checkpoint.id)")
                            }
                            if !detail.documents.isEmpty { documentsSection(detail.documents) }
                            timelineSection(detail.timeline)
                        } else if isLoading {
                            VStack(spacing: 16) {
                                OxySkeletonCard(height: 104)
                                OxySkeletonCard(height: 180)
                            }
                            .frame(width: max(0, geometry.size.width - AppSpacing.margin * 2))
                            .accessibilityLabel("Loading work")
                        }
                    }
                    .frame(width: max(0, geometry.size.width - AppSpacing.margin * 2), alignment: .leading)
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 16)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
                #if DEBUG
                .task(id: detail) {
                    guard PreviewData.isIsolated, let focus = ProcessInfo.processInfo.environment["OXY_DEBUG_WORKFLOW_FOCUS"],
                          let checkpoint = detail?.pendingCheckpoints.first else { return }
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    if focus == "decision" { proxy.scrollTo("decision-\(checkpoint.id)", anchor: .top) }
                    if focus == "decision-bottom" { proxy.scrollTo("decision-end-\(checkpoint.id)", anchor: .bottom) }
                }
                #endif
              }
            }
        }
        .background(Color.appBackground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await load()
            #if DEBUG
            if PreviewData.isIsolated {
                switch ProcessInfo.processInfo.environment["OXY_DEBUG_WORKFLOW"] {
                case "refresh-failure": await load(quiet: true)
                case "resolve-failure", "server-expired":
                    if let checkpoint = detail?.pendingCheckpoints.first {
                        resolve(checkpoint, approved: true, choice: nil)
                    }
                default: break
                }
            }
            #endif
        }
        .task(id: shouldPoll) {
            guard shouldPoll else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await load(quiet: true)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load(quiet: true) } }
        }
    }

    private func summary(_ workflow: WorkflowSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(workflow.goal)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 10) {
                AppIcon(statusIcon(workflow.status), size: 19)
                    .accessibilityHidden(true)
                Text(workflow.plainStatus).font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(statusColor(workflow.status))
        }
    }

    private func statusIcon(_ status: String) -> String {
        switch status.lowercased() {
        case "completed": return "check-circle"
        case "failed": return "alert-circle"
        case "cancelled": return "stop"
        case "waiting_for_user": return "alert-circle"
        default: return "clock"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "completed": return .appSuccess
        case "failed": return .appDestructive
        case "waiting_for_user": return .appNeedsYou
        case "gathering", "working": return .appAccent
        default: return .appMuted
        }
    }

    private func expired(_ checkpoint: WorkflowCheckpoint) -> Bool {
        if expiredIDs.contains(checkpoint.id) { return true }
        guard let expiry = Date.oxyParse(checkpoint.expiresAt) else { return false }
        return expiry <= currentDate
    }

    private func checkpointSection(_ checkpoint: WorkflowCheckpoint) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Decision").font(.appBody(14, weight: .semibold)).foregroundStyle(Color.appInk)
                .accessibilityAddTraits(.isHeader)
            Text(checkpoint.prompt)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
            if let message = checkpointErrors[checkpoint.id] {
                Text(message).font(.body).foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if expired(checkpoint) {
                Text("This decision has expired.").font(.body).foregroundStyle(Color.appInk)
                Button("Ask Adam to check again") { AskAdam.draft("Check this again: \(checkpoint.prompt)") }
                    .font(.body.weight(.medium)).foregroundStyle(Color.appAccent)
                    .frame(minHeight: 44)
            } else if submittedIDs.contains(checkpoint.id) {
                Text("Answer sent. Updating status…").font(.body).foregroundStyle(Color.appInk)
            } else if resolvingCheckpointID == checkpoint.id {
                ProgressView("Sending answer").font(.body).tint(Color.appAccent)
            } else if detail?.workflow.isFinished != true {
                if checkpoint.isChoice, let options = checkpoint.options {
                    VStack(spacing: 8) {
                        ForEach(options) { option in
                            Button { resolve(checkpoint, approved: true, choice: option.label) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(option.label).font(.body.weight(.medium)).foregroundStyle(Color.appInk)
                                    if let text = option.detail, !text.isEmpty {
                                        Text(text).font(.subheadline).foregroundStyle(Color.appMuted)
                                    }
                                }
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .padding(14)
                                .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.appScale)
                        }
                        decisionButton("Decline", primary: false) { resolve(checkpoint, approved: false, choice: nil) }
                    }
                    .disabled(resolvingCheckpointID != nil || errorMessage != nil)
                    .opacity(resolvingCheckpointID != nil || errorMessage != nil ? 0.45 : 1)
                } else {
                    let layout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
                    layout {
                        decisionButton("Approve", primary: true) { resolve(checkpoint, approved: true, choice: nil) }
                        decisionButton("Decline", primary: false) { resolve(checkpoint, approved: false, choice: nil) }
                    }
                    .disabled(resolvingCheckpointID != nil || errorMessage != nil)
                    .opacity(resolvingCheckpointID != nil || errorMessage != nil ? 0.45 : 1)
                }
            }
            Color.clear.frame(height: 1).id("decision-end-\(checkpoint.id)")
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appDecisionSurface, in: RoundedRectangle(cornerRadius: 16))
    }

    private func decisionButton(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.body.weight(.semibold))
                .foregroundStyle(primary ? Color.appBackground : Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.vertical, 8)
                .background(primary ? Color.appInk : Color.appSurface, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.appScale)
    }

    private func documentsSection(_ documents: [WorkflowDocument]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Files").font(.sectionLabel).foregroundStyle(Color.appMuted).accessibilityAddTraits(.isHeader)
            ForEach(documents) { document in
                HStack(alignment: .top, spacing: 12) {
                    AppIcon("doc", size: 22).foregroundStyle(Color.appAccent).frame(width: 28, height: 32)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(document.displayName).font(.body.weight(.medium)).foregroundStyle(Color.appInk)
                        if document.displayName != document.filename {
                            Text(document.filename).font(.subheadline).foregroundStyle(Color.appMuted)
                        }
                        if let size = document.sizeText {
                            Text(size).font(.caption).foregroundStyle(Color.appMuted)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func timelineSection(_ events: [WorkflowEvent]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What happened").font(.sectionLabel).foregroundStyle(Color.appMuted).accessibilityAddTraits(.isHeader)
            if events.isEmpty {
                Text("No updates yet").font(.body).foregroundStyle(Color.appMuted)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(events.reversed().enumerated()), id: \.element.id) { index, event in
                        TimelineRow(event: event, isFirst: index == 0, isLast: index == events.count - 1)
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
    }

    private func load(quiet: Bool = false) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false; currentDate = Date() }
        do {
            let fetched: WorkflowDetail
            #if DEBUG
            if PreviewData.isIsolated, let mode = ProcessInfo.processInfo.environment["OXY_DEBUG_WORKFLOW"], mode != "failure" {
                if mode == "loading" { try await Task.sleep(for: .seconds(12)) }
                if mode == "refresh-failure", detail != nil {
                    fetched = try JSONDecoder().decode(WorkflowDetail.self, from: Data("{invalid isolated work response".utf8))
                } else {
                    fetched = try Self.sampleDetail(mode)
                }
            } else {
                fetched = try await HomeBoardService.fetchWorkflow(id: workflowId)
            }
            #else
            fetched = try await HomeBoardService.fetchWorkflow(id: workflowId)
            #endif
            let arriving = Set(fetched.timeline.map(\.id)).subtracting(seenEventIDs)
            if !seenEventIDs.isEmpty && !arriving.isEmpty {
                withAnimation(reduceMotion ? nil : .appStandard) { detail = fetched }
            } else { detail = fetched }
            seenEventIDs = Set(fetched.timeline.map(\.id))
            submittedIDs.formIntersection(Set(fetched.pendingCheckpoints.map(\.id)))
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = detail == nil ? "Couldn't load this work." : "Couldn't update this work. Showing saved details."
        }
    }

    private func resolve(_ checkpoint: WorkflowCheckpoint, approved: Bool, choice: String?) {
        guard resolvingCheckpointID == nil, !submittedIDs.contains(checkpoint.id), !expired(checkpoint),
              checkpoint.status == "pending", errorMessage == nil, detail?.workflow.isFinished != true else { return }
        HapticManager.shared.impact(.medium)
        resolvingCheckpointID = checkpoint.id
        checkpointErrors[checkpoint.id] = nil
        Task {
            defer { resolvingCheckpointID = nil }
            do {
                #if DEBUG
                if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_WORKFLOW"] == "server-expired" {
                    throw APIError.server(500, "That decision expired — ask me again and I'll re-check.")
                }
                #endif
                try await HomeBoardService.resolveCheckpoint(workflowId: workflowId, checkpointId: checkpoint.id,
                                                             approved: approved, choice: choice)
                submittedIDs.insert(checkpoint.id)
                await load(quiet: true)
                onChanged?()
            } catch {
                if let apiError = error as? APIError, case let .server(_, message) = apiError,
                   message.localizedCaseInsensitiveContains("decision expired") {
                    expiredIDs.insert(checkpoint.id)
                    checkpointErrors[checkpoint.id] = nil
                } else {
                    checkpointErrors[checkpoint.id] = "Couldn't send that answer. Try again."
                }
            }
        }
    }

    #if DEBUG
    private static func sampleDetail(_ mode: String) throws -> WorkflowDetail {
        func iso(_ secondsAgo: Double) -> String { Date().addingTimeInterval(-secondsAgo).oxyISO8601String }
        let json = """
        {"workflow":{"id":"sample-workflow","goal":"Order the headphones from John Lewis","status":"waiting_for_user"},
        "timeline":[{"id":"e1","kind":"started","summary":"Started looking for the headphones","actor":"adam","created_at":"\(iso(180))"},
        {"id":"e2","kind":"found","summary":"Found them at John Lewis for £54.20","actor":"adam","created_at":"\(iso(120))"},
        {"id":"e3","kind":"asked","summary":"Asked you to approve the payment","actor":"adam","created_at":"\(iso(60))"}],
        "pendingCheckpoints":[{"id":"sample-decision","type":"payment_confirmation","status":"pending","prompt":"Place the order for £54.20?"}],
        "documents":[{"id":"d1","filename":"order-summary-john-lewis-headphones.pdf","label":"Order summary","mime_type":"application/pdf","byte_size":48211}]}
        """
        guard var object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            throw CocoaError(.coderReadCorrupt)
        }
        if mode == "choice" {
            object["pendingCheckpoints"] = [["id": "sample-choice", "type": "choice_required", "status": "pending", "prompt": "Choose a delivery option", "options": [["id":"standard", "label":"Standard delivery", "detail":"Thursday · Free"], ["id":"express", "label":"Express delivery", "detail":"Tuesday · £5"]]]]
        }
        if mode == "expired" {
            object["pendingCheckpoints"] = [["id":"sample-expired", "type":"payment_confirmation", "status":"pending", "prompt":"Place the order for £54.20?", "expires_at": iso(60)]]
        }
        if mode == "completed" {
            object["workflow"] = ["id":"sample-workflow", "goal":"Check the headphone price", "status":"completed"]
            object["pendingCheckpoints"] = []
            object["timeline"] = [["id":"sample-complete", "kind":"completed", "summary":"Price checked: £54.20 at John Lewis", "actor":"adam", "created_at":iso(60)]]
        }
        if mode == "empty" { object["timeline"] = []; object["documents"] = []; object["pendingCheckpoints"] = [] }
        return try JSONDecoder().decode(WorkflowDetail.self, from: JSONSerialization.data(withJSONObject: object))
    }
    #endif
}

private struct TimelineRow: View {
    let event: WorkflowEvent
    let isFirst: Bool
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Circle().fill(isFirst ? Color.appAccent : Color.appMuted).frame(width: 7, height: 7)
                Rectangle().fill(isLast ? Color.clear : Color.appHairline).frame(width: 1)
            }
            .frame(width: 8)
            .padding(.top, 7)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(event.summary ?? "Update").font(.body.weight(isFirst ? .medium : .regular))
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text(event.date.map { $0.formatted(date: Calendar.current.isDateInToday($0) ? .omitted : .abbreviated, time: .shortened) } ?? "Time unavailable")
                    .font(.caption).foregroundStyle(Color.appMuted)
                if event.isUser { Text("You").font(.caption).foregroundStyle(Color.appMuted) }
            }
            .padding(.bottom, 22)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}
