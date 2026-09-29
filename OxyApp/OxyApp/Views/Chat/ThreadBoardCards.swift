import SwiftUI

/// Loads what needs the user and what Adam is working on, for display inside the thread.
@MainActor
@Observable
final class ThreadBoardModel {
    private(set) var board: HomeBoard = .empty
    private(set) var resolvedIDs = Set<String>()
    var errorMessage: String?

    var needsYou: [BoardItem] { board.needsYou.filter { !resolvedIDs.contains($0.id) } }
    var working: [BoardItem] { board.handling }
    var isEmpty: Bool { needsYou.isEmpty && working.isEmpty }

    func refresh() async {
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            board = Self.sampleBoard
            return
        }
        #endif
        if let fetched = try? await HomeBoardService.fetchBoard() {
            board = fetched
        }
    }

    #if DEBUG
    private static let sampleBoard: HomeBoard = {
        let json = """
        {"needsYou":[{"id":"n1","kind":"checkpoint","title":"Place the order?","detail":"Up to £60 · Card ending 4242","workflowId":"w1","checkpointId":"c1"}],
         "handling":[{"id":"h1","kind":"watch","title":"Message Arina at 16:04","workflowId":"w2"},{"id":"h2","kind":"task","title":"Booking a haircut","workflowId":"w3","progress":{"done":2,"total":3}}],
         "changed":[],"completed":[],"counts":{"needsYou":1,"handling":2,"changed":0,"completed":0}}
        """
        return (try? JSONDecoder().decode(HomeBoard.self, from: Data(json.utf8))) ?? .empty
    }()
    #endif

    func decide(_ item: BoardItem, approved: Bool, choice: String? = nil) async {
        guard let workflowId = item.workflowId, let checkpointId = item.checkpointId else { return }
        resolvedIDs.insert(item.id)
        do {
            try await HomeBoardService.resolveCheckpoint(
                workflowId: workflowId,
                checkpointId: checkpointId,
                approved: approved,
                choice: choice
            )
            HapticManager.shared.impact(.medium)
            await refresh()
        } catch {
            resolvedIDs.remove(item.id)
            errorMessage = "That didn't go through. Try again."
        }
    }
}

/// Approval and progress cards that sit at the end of the thread.
struct ThreadBoardCards: View {
    var model: ThreadBoardModel
    @State private var openWorkflow: OpenWorkflow?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(model.needsYou.prefix(3)) { item in
                needsYouCard(item)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            ForEach(model.working.prefix(3)) { item in
                workingChip(item)
                    .transition(.opacity)
            }
            if let message = model.errorMessage {
                Text(message)
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.appSpring, value: model.needsYou.map(\.id))
        .sheet(item: $openWorkflow) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await model.refresh() } })
        }
    }

    private func title(for item: BoardItem) -> String {
        let generic = item.title.lowercased().contains("needs your approval")
        if generic {
            if let prompt = item.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty { return prompt }
            if let detail = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty { return detail }
        }
        return item.title
    }

    private func needsYouCard(_ item: BoardItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Needs a yes")
                .font(.appBody(12, weight: .semibold))
                .foregroundStyle(Color.appNeedsYou)
            Text(title(for: item))
                .font(.appBody(16, weight: .medium))
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = item.detail, !detail.isEmpty, detail != title(for: item) {
                Text(detail)
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions(for: item)
                .padding(.top, 8)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Color.appCardOutline, lineWidth: 1))
    }

    @ViewBuilder
    private func actions(for item: BoardItem) -> some View {
        if item.hasDecision, let options = item.options, !options.isEmpty {
            FlowRow(spacing: 8) {
                ForEach(options) { option in
                    pill(option.label, primary: option.id == options.first?.id) {
                        Task { await model.decide(item, approved: true, choice: option.id) }
                    }
                }
            }
        } else if item.hasDecision {
            HStack(spacing: 8) {
                pill("Yes, do it", primary: true) { Task { await model.decide(item, approved: true) } }
                pill("Not yet", primary: false) { Task { await model.decide(item, approved: false) } }
            }
        } else if let workflowId = item.workflowId {
            pill("Open", primary: true) { openWorkflow = OpenWorkflow(id: workflowId) }
        }
    }

    private func pill(_ label: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            Text(label)
                .font(.appBody(15, weight: .medium))
                .foregroundStyle(primary ? Color.appOnAction : Color.appInk)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(Capsule().fill(primary ? Color.appAction : Color.appUserBubble))
        }
        .buttonStyle(.appScale(0.97))
    }

    private func workingChip(_ item: BoardItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title(for: item))
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(Color.appWorking)
            if let progress = item.progress {
                ProgressView(value: progress.fraction)
                    .tint(Color.appWorking)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.appWorking.opacity(0.10)))
        .onTapGesture {
            if let workflowId = item.workflowId { openWorkflow = OpenWorkflow(id: workflowId) }
        }
    }
}

private struct OpenWorkflow: Identifiable {
    let id: String
}

/// Lays out children left to right and wraps onto new lines.
private struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins)
    }
}
