import SwiftUI

/// One responsibility, watched.
///
/// Nothing in this app has ever shown long-running work actually progressing. A
/// backgrounded job was a single static line on Home with no steps and no motion. This
/// screen polls the responsibility while it is open and animates each new event in as it
/// lands, so the work is legible while it happens rather than only after it finishes.
struct WorkflowTimelineView: View {
    let workflowId: String
    var onChanged: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    @State private var detail: WorkflowDetail?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var resolvingCheckpointID: String?
    @State private var seenEventIDs = Set<String>()

    /// Fast while the work is live. A finished responsibility stops polling entirely —
    /// there is nothing left to arrive.
    private static let livePoll: Duration = .seconds(3)

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    header

                    if let errorMessage {
                        ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                    }

                    if isLoading && detail == nil {
                        ProgressView()
                            .tint(Color.appMuted)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    } else if let detail {
                        ForEach(detail.pendingCheckpoints) { checkpoint in
                            checkpointCard(checkpoint)
                        }

                        if !detail.documents.isEmpty {
                            documentsSection(detail.documents)
                        }

                        timelineSection(detail.timeline)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 60)
            }
            .refreshable { await load() }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await load()
            while !Task.isCancelled {
                guard detail?.workflow.isFinished != true else { break }
                try? await Task.sleep(for: Self.livePoll)
                guard !Task.isCancelled else { break }
                await load(quiet: true)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button {
                    HapticManager.shared.impact(.light)
                    dismiss()
                } label: {
                    AppIcon("chevron-left", size: 18)
                        .foregroundStyle(Color.appMuted)
                        .padding(8)
                }
                .buttonStyle(.appScale)
                Spacer()
            }
            .padding(.leading, -8)

            if let workflow = detail?.workflow {
                VStack(alignment: .leading, spacing: 8) {
                    Text(workflow.goal)
                        .font(.pageTitle)
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        if !workflow.isFinished {
                            PulsingWorkDot(active: true)
                        } else {
                            AppIcon(workflow.status == "completed" ? "check-circle" : "alert-circle", size: 14)
                                .foregroundStyle(workflow.status == "completed"
                                                 ? Color.appAccent
                                                 : Color.appDestructive)
                        }
                        Text(workflow.plainStatus)
                            .font(.appBody(13, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    // MARK: - The decision that stopped the work

    private func checkpointCard(_ checkpoint: WorkflowCheckpoint) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 9) {
                AppIcon("bolt", size: 15)
                    .foregroundStyle(Color.appAccent)
                    .padding(.top, 1)
                Text(checkpoint.prompt)
                    .font(.appBody(16, weight: .medium))
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }

            if resolvingCheckpointID == checkpoint.id {
                ProgressView()
                    .tint(Color.appMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if checkpoint.isChoice, let options = checkpoint.options {
                VStack(spacing: 6) {
                    ForEach(options) { option in
                        Button {
                            resolve(checkpoint, approved: true, choice: option.label)
                        } label: {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(option.label)
                                        .font(.rowTitle)
                                        .foregroundStyle(Color.appInk)
                                    if let detail = option.detail, !detail.isEmpty {
                                        Text(detail)
                                            .font(.appBody(12))
                                            .foregroundStyle(Color.appMuted)
                                    }
                                }
                                Spacer(minLength: 0)
                                AppIcon("chevron-right", size: 12)
                                    .foregroundStyle(Color.appMuted)
                            }
                            .padding(.horizontal, 13)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.settingsRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.appScale(0.98))
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Button { resolve(checkpoint, approved: true, choice: nil) } label: {
                        Text("Yes, do it")
                            .font(.appBody(15, weight: .medium))
                            .foregroundStyle(Color.appOnAction)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(Capsule().fill(Color.appAction))
                    }
                    .buttonStyle(.appScale(0.97))

                    Button { resolve(checkpoint, approved: false, choice: nil) } label: {
                        Text("Not now")
                            .font(.appBody(15, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(Capsule().fill(Color.appInk.opacity(0.10)))
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsSurface(radius: 20)
    }

    // MARK: - What it gathered

    private func documentsSection(_ documents: [WorkflowDocument]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Files")
                .font(.sectionLabel)
                .foregroundStyle(Color.appMuted)

            ForEach(documents) { document in
                HStack(spacing: 10) {
                    AppIcon("doc", size: 14)
                        .foregroundStyle(Color.appMuted)
                    Text(document.displayName)
                        .font(.appBody(14, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let size = document.sizeText {
                        Text(size)
                            .font(.appBody(12, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Color.settingsRaised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    // MARK: - Timeline

    private func timelineSection(_ events: [WorkflowEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What happened")
                .font(.sectionLabel)
                .foregroundStyle(Color.appMuted)

            VStack(alignment: .leading, spacing: 0) {
                // Newest first: the interesting end of a live job is the most recent thing.
                ForEach(Array(events.reversed().enumerated()), id: \.element.id) { index, event in
                    TimelineRow(
                        event: event,
                        isFirst: index == 0,
                        isLast: index == events.count - 1
                    )
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity
                    ))
                }
            }
        }
    }

    // MARK: - Data

    private func load(quiet: Bool = false) async {
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_WORKFLOW"] == "1" {
            let json = #"{"workflow":{"id":"w1","goal":"Order the headphones from John Lewis","status":"waiting_for_user"},"timeline":[{"id":"e1","kind":"started","summary":"Started looking for the headphones","actor":"adam","created_at":"2026-10-06T21:00:00Z"},{"id":"e2","kind":"found","summary":"Found them at John Lewis for £54.20","actor":"adam","created_at":"2026-10-06T21:02:00Z"},{"id":"e3","kind":"asked","summary":"Asked you to approve the payment","actor":"adam","created_at":"2026-10-06T21:03:00Z"}],"pendingCheckpoints":[{"id":"c1","type":"payment_confirmation","status":"pending","prompt":"Place the order for £54.20?"}],"documents":[{"id":"d1","filename":"receipt.pdf","label":"Order summary","mime_type":"application/pdf","byte_size":48211}]}"#
            detail = try? JSONDecoder().decode(WorkflowDetail.self, from: Data(json.utf8))
            isLoading = false
            return
        }
        #endif
        if !quiet { isLoading = true }
        do {
            let fetched = try await HomeBoardService.fetchWorkflow(id: workflowId)
            let arriving = Set(fetched.timeline.map(\.id)).subtracting(seenEventIDs)
            // Only animate genuinely new rows. Animating the whole list on every poll made
            // the screen twitch every three seconds.
            if !seenEventIDs.isEmpty && !arriving.isEmpty {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { detail = fetched }
                HapticManager.shared.impact(.light)
            } else {
                detail = fetched
            }
            seenEventIDs = Set(fetched.timeline.map(\.id))
            errorMessage = nil
        } catch {
            if !quiet { errorMessage = "Couldn't load this." }
        }
        isLoading = false
    }

    private func resolve(_ checkpoint: WorkflowCheckpoint, approved: Bool, choice: String?) {
        HapticManager.shared.impact(.medium)
        resolvingCheckpointID = checkpoint.id
        Task {
            do {
                try await HomeBoardService.resolveCheckpoint(
                    workflowId: workflowId,
                    checkpointId: checkpoint.id,
                    approved: approved,
                    choice: choice
                )
                await load(quiet: true)
                onChanged?()
            } catch {
                errorMessage = "Couldn't send that answer."
            }
            resolvingCheckpointID = nil
        }
    }
}

// MARK: - Row

private struct TimelineRow: View {
    let event: WorkflowEvent
    let isFirst: Bool
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // The rail: a dot per event, joined by a hairline, so the sequence reads as one
            // continuous thread rather than a stack of unrelated rows.
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : Color.appMuted)
                    .frame(width: 1, height: 8)
                Circle()
                    .fill(isFirst ? Color.appAccent : Color.appMuted)
                    .frame(width: isFirst ? 8 : 6, height: isFirst ? 8 : 6)
                Rectangle()
                    .fill(isLast ? Color.clear : Color.appMuted)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.summary ?? event.kind)
                    .font(.appBody(15, weight: isFirst ? .medium : .regular))
                    .foregroundStyle((isFirst ? Color.appInk : Color.appMuted))
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 6) {
                    if event.isUser {
                        Text("You")
                            .font(.appBody(12, weight: .semibold))
                            .foregroundStyle(Color.appAccent.opacity(0.8))
                    }
                    if let relative = event.date?.oxyRelativeShort {
                        Text(relative)
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                    }
                }
            }
            .padding(.bottom, 14)

            Spacer(minLength: 0)
        }
    }
}
