import SwiftUI

/// Loads what needs the user and what Adam is working on, for display inside the thread.
@MainActor
@Observable
final class ThreadBoardModel {
    private(set) var board: HomeBoard = .empty
    private(set) var resolvedIDs = Set<String>()
    /// Cards answered a moment ago, kept on screen briefly so the answer registers. Value is whether it was approved.
    private(set) var acknowledged: [String: Bool] = [:]
    /// Work the user asked to stop: "stopping" until the server confirms, then "stopped".
    private(set) var stopping = Set<String>()
    private(set) var stopped = Set<String>()
    /// Work that finished since the user last saw it. Stays for the session so a result never vanishes unread.
    private(set) var finished: [BoardItem] = []
    private var seenFinishedIDs = Set<String>()
    var errorMessage: String?
    /// True when a paired Adam device has checked in within the last few minutes.
    private(set) var deviceOnline = false

    private static let seenKey = "adam_thread_seen_finished"

    private var isSample: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1"
        #else
        false
        #endif
    }

    var needsYou: [BoardItem] { board.needsYou.filter { !resolvedIDs.contains($0.id) } }
    var working: [BoardItem] { board.handling.filter { !stopped.contains($0.id) } }
    var isEmpty: Bool { needsYou.isEmpty && working.isEmpty && finished.isEmpty }

    init() {
        let stored = UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? []
        seenFinishedIDs = Set(stored)
    }

    func refresh() async {
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            board = Self.sampleBoard
            deviceOnline = true
            absorbFinished()
            return
        }
        #endif
        if let fetched = try? await HomeBoardService.fetchBoard() {
            board = fetched
            absorbFinished()
        }
        if let displays = try? await PairedDisplaysService.fetchDisplays() {
            deviceOnline = displays.contains { display in
                guard let raw = display.lastSeenAt, let seen = DisplayTimestampParser.date(from: raw) else { return false }
                return Date().timeIntervalSince(seen) < 180
            }
        }
    }

    /// The first ever load only records what already exists, so old history never appears as news.
    private func absorbFinished() {
        if !isSample, UserDefaults.standard.object(forKey: Self.seenKey) == nil {
            seenFinishedIDs = Set(board.completed.map(\.id))
            persistSeen()
            return
        }
        for item in board.completed
        where !seenFinishedIDs.contains(item.id) && !finished.contains(where: { $0.id == item.id }) {
            finished.append(item)
        }
    }

    static func normalized(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "…", with: "")
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    /// A finished item whose title is just something the user typed here is the same turn the thread
    /// already shows; a card for it would be a duplicate with the user's own words as its title.
    static func isEchoOfThread(_ item: BoardItem, asked: [String]) -> Bool {
        let title = normalized(item.title)
        guard title.count >= 4 else { return false }
        return asked.contains { $0.contains(title) || title.contains($0) && $0.count >= 4 }
    }

    func markFinishedSeen(_ item: BoardItem) {
        seenFinishedIDs.insert(item.id)
        persistSeen()
    }

    private func persistSeen() {
        guard !isSample else { return }
        UserDefaults.standard.set(Array(seenFinishedIDs.suffix(200)), forKey: Self.seenKey)
    }

    #if DEBUG
    static let sampleBoard: HomeBoard = {
        let json = """
        {"needsYou":[{"id":"n1","kind":"checkpoint","title":"Place the order?","detail":"Up to £60 · Card ending 4242 · Arrives Thursday","workflowId":"w1","checkpointId":"c1"}],
         "handling":[{"id":"h1","kind":"watch","title":"Message Arina at 16:04","workflowId":"w2"},{"id":"h2","kind":"task","title":"Booking a haircut","workflowId":"w3","taskId":"t3","progress":{"done":2,"total":3}}],
         "changed":[],"completed":[{"id":"workflow-x","workflowId":"w9","kind":"purchase","title":"Ordered the headphones","detail":"£54.20 · arrives Thursday","at":"2026-09-29T17:00:00Z"}],"counts":{"needsYou":1,"handling":2,"changed":0,"completed":1}}
        """
        return (try? JSONDecoder().decode(HomeBoard.self, from: Data(json.utf8))) ?? .empty
    }()
    #endif

    func stop(_ item: BoardItem) async {
        guard let taskId = item.taskId, !stopping.contains(item.id) else { return }
        stopping.insert(item.id)
        HapticManager.shared.impact(.medium)
        do {
            if !isSample { try await AgentTasksService.stopTask(id: taskId) }
            stopping.remove(item.id)
            stopped.insert(item.id)
            await refresh()
        } catch {
            stopping.remove(item.id)
            HapticManager.shared.error()
            errorMessage = "Couldn't stop that. Try again."
        }
    }

    func decide(_ item: BoardItem, approved: Bool, choice: String? = nil) async {
        guard let workflowId = item.workflowId, let checkpointId = item.checkpointId,
              acknowledged[item.id] == nil else { return }
        acknowledged[item.id] = approved
        if approved { HapticManager.shared.success() } else { HapticManager.shared.impact(.light) }
        do {
            #if DEBUG
            let isSample = ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1"
            #else
            let isSample = false
            #endif
            if !isSample { try await HomeBoardService.resolveCheckpoint(
                workflowId: workflowId,
                checkpointId: checkpointId,
                approved: approved,
                choice: choice
            ) }
            try? await Task.sleep(for: .milliseconds(isSample ? 8000 : 1500))
            resolvedIDs.insert(item.id)
            acknowledged[item.id] = nil
            await refresh()
        } catch {
            acknowledged[item.id] = nil
            HapticManager.shared.error()
            errorMessage = "That didn't go through. Try again."
        }
    }
}

