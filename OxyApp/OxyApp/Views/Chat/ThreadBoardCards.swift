import SwiftUI

/// Loads what needs the user and what Adam is working on, for display inside the thread.
@MainActor
@Observable
final class ThreadBoardModel {
    private(set) var board: HomeBoard = .empty
    private(set) var resolvedCheckpointIDs = Set<String>()
    /// Answers accepted by the server, awaiting fresh pending-list readback. Value is the submitted decision.
    private(set) var acknowledged: [String: Bool] = [:]
    private(set) var submittingDecisions = Set<String>()
    private(set) var decisionErrors: [String: String] = [:]
    private(set) var decisionReadbackErrors = Set<String>()
    private var decisionRequests: [String: (workflowID: String, checkpointID: String)] = [:]
    private var submittedDecisionItems: [String: BoardItem] = [:]
    var hasDecisionReadback: Bool { !acknowledged.isEmpty }
    /// Work the user asked to stop: "stopping" until the server confirms, then "stopped".
    private(set) var stopping = Set<String>()
    private(set) var stopped = Set<String>()
    /// Work that finished since the user last saw it. Stays for the session so a result never vanishes unread.
    private(set) var finished: [BoardItem] = []
    private var seenFinishedIDs = Set<String>()
    var errorMessage: String?
    private(set) var hasLoaded = false
    private(set) var refreshFailed = false
    private var refreshing = false
    /// True when a paired Adam device has checked in within the last few minutes.
    private(set) var deviceOnline = false

    private static let seenKey = "adam_thread_seen_finished"

    private var isSample: Bool {
        #if DEBUG
        PreviewData.isIsolated && ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1"
        #else
        false
        #endif
    }

    var needsYou: [BoardItem] {
        var items = board.needsYou.filter { item in
            item.checkpointId.map { !resolvedCheckpointIDs.contains($0) } ?? true
        }
        for (id, submitted) in submittedDecisionItems
        where acknowledged[id] != nil || submittingDecisions.contains(id) {
            if let index = items.firstIndex(where: { $0.id == id }) {
                items[index] = submitted
            } else {
                items.insert(submitted, at: 0)
            }
        }
        return items
    }
    var working: [BoardItem] { board.handling.filter { !stopped.contains($0.id) } }
    var isEmpty: Bool { needsYou.isEmpty && working.isEmpty && finished.isEmpty && board.changed.isEmpty }
    var hasUnavailableSources: Bool { !(board.unavailableSources ?? []).isEmpty }

    init() {
        let stored = UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? []
        // A sample launch must not inherit receipts marked seen by an earlier fixture.
        // Real sessions retain their saved history, and sample sessions never persist this set.
        seenFinishedIDs = isSample ? [] : Set(stored)
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        #if DEBUG
        if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "partial" {
            board = .empty
            board.unavailableSources = ["tasks"]
            hasLoaded = true
            refreshFailed = false
            return
        }
        if isSample || (PreviewData.isIsolated && ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "decision-failure") {
            board = Self.sampleBoard
            deviceOnline = true
            hasLoaded = true
            refreshFailed = false
            absorbFinished()
            return
        }
        #endif
        do {
            board = try await HomeBoardService.fetchBoard()
            hasLoaded = true
            refreshFailed = false
            absorbFinished()
        } catch {
            refreshFailed = true
        }
        await verifyDecisionReplies()
        if let displays = try? await PairedDisplaysService.fetchDisplays() {
            deviceOnline = displays.contains { display in
                guard let raw = display.lastSeenAt, let seen = DisplayTimestampParser.date(from: raw) else { return false }
                return Date().timeIntervalSince(seen) < 180
            }
        } else { deviceOnline = false }
    }

