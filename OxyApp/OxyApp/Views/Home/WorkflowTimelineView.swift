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
            GlebChrome.pastelBlob.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    header

                    if let errorMessage {
                        ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                    }

                    if isLoading && detail == nil {
                        ProgressView()
                            .tint(GlebChrome.ink.opacity(0.4))
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
                        .foregroundStyle(GlebChrome.ink.opacity(0.6))
                        .padding(8)
                }
                .buttonStyle(.appScale)
                Spacer()
            }
            .padding(.leading, -8)

            if let workflow = detail?.workflow {
                VStack(alignment: .leading, spacing: 8) {
                    Text(workflow.goal)
                        .font(.system(size: 27, weight: .regular))
                        .foregroundStyle(GlebChrome.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        if !workflow.isFinished {
                            PulsingWorkDot(active: true)
                        } else {
                            AppIcon(workflow.status == "completed" ? "check-circle" : "alert-circle", size: 14)
                                .foregroundStyle(workflow.status == "completed"
                                                 ? Color.appAccent
                                                 : Color.red.opacity(0.6))
                        }
                        Text(workflow.plainStatus)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(GlebChrome.ink.opacity(0.6))
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
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(GlebChrome.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }

            if resolvingCheckpointID == checkpoint.id {
                ProgressView()
                    .tint(GlebChrome.ink.opacity(0.4))
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
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(GlebChrome.ink)
                                    if let detail = option.detail, !detail.isEmpty {
                                        Text(detail)
                                            .font(.system(size: 12))
                                            .foregroundStyle(GlebChrome.ink.opacity(0.5))
                                    }
                                }
                                Spacer(minLength: 0)
                                AppIcon("chevron-right", size: 12)
                                    .foregroundStyle(GlebChrome.ink.opacity(0.3))
                            }
                            .padding(.horizontal, 13)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.45)))
                        }
                        .buttonStyle(.appScale(0.98))
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Button { resolve(checkpoint, approved: true, choice: nil) } label: {
                        Text("Approve")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(GlebChrome.ink)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Capsule().fill(Color.appAccent.opacity(0.22)))
                    }
                    .buttonStyle(.appScale(0.97))

                    Button { resolve(checkpoint, approved: false, choice: nil) } label: {
                        Text("Not now")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(GlebChrome.ink.opacity(0.6))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Capsule().fill(Color.white.opacity(0.4)))
                    }
                    .buttonStyle(.appScale(0.97))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { MissionGlassPlate() }
    }

    // MARK: - What it gathered

    private func documentsSection(_ documents: [WorkflowDocument]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FILES")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.3)
                .foregroundStyle(GlebChrome.ink.opacity(0.42))

            ForEach(documents) { document in
                HStack(spacing: 10) {
                    AppIcon("doc", size: 14)
                        .foregroundStyle(GlebChrome.ink.opacity(0.45))
                    Text(document.displayName)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(GlebChrome.ink.opacity(0.85))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let size = document.sizeText {
                        Text(size)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(GlebChrome.ink.opacity(0.35))
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.34)))
            }
        }
    }

    // MARK: - Timeline

    private func timelineSection(_ events: [WorkflowEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("TIMELINE")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.3)
                .foregroundStyle(GlebChrome.ink.opacity(0.42))

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
                    .fill(isFirst ? Color.clear : GlebChrome.ink.opacity(0.13))
                    .frame(width: 1, height: 8)
                Circle()
                    .fill(isFirst ? Color.appAccent : GlebChrome.ink.opacity(0.25))
                    .frame(width: isFirst ? 8 : 6, height: isFirst ? 8 : 6)
                Rectangle()
                    .fill(isLast ? Color.clear : GlebChrome.ink.opacity(0.13))
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.summary ?? event.kind)
                    .font(.system(size: 14, weight: isFirst ? .semibold : .regular))
                    .foregroundStyle(GlebChrome.ink.opacity(isFirst ? 0.95 : 0.72))
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 6) {
                    if event.isUser {
                        Text("You")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.appAccent.opacity(0.8))
                    }
                    if let relative = event.date?.oxyRelativeShort {
                        Text(relative)
                            .font(.system(size: 11))
                            .foregroundStyle(GlebChrome.ink.opacity(0.35))
                    }
                }
            }
            .padding(.bottom, 14)

            Spacer(minLength: 0)
        }
    }
}