/// What an approval is about, pulled from the one-line detail the server sends ("Up to £60 · Card ending 4242").
struct ApprovalFacts: Equatable {
    var qualifier: String?
    var amount: String?
    var card: String?
    var others: [String] = []

    var isEmpty: Bool { amount == nil && card == nil && others.isEmpty }

    init(detail: String?) {
        guard let detail else { return }
        let parts = detail.components(separatedBy: " · ")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        for part in parts {
            if amount == nil, let found = Self.money(in: part) {
                qualifier = found.qualifier
                amount = found.amount
            } else if card == nil, let digits = Self.cardDigits(in: part) {
                card = digits
            } else {
                others.append(part)
            }
        }
    }

    private static func money(in text: String) -> (qualifier: String?, amount: String)? {
        let pattern = #"^(up to|about|total|around)?\s*([£$€]\s?\d[\d,]*(?:\.\d{1,2})?)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let amountRange = Range(match.range(at: 2), in: text) else { return nil }
        let qualifier = Range(match.range(at: 1), in: text).map { String(text[$0]).lowercased() }
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        return (qualifier, String(text[amountRange]).replacingOccurrences(of: " ", with: ""))
    }

    private static func cardDigits(in text: String) -> String? {
        let lower = text.lowercased()
        guard lower.contains("card") || text.contains("••••") else { return nil }
        guard let regex = try? NSRegularExpression(pattern: #"(\d{4})\s*$"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}

/// Approval and progress cards that sit at the end of the thread.
struct ThreadBoardCards: View {
    var model: ThreadBoardModel
    var askedInThread: [String] = []
    @State private var openWorkflow: OpenWorkflow?
    @Namespace private var handoff

    /// The same piece of work keeps one identity while it is being done and while it waits for a yes.
    private func handoffID(_ item: BoardItem) -> String { item.workflowId ?? item.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(model.finished.filter { !ThreadBoardModel.isEchoOfThread($0, asked: askedInThread) }.suffix(3)) { item in
                FinishedCard(item: item, onOpen: { id in openWorkflow = OpenWorkflow(id: id) }, onSeen: { model.markFinishedSeen(item) })
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            ForEach(model.working.prefix(3)) { item in
                workingChip(item)
                    .matchedGeometryEffect(id: handoffID(item), in: handoff)
                    .transition(.opacity)
            }
            ForEach(model.needsYou.prefix(3)) { item in
                needsYouCard(item)
                    .matchedGeometryEffect(id: handoffID(item), in: handoff)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if let message = model.errorMessage {
                Text(message)
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
            }
        }
        .padding(.trailing, 32)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.appSpring, value: model.needsYou.map(\.id))
        .animation(.appSpring, value: model.acknowledged)
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

    @ViewBuilder
    private func needsYouCard(_ item: BoardItem) -> some View {
        if let approved = model.acknowledged[item.id] {
            acknowledgedCard(item, approved: approved)
        } else {
            openCard(item)
        }
    }

    private func acknowledgedCard(_ item: BoardItem, approved: Bool) -> some View {
        HStack(spacing: 12) {
            if approved {
                CheckBadge()
            } else {
                AdamDot(solid: false, size: 14)
                    .frame(width: 32, height: 32)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(approved ? "Approved" : "Not now")
                    .font(.appBody(16, weight: .medium))
                    .foregroundStyle(Color.appInk)
                Text(acknowledgedLine(item))
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsSurface(radius: 22)
        .accessibilityElement(children: .combine)
    }

    private func acknowledgedLine(_ item: BoardItem) -> String {
        let facts = ApprovalFacts(detail: item.detail)
        guard let amount = facts.amount else { return title(for: item) }
        return "\(amount) · \(title(for: item))"
    }

    private func openCard(_ item: BoardItem) -> some View {
        let facts = ApprovalFacts(detail: item.detail == title(for: item) ? nil : item.detail)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Needs a yes")
                        .font(.appBody(12, weight: .semibold))
                        .foregroundStyle(Color.appNeedsYou)
                    Text(title(for: item))
                        .font(.appBody(17, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                AdamActivityMark(state: .waiting, size: 52)
            }
            if !facts.isEmpty { receipt(facts) }
            actions(for: item)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsSurface(radius: 22)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(openCardLabel(item))
    }

    /// What would be spent and from what: the amount large, the rest quietly beneath.
    private func receipt(_ facts: ApprovalFacts) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let amount = facts.amount {
                VStack(alignment: .leading, spacing: 2) {
                    if let qualifier = facts.qualifier {
                        Text(qualifier)
                            .font(.appBody(12, weight: .medium))
                            .foregroundStyle(Color.appMuted)
                    }
                    Text(amount)
                        .font(.appEditorial(28, weight: 400, soft: 30, wonk: false, relativeTo: .title1))
                        .foregroundStyle(Color.appInk)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }
            }
            if facts.card != nil || !facts.others.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let digits = facts.card {
                        HStack(spacing: 8) {
                            AppIcon("card", size: 15).foregroundStyle(Color.appMuted)
                            Text("•••• \(digits)")
                                .font(.appBody(14, weight: .medium))
                                .foregroundStyle(Color.appInk)
                        }
                    }
                    ForEach(facts.others, id: \.self) { line in
                        Text(line)
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.appBackground.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.7))
        .accessibilityElement(children: .combine)
    }

    private func openCardLabel(_ item: BoardItem) -> String {
        var parts = ["Needs a yes", title(for: item)]
        if let detail = item.detail, !detail.isEmpty, detail != title(for: item) { parts.append(detail) }
        return parts.joined(separator: ". ")
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
                .foregroundColor(primary ? Color.appOnAction : Color.appInk)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(Capsule().fill(primary ? Color.appAction : Color.appInk.opacity(0.10)))
        }
        .buttonStyle(.appScale(0.97))
    }

    private func workingChip(_ item: BoardItem) -> some View {
        let isStopping = model.stopping.contains(item.id)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                AdamActivityMark(state: .working, size: 26)
                Text(title(for: item))
                    .font(.appBody(14, weight: .medium))
                    .foregroundStyle(Color.appWorking)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if item.taskId != nil {
                    Button {
                        Task { await model.stop(item) }
                    } label: {
                        Text(isStopping ? "Stopping…" : "Stop")
                            .font(.appBody(13, weight: .semibold))
                            .foregroundStyle(Color.appInk)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(Color.appBackground))
                    }
                    .buttonStyle(.appScale(0.95))
                    .disabled(isStopping)
                    .accessibilityLabel("Stop \(title(for: item))")
                }
            }
            if let progress = item.progress {
                ProgressView(value: progress.fraction)
                    .tint(Color.appWorking)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, item.taskId != nil ? 4 : 14)
        .padding(.vertical, item.taskId != nil ? 2 : 10)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.appWorking.opacity(0.10)))
        .contentShape(Rectangle())
        .onTapGesture {
            if let workflowId = item.workflowId { openWorkflow = OpenWorkflow(id: workflowId) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Working on \(title(for: item))")
        .accessibilityAddTraits(item.workflowId != nil ? .isButton : [])
    }
}

/// A finished piece of work: the tick draws, then the detail settles in under the title.
private struct FinishedCard: View {
    let item: BoardItem
    var onOpen: (String) -> Void
    var onSeen: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var detailShown = false

    private var failed: Bool { item.failed == true }
    private var detail: String? {
        guard let text = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    var body: some View {
        Button {
            if let id = item.workflowId { onOpen(id) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                if failed {
                    Circle().fill(Color.appDanger.opacity(0.14))
                        .frame(width: 32, height: 32)
                        .overlay(Text("!").font(.appBody(16, weight: .semibold)).foregroundStyle(Color.appDanger))
                } else {
                    CheckBadge()
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(failed ? "Couldn't finish" : item.title)
                        .font(.appBody(16, weight: .medium))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if failed {
                        Text(item.title)
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                    }
                    if let detail {
                        Text(detail)
                            .font(.appBody(13))
                            .foregroundStyle(Color.appMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .opacity(detailShown ? 1 : 0)
                            .offset(y: detailShown || reduceMotion ? 0 : 6)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface(radius: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
        .disabled(item.workflowId == nil)
        .accessibilityElement(children: .combine)
        .onAppear {
            onSeen()
            if failed { HapticManager.shared.warning() } else { HapticManager.shared.success() }
            if reduceMotion { detailShown = true; return }
            withAnimation(.appSpring.delay(0.4)) { detailShown = true }
        }
    }
}

/// A green circle whose tick draws itself.
private struct CheckBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false

    var body: some View {
        ZStack {
            Circle().fill(Color.appDone)
            CheckShape()
                .trim(from: 0, to: drawn ? 1 : 0)
                .stroke(Color.white, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                .padding(9)
        }
        .frame(width: 32, height: 32)
        .scaleEffect(drawn || reduceMotion ? 1 : 0.6)
        .onAppear {
            if reduceMotion { drawn = true; return }
            withAnimation(.spring(response: 0.32, dampingFraction: 0.7)) { drawn = true }
        }
        .accessibilityHidden(true)
    }
}

private struct CheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.05))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.12))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.12))
        return path
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