    private func verifyDecisionReplies() async {
        for (id, approved) in acknowledged {
            guard let request = decisionRequests[id] else { continue }
            do {
                let detail = try await HomeBoardService.fetchWorkflow(id: request.workflowID)
                guard detail.workflow.id == request.workflowID else {
                    decisionReadbackErrors.insert(id)
                    continue
                }
                let confirmed = detail.timeline.contains { event in
                    event.kind == "checkpoint_resolved" && event.refType == "checkpoint" && event.refId == request.checkpointID
                }
                guard confirmed else {
                    decisionReadbackErrors.insert(id)
                    continue
                }
                decisionReadbackErrors.remove(id)
                resolvedCheckpointIDs.insert(request.checkpointID)
                acknowledged[id] = nil
                decisionRequests[id] = nil
                submittedDecisionItems[id] = nil
                decisionErrors[id] = nil
                if approved { HapticManager.shared.success() }
                else { HapticManager.shared.impact(.light) }
            } catch {
                decisionReadbackErrors.insert(id)
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
        let failedOutcome = ProcessInfo.processInfo.environment["OXY_DEBUG_OUTCOME_FAILURE"] == "1"
        let outcomeTitle = failedOutcome ? "Compare headphone prices" : "Compared headphone prices"
        let outcomeDetail = failedOutcome ? "The source was unavailable" : "Lowest price £54.20"
        let json = """
        {"needsYou":[{"id":"n1","kind":"checkpoint","title":"Place the order?","detail":"Up to £60 · Card ending 4242 · Arrives Thursday","workflowId":"w1","checkpointId":"c1"}],
         "handling":[{"id":"h1","kind":"watch","title":"Message Arina at 16:04","workflowId":"w2"},{"id":"h2","kind":"task","title":"Booking a haircut","workflowId":"w3","taskId":"t3","progress":{"done":2,"total":3}}],
         "changed":[{"id":"u1","kind":"notice","title":"A parcel is out for delivery","detail":"Due this afternoon","at":"\(ISO8601DateFormatter().string(from: Date.now.addingTimeInterval(-600)))"}],"completed":[{"id":"workflow-x","workflowId":"w9","kind":"purchase","title":"\(outcomeTitle)","detail":"\(outcomeDetail)","failed":\(failedOutcome),"at":"\(ISO8601DateFormatter().string(from: Date.now.addingTimeInterval(-1800)))"}],"counts":{"needsYou":1,"handling":2,"changed":1,"completed":1}}
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

    #if DEBUG
    private var checkedDecisionFailure = false

    func checkDecisionFailurePreview() async {
        guard PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "decision-failure",
              !checkedDecisionFailure, let item = needsYou.first else { return }
        checkedDecisionFailure = true
        await decide(item, approved: true)
    }
    #endif

    func decide(_ item: BoardItem, approved: Bool, choice: String? = nil) async {
        guard let workflowId = item.workflowId, let checkpointId = item.checkpointId,
              acknowledged[item.id] == nil, !submittingDecisions.contains(item.id),
              !resolvedCheckpointIDs.contains(checkpointId) else { return }
        submittingDecisions.insert(item.id)
        submittedDecisionItems[item.id] = item
        decisionErrors[item.id] = nil
        defer { submittingDecisions.remove(item.id) }
        do {
            #if DEBUG
            if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "decision-failure" {
                try await Task.sleep(for: .seconds(8))
            }
            #endif
            try await HomeBoardService.resolveCheckpoint(
                workflowId: workflowId,
                checkpointId: checkpointId,
                approved: approved,
                choice: choice
            )
            decisionRequests[item.id] = (workflowId, checkpointId)
            acknowledged[item.id] = approved
            await refresh()
        } catch {
            submittedDecisionItems[item.id] = nil
            HapticManager.shared.error()
            decisionErrors[item.id] = "Couldn't confirm your answer. Check work before trying again."
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
    var isOverview = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var openWorkflow: OpenWorkflow?
    @Namespace private var handoff

    /// The same piece of work keeps one identity while it is being done and while it waits for a yes.
    private func handoffID(_ item: BoardItem) -> String { item.workflowId ?? item.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isOverview && model.refreshFailed {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.hasLoaded ? "Couldn't refresh work" : "Couldn't load work")
                        .font(.appBody(17, weight: .semibold)).foregroundStyle(Color.appInk)
                    if model.hasLoaded && !model.isEmpty {
                        Text("Showing saved work").font(.appBody(14)).foregroundStyle(Color.appMuted)
                    }
                    Button("Try again") { Task { await model.refresh() } }
                        .font(.appBody(15, weight: .semibold)).foregroundStyle(Color.appAccent)
                        .frame(minHeight: 44)
                }
            } else if isOverview && !model.hasLoaded {
                ProgressView("Loading work").font(.appBody(15)).foregroundStyle(Color.appMuted)
            }
            if isOverview && model.hasUnavailableSources {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Some work is unavailable").font(.appBody(17, weight: .semibold)).foregroundStyle(Color.appInk)
                    Button("Try again") { Task { await model.refresh() } }
                        .font(.appBody(15, weight: .semibold)).foregroundStyle(Color.appAccent).frame(minHeight: 44)
                }
            }
            if !model.needsYou.isEmpty {
                ForEach(model.needsYou.prefix(3)) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        needsYouCard(item)
                            .id("board-decision-\(item.id)")
                            .matchedGeometryEffect(id: handoffID(item), in: handoff)
                        if let taskID = item.taskId { LiveWorkPreview(taskID: taskID) }
                    }.transition(.opacity)
                }
            }
            if !model.working.isEmpty {
                if isOverview {
                    VStack(alignment: .leading, spacing: 4) {
                        sectionTitle("In progress").padding(.bottom, 8)
                        ForEach(model.working.prefix(3)) { item in
                            workingOverviewRow(item)
                                .id("board-work-\(item.id)")
                                .matchedGeometryEffect(id: handoffID(item), in: handoff)
                                .transition(.opacity)
                        }
                    }
                    .padding(.top, model.needsYou.isEmpty ? 0 : 16)
                    .id("board-work")
                } else {
                    ForEach(model.working.prefix(3)) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            workingChip(item)
                                .matchedGeometryEffect(id: handoffID(item), in: handoff)
                            if let taskID = item.taskId { LiveWorkPreview(taskID: taskID) }
                        }.transition(.opacity)
                    }
                }
            }
            let outcomes = model.finished.filter { !ThreadBoardModel.isEchoOfThread($0, asked: askedInThread) }.suffix(3)
            if !outcomes.isEmpty {
                if isOverview { sectionTitle("Recent outcomes").padding(.top, 8).id("board-outcomes") }
                ForEach(outcomes) { item in
                    Group {
                        if isOverview { outcomeOverviewRow(item) }
                        else {
                            FinishedCard(item: item, onOpen: { id in openWorkflow = OpenWorkflow(id: id) }, onSeen: { model.markFinishedSeen(item) })
                        }
                    }.transition(.opacity)
                }
            }
            if !model.board.changed.isEmpty {
                if isOverview { sectionTitle("Updates").padding(.top, 8).id("board-updates") }
                ForEach(model.board.changed.prefix(3)) { item in
                    updateRow(item)
                }
            }
            if isOverview && model.hasLoaded && !model.refreshFailed && !model.hasUnavailableSources && model.isEmpty {
                HStack(spacing: 14) {
                    AppIcon("check", size: 22).foregroundStyle(Color.appMuted)
                    Text("No work waiting")
                        .font(.appBody(17, weight: .medium)).foregroundStyle(Color.appInk)
                }
                .padding(.vertical, 12)
            }
            if let message = model.errorMessage {
                Text(message)
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .appSpring, value: model.needsYou.map(\.id))
        .animation(reduceMotion ? nil : .appSpring, value: model.acknowledged)
        .sheet(item: $openWorkflow) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await model.refresh() } })
        }
    }

    private func updateRow(_ item: BoardItem) -> some View {
        Group {
            if let workflowID = item.workflowId {
                Button { openWorkflow = OpenWorkflow(id: workflowID) } label: { updateContent(item) }
                    .buttonStyle(.plain)
            } else {
                updateContent(item)
            }
        }
    }

    private func updateContent(_ item: BoardItem) -> some View {
        HStack(alignment: .top, spacing: 14) {
            AppIcon("wheel-activity", size: 22).foregroundStyle(Color.appMuted)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(.appBody(17, weight: .medium)).foregroundStyle(Color.appInk)
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail).font(.appBody(14)).foregroundStyle(Color.appMuted)
                }
                if let date = item.date {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.appBody(12)).foregroundStyle(Color.appMuted)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if item.workflowId != nil { AppIcon("chevron-right", size: 13).foregroundStyle(Color.appMuted) }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.sectionTitle).foregroundStyle(Color.appInk)
            .accessibilityAddTraits(.isHeader)
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
        if submittingState(item) {
            decisionStatusCard(item, sending: true)
        } else if model.acknowledged[item.id] != nil {
            decisionStatusCard(item, sending: false)
        } else if isOverview {
            decisionFocalCard(item)
        } else {
            openCard(item)
        }
    }

    private func submittingState(_ item: BoardItem) -> Bool {
        model.submittingDecisions.contains(item.id)
    }

    private func decisionStatusCard(_ item: BoardItem, sending: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ProgressView().tint(Color.appAccent)
                    .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text(sending ? "Sending answer" : "Updating")
                        .font(.appBody(16, weight: .medium))
                        .foregroundStyle(Color.appInk)
                    Text(acknowledgedLine(item))
                        .font(.appBody(13))
                        .foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if !sending && (model.refreshFailed || model.decisionReadbackErrors.contains(item.id)) {
                Text("Answer sent. Status unavailable.")
                    .font(.appBody(14)).foregroundStyle(Color.appMuted)
                Button("Check status") { Task { await model.refresh() } }
                    .font(.appBody(15, weight: .semibold)).foregroundStyle(Color.appAccent)
                    .frame(minHeight: 44)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsSurface(radius: 22)
        .accessibilityElement(children: .contain)
    }

    private func acknowledgedLine(_ item: BoardItem) -> String {
        let facts = ApprovalFacts(detail: item.detail)
        guard let amount = facts.amount else { return title(for: item) }
        return "\(amount) · \(title(for: item))"
    }

    private func decisionFocalCard(_ item: BoardItem) -> some View {
        let facts = ApprovalFacts(detail: item.detail == title(for: item) ? nil : item.detail)
        return VStack(alignment: .leading, spacing: 12) {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 16))
            layout {
                Text(title(for: item))
                    .font(typeSize.isAccessibilitySize ? .headline : .title2.weight(.bold))
                    .tracking(typeSize.isAccessibilitySize ? 0 : -0.45)
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let amount = facts.amount {
                    VStack(alignment: .leading, spacing: 2) {
                        if let qualifier = facts.qualifier {
                            Text(qualifier).font(.appBody(13, weight: .medium))
                        }
                        Text(amount).font(typeSize.isAccessibilitySize ? .headline : .title3.weight(.bold)).monospacedDigit()
                    }
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
                    .accessibilityElement(children: .combine)
                }
            }
            if facts.card != nil || !facts.others.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let digits = facts.card {
                        HStack(spacing: 8) {
                            AppIcon("card", size: 17).accessibilityHidden(true)
                            Text("•••• \(digits)").font(.appBody(15, weight: .medium))
                        }
                    }
                    ForEach(facts.others, id: \.self) { line in
                        Text(line).font(.appBody(14))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .foregroundStyle(Color.appInk)
                .accessibilityElement(children: .combine)
            }
            if let error = model.decisionErrors[item.id] {
                Text(error).font(.appBody(14)).foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let workflowID = item.workflowId {
                Button { openWorkflow = OpenWorkflow(id: workflowID) } label: {
                    HStack(spacing: 12) {
                        Text("Review decision").font(.appBody(16, weight: .semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        AppIcon("arrow-up-right", size: 18)
                    }
                    .foregroundStyle(Color.appOnAccent)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(minHeight: 48, alignment: .leading)
                    .background(Color.appAccent, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.appScale)
                .disabled(model.refreshFailed)
                .opacity(model.refreshFailed ? 0.45 : 1)
            } else {
                actions(for: item)
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
        .accessibilityElement(children: .contain)
    }

    private func openCard(_ item: BoardItem) -> some View {
        let facts = ApprovalFacts(detail: item.detail == title(for: item) ? nil : item.detail)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    if !isOverview {
                        Text("Needs your approval")
                            .font(.appBody(12, weight: .semibold))
                            .foregroundStyle(Color.appNeedsYou)
                    }
                    Text(title(for: item))
                        .font(typeSize.isAccessibilitySize ? .headline : .appRounded(24, weight: .semibold, relativeTo: .title2))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if !typeSize.isAccessibilitySize { AdamActivityMark(state: .waiting, size: 40) }
            }
            if !facts.isEmpty { receipt(facts) }
            if let error = model.decisionErrors[item.id] {
                Text(error).font(.appBody(14)).foregroundStyle(Color.appDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isOverview, let workflowID = item.workflowId {
                pill("Review decision", primary: true) { openWorkflow = OpenWorkflow(id: workflowID) }
                    .disabled(model.refreshFailed)
                    .opacity(model.refreshFailed ? 0.45 : 1)
            } else {
                actions(for: item)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .contain)
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
                        .font(.appRounded(34, weight: .semibold, relativeTo: .title1))
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
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Color.appHairline.frame(height: 0.5) }
        .accessibilityElement(children: .combine)
    }

    private func openCardLabel(_ item: BoardItem) -> String {
        var parts = ["Needs your approval", title(for: item)]
        if let detail = item.detail, !detail.isEmpty, detail != title(for: item) { parts.append(detail) }
        return parts.joined(separator: ". ")
    }

    @ViewBuilder
    private func actions(for item: BoardItem) -> some View {
        if item.hasDecision, let options = item.options, !options.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(options) { option in
                    pill(option.label, primary: option.id == options.first?.id) {
                        Task { await model.decide(item, approved: true, choice: option.id) }
                    }
                }
            }
        } else if item.hasDecision {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                pill("Approve", primary: true) { Task { await model.decide(item, approved: true) } }
                pill("Decline", primary: false) { Task { await model.decide(item, approved: false) } }
            }
        } else if let workflowId = item.workflowId {
            pill("View work", primary: true) { openWorkflow = OpenWorkflow(id: workflowId) }
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
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 18)
                .padding(.vertical, typeSize.isAccessibilitySize ? 12 : 0)
                .frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : nil, minHeight: 44, alignment: typeSize.isAccessibilitySize ? .leading : .center)
                .background {
                    if typeSize.isAccessibilitySize {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(primary ? Color.appAction : Color.appInk.opacity(0.10))
                    } else {
                        Capsule().fill(primary ? Color.appAction : Color.appInk.opacity(0.10))
                    }
                }
        }
        .buttonStyle(.appScale(0.97))
    }

    private func workingOverviewRow(_ item: BoardItem) -> some View {
        let isStopping = model.stopping.contains(item.id)
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        return VStack(alignment: .leading, spacing: 4) {
        layout {
            Group {
                if let workflowID = item.workflowId {
                    Button { openWorkflow = OpenWorkflow(id: workflowID) } label: { workingOverviewContent(item) }
                        .buttonStyle(.plain)
                } else {
                    workingOverviewContent(item)
                }
            }
            if item.taskId != nil {
                Button { Task { await model.stop(item) } } label: {
                    Text(isStopping ? "Stopping…" : "Stop")
                        .font(.appBody(14, weight: .medium)).foregroundStyle(Color.appInk)
                        .padding(.horizontal, 14).frame(minHeight: 44)
                        .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.appScale)
                .disabled(isStopping)
                .accessibilityLabel("Stop \(title(for: item))")
            }
        }
            if let taskID = item.taskId {
                LiveWorkPreview(taskID: taskID, compact: true)
                    .padding(.leading, typeSize.isAccessibilitySize ? 0 : 44)
            }
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
    }

    private func outcomeOverviewRow(_ item: BoardItem) -> some View {
        let failed = item.failed == true
        return Group {
            if let workflowID = item.workflowId {
                Button { openWorkflow = OpenWorkflow(id: workflowID) } label: {
                    outcomeOverviewContent(item, failed: failed)
                }.buttonStyle(.appScale)
            } else {
                outcomeOverviewContent(item, failed: failed)
            }
        }
        .id("board-outcome-\(item.id)")
        .onAppear { model.markFinishedSeen(item) }
    }

    private func outcomeOverviewContent(_ item: BoardItem, failed: Bool) -> some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        outcomeMark(failed: failed)
                        Spacer(minLength: 0)
                        if item.workflowId != nil {
                            AppIcon("arrow-up-right", size: 16).foregroundStyle(Color.appMuted)
                                .accessibilityHidden(true)
                        }
                    }
                    outcomeFacts(item, failed: failed)
                }
            } else {
                HStack(alignment: .top, spacing: 14) {
                    outcomeMark(failed: failed)
                    outcomeFacts(item, failed: failed)
                    if item.workflowId != nil {
                        AppIcon("arrow-up-right", size: 16).foregroundStyle(Color.appMuted)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func outcomeMark(failed: Bool) -> some View {
        AppIcon(failed ? "alert-circle" : "check", size: 20)
            .foregroundStyle(failed ? Color.appDanger : Color.appSuccess)
            .frame(width: 32, height: 32)
            .background((failed ? Color.appDanger : Color.appSuccess).opacity(0.10),
                        in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }

    private func outcomeFacts(_ item: BoardItem, failed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
                if failed {
                    Text("Couldn't finish").font(.appBody(14, weight: .semibold)).foregroundStyle(Color.appDanger)
                }
                Text(item.title).font(.appBody(17, weight: .semibold)).foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = item.detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(detail).font(.appBody(20, weight: .medium)).foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let date = item.date {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.appBody(12)).foregroundStyle(Color.appMuted)
                }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func workingOverviewContent(_ item: BoardItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AppIcon(item.waitingExternal == true ? "clock" : "wheel-activity", size: 22)
                .foregroundStyle(Color.appWorking)
                .frame(width: 32, height: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(title(for: item)).font(.appBody(17, weight: .medium)).foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = item.detail, !detail.isEmpty, detail != title(for: item) {
                    Text(detail).font(.appBody(14)).foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let progress = item.progress, progress.total > 0 {
                    ProgressView(value: progress.fraction).tint(Color.appWorking)
                        .accessibilityLabel("Progress")
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            if item.workflowId != nil {
                AppIcon("chevron-right", size: 12).foregroundStyle(Color.appMuted).frame(minHeight: 44)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
