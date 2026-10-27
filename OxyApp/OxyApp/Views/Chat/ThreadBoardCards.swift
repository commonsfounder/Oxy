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
    /// What Adam knows about the home (devices, watches, things noticed). Nil until the first read.
    private(set) var home: HomeModel?
    var offlineDevices: [HomeModel.Device] { home?.devices.filter { !$0.online } ?? [] }

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
        if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_HOME"] != nil, !isSample {
            board = .empty
            home = Self.sampleHome
            hasLoaded = true
            refreshFailed = false
            return
        }
        if isSample || (PreviewData.isIsolated && ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "decision-failure") {
            board = Self.sampleBoard
            deviceOnline = true
            home = Self.sampleHome
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
        if let fetched = try? await HomeService.fetch() { home = fetched }
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
    static var sampleHome: HomeModel {
        switch ProcessInfo.processInfo.environment["OXY_DEBUG_HOME"] {
        case "empty": return .empty
        case "offline": return YourHomeView.sampleOffline
        case "online": return YourHomeView.sampleOnline
        default: return YourHomeView.sampleConnected
        }
    }

    static let sampleBoard: HomeBoard = {
        let failedOutcome = ProcessInfo.processInfo.environment["OXY_DEBUG_OUTCOME_FAILURE"] == "1"
        let outcomeTitle = failedOutcome ? "Book the boiler service" : "Booked the boiler service"
        let outcomeDetail = failedOutcome ? "British Gas had no slots this week" : "Thursday 09:00"
        let stamp = { (seconds: Double) in ISO8601DateFormatter().string(from: Date.now.addingTimeInterval(-seconds)) }
        let json = """
        {"needsYou":[{"id":"n1","kind":"checkpoint","title":"Order washing-up liquid and bin bags?","detail":"Up to £8.40 · Card ending 4242 · Arrives tomorrow","workflowId":"w1","checkpointId":"c1"}],
         "handling":[{"id":"h2","kind":"task","title":"Finding a plumber for the kitchen tap","workflowId":"w3","taskId":"t3","progress":{"done":2,"total":5}}],
         "changed":[{"id":"u1","kind":"notice","title":"Parcel left in the porch","detail":"Royal Mail","at":"\(stamp(600))"}],"completed":[{"id":"workflow-x","workflowId":"w9","kind":"booking","title":"\(outcomeTitle)","detail":"\(outcomeDetail)","failed":\(failedOutcome),"at":"\(stamp(5400))"}],"counts":{"needsYou":1,"handling":1,"changed":1,"completed":1}}
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

/// The parts of what Adam knows that a surface can show.
enum BoardSection: CaseIterable {
    case devices, decisions, work, noticed, watching
}

/// What Adam knows right now. Each kind of information has its own form: a device is a sentence,
/// an approval is a receipt, work in progress is a ladder of steps, a happening is a timed line.
struct ThreadBoardCards: View {
    var model: ThreadBoardModel
    var askedInThread: [String] = []
    var sections: Set<BoardSection> = Set(BoardSection.allCases)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var openWorkflow: OpenWorkflow?

    private var large: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xxl) {
            if sections.contains(.devices), !model.offlineDevices.isEmpty {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    ForEach(model.offlineDevices) { device in deviceSentence(device) }
                }
            }
            if sections.contains(.decisions) {
                ForEach(model.needsYou.prefix(3)) { item in
                    VStack(alignment: .leading, spacing: AppSpacing.md) {
                        decision(item).id("board-decision-\(item.id)")
                        if let taskID = item.taskId { LiveWorkPreview(taskID: taskID, hidesWhenEmpty: true) }
                    }
                }
            }
            if sections.contains(.work) {
                ForEach(model.working.prefix(3)) { item in work(item).id("board-work-\(item.id)") }
            }
            if sections.contains(.noticed), !noticed.isEmpty { noticedList }
            if sections.contains(.watching), let watches = model.home?.watches, !watches.isEmpty {
                watchingList(watches)
            }
            if model.refreshFailed && !model.isEmpty {
                Text("Couldn't refresh. Showing what was saved.")
                    .font(.role(.footnote)).foregroundStyle(Color.appMuted)
            }
            if let message = model.errorMessage {
                Text(message).font(.role(.footnote)).foregroundStyle(Color.appMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .appSpring, value: model.needsYou.map(\.id))
        .animation(reduceMotion ? nil : .appSpring, value: model.acknowledged)
        .sheet(item: $openWorkflow) { open in
            WorkflowTimelineView(workflowId: open.id, onChanged: { Task { await model.refresh() } })
        }
    }

    private func groupLabel(_ text: String) -> some View {
        Text(text).font(.role(.footnote, weight: .semibold)).foregroundStyle(Color.appMuted)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Device: a sentence with a status dot

    private func deviceSentence(_ device: HomeModel.Device) -> some View {
        let seen = device.lastSeenAt.flatMap(DisplayTimestampParser.date(from:))
        let text = seen.map { "\(device.name) is offline. Last seen \(Self.when($0))." }
            ?? "\(device.name) hasn't connected yet."
        return HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
            StatusDot(color: Color.appMuted.opacity(0.45))
            Text(text).font(.role(.body)).foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Short enough for the time column: 14:05 today, otherwise the day.
    static func column(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            : date.formatted(.dateTime.weekday(.abbreviated))
    }

    static func when(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return time }
        if calendar.isDateInYesterday(date) { return "yesterday \(time)" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    // MARK: Approval: a receipt

    @ViewBuilder
    private func decision(_ item: BoardItem) -> some View {
        if model.submittingDecisions.contains(item.id) {
            decisionStatus(item, sending: true)
        } else if model.acknowledged[item.id] != nil {
            decisionStatus(item, sending: false)
        } else {
            receipt(item)
        }
    }

    private func decisionStatus(_ item: BoardItem, sending: Bool) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack(spacing: AppSpacing.md) {
                ProgressView().tint(Color.appAccent)
                Text(sending ? "Sending your answer" : "Waiting for confirmation")
                    .font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
            }
            Text(acknowledgedLine(item)).font(.role(.callout)).foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
            if !sending && (model.refreshFailed || model.decisionReadbackErrors.contains(item.id)) {
                Text("Answer sent. Status unavailable.").font(.role(.callout)).foregroundStyle(Color.appMuted)
                Button("Check status") { Task { await model.refresh() } }
                    .font(.role(.callout, weight: .semibold)).foregroundStyle(Color.appAccent)
                    .frame(minHeight: 44)
            }
        }
        .padding(.top, AppSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Color.appInk.frame(height: 1.5) }
        .accessibilityElement(children: .contain)
    }

    private func acknowledgedLine(_ item: BoardItem) -> String {
        let facts = ApprovalFacts(detail: item.detail)
        guard let amount = facts.amount else { return title(for: item) }
        return "\(amount) · \(title(for: item))"
    }

    private func receipt(_ item: BoardItem) -> some View {
        let facts = ApprovalFacts(detail: item.detail == title(for: item) ? nil : item.detail)
        return VStack(alignment: .leading, spacing: AppSpacing.md) {
            if let amount = facts.amount {
                HStack(alignment: .firstTextBaseline, spacing: AppSpacing.sm) {
                    Text(amount)
                        .font(.system(size: large ? 34 : 44, weight: .bold)).tracking(-1.2).monospacedDigit()
                        .foregroundStyle(Color.appInk).minimumScaleFactor(0.6).lineLimit(1)
                    if let qualifier = facts.qualifier {
                        Text(qualifier.lowercased() == "up to" ? "at most" : qualifier.lowercased())
                            .font(.role(.callout, weight: .medium)).foregroundStyle(Color.appMuted)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Text(title(for: item))
                .font(.role(.title))
                .foregroundStyle(Color.appInk)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                if let digits = facts.card { receiptLine("Card", "ending \(digits)") }
                ForEach(facts.others, id: \.self) { line in
                    let pair = Self.keyValue(line)
                    receiptLine(pair.key, pair.value)
                }
            }
            if let error = model.decisionErrors[item.id] {
                Text(error).font(.role(.callout)).foregroundStyle(Color.appDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let workflowID = item.workflowId {
                pill("Review", primary: true) { openWorkflow = OpenWorkflow(id: workflowID) }
                    .disabled(model.refreshFailed)
                    .opacity(model.refreshFailed ? 0.45 : 1)
            } else {
                actions(for: item)
            }
        }
        .padding(.top, AppSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Color.appInk.frame(height: 1.5) }
        .accessibilityElement(children: .contain)
    }

    /// "Arrives tomorrow" reads as a fact with a name; anything else stays one line.
    private static func keyValue(_ line: String) -> (key: String?, value: String) {
        let keys = ["Arrives", "Delivery", "Due", "From", "To", "Starts", "Ends", "Renews"]
        for key in keys where line.hasPrefix(key + " ") {
            return (key, String(line.dropFirst(key.count + 1)))
        }
        return (nil, line)
    }

    private func receiptLine(_ label: String?, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            if let label {
                Text(label).font(.role(.callout)).foregroundStyle(Color.appMuted)
                Spacer(minLength: AppSpacing.md)
                Text(value).font(.role(.callout)).foregroundStyle(Color.appInk).multilineTextAlignment(.trailing)
            } else {
                Text(value).font(.role(.callout)).foregroundStyle(Color.appInk)
                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, AppSpacing.sm + 2)
        .overlay(alignment: .top) { Color.appHairline.frame(height: 0.5) }
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
    private func actions(for item: BoardItem) -> some View {
        if item.hasDecision, let options = item.options, !options.isEmpty {
            VStack(alignment: .leading, spacing: AppSpacing.sm) {
                ForEach(options) { option in
                    pill(option.label, primary: option.id == options.first?.id) {
                        Task { await model.decide(item, approved: true, choice: option.id) }
                    }
                }
            }
        } else if item.hasDecision {
            let layout = large
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: AppSpacing.sm))
                : AnyLayout(HStackLayout(spacing: AppSpacing.sm))
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
                .font(.role(.callout, weight: .semibold))
                .foregroundColor(primary ? Color.appOnAction : Color.appInk)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, AppSpacing.xl)
                .padding(.vertical, large ? AppSpacing.md : 0)
                .frame(maxWidth: large ? .infinity : nil, minHeight: 48, alignment: large ? .leading : .center)
                .background(
                    RoundedRectangle(cornerRadius: large ? AppRadius.control : 24, style: .continuous)
                        .fill(primary ? Color.appAction : Color.appInk.opacity(0.08))
                )
        }
        .buttonStyle(.appScale(0.97))
    }

    // MARK: Work: a ladder of steps with Stop

    @ViewBuilder
    private func work(_ item: BoardItem) -> some View {
        if item.taskId == nil && item.progress == nil {
            sentenceRow(item)
        } else {
            ladder(item)
        }
    }

    private func sentenceRow(_ item: BoardItem) -> some View {
        Button {
            if let id = item.workflowId { openWorkflow = OpenWorkflow(id: id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                StatusDot(color: Color.appWorking, hollow: true)
                Text(title(for: item)).font(.role(.body)).foregroundStyle(Color.appInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(item.workflowId == nil)
        .accessibilityLabel("Working on \(title(for: item))")
    }

    private func ladder(_ item: BoardItem) -> some View {
        let isStopping = model.stopping.contains(item.id)
        return VStack(alignment: .leading, spacing: AppSpacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                Button {
                    if let id = item.workflowId { openWorkflow = OpenWorkflow(id: id) }
                } label: {
                    Text(title(for: item)).font(.role(.body, weight: .semibold)).foregroundStyle(Color.appInk)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(item.workflowId == nil)
                if item.taskId != nil {
                    Button { Task { await model.stop(item) } } label: {
                        Text(isStopping ? "Stopping…" : "Stop")
                            .font(.role(.callout, weight: .semibold)).foregroundStyle(Color.appInk)
                            .padding(.horizontal, AppSpacing.lg).frame(minHeight: 44)
                            .overlay(Capsule().stroke(Color.appCardOutline, lineWidth: 1))
                    }
                    .buttonStyle(.appScale(0.95))
                    .disabled(isStopping)
                    .accessibilityLabel("Stop \(title(for: item))")
                }
            }
            if let progress = item.progress, progress.total > 0 {
                StepLadder(done: progress.done, total: progress.total)
            } else if item.waitingExternal == true {
                Text("Waiting for a reply").font(.role(.callout)).foregroundStyle(Color.appMuted)
            }
            if let detail = item.detail, !detail.isEmpty, detail != title(for: item) {
                Text(detail).font(.role(.callout)).foregroundStyle(Color.appMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let taskID = item.taskId { LiveWorkPreview(taskID: taskID, hidesWhenEmpty: true) }
        }
    }

    // MARK: Noticed: timed lines

    private struct Line: Identifiable {
        let id: String
        let date: Date?
        let title: String
        let detail: String?
        var failed = false
        var workflowID: String?
        var finished: BoardItem?
    }

    /// Everything that happened, newest first: what devices sensed, finished work, updates and sounds heard.
    private var noticed: [Line] {
        let outcomes = model.finished.filter { !ThreadBoardModel.isEchoOfThread($0, asked: askedInThread) }.suffix(4)
        var lines = outcomes.map {
            Line(id: "o-\($0.id)", date: $0.date, title: $0.title, detail: $0.detail,
                 failed: $0.failed == true, workflowID: $0.workflowId, finished: $0)
        }
        lines += model.board.changed.prefix(4).map {
            Line(id: "c-\($0.id)", date: $0.date, title: $0.title, detail: $0.detail, workflowID: $0.workflowId)
        }
        lines += (model.home?.observations ?? []).prefix(6).map {
            Line(id: "s-\($0.id)", date: DisplayTimestampParser.date(from: $0.at), title: $0.summary, detail: $0.room)
        }
        if SoundClipStore.shared.isEnabled {
            let dayAgo = Date().addingTimeInterval(-86_400)
            lines += SoundClipStore.shared.clips.filter { $0.heardAt > dayAgo }.prefix(3).map {
                Line(id: "h-\($0.id)", date: $0.heardAt, title: "Heard \($0.title.lowercased())", detail: nil)
            }
        }
        return Array(lines.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }.prefix(6))
    }

    private var noticedList: some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            groupLabel("Noticed").id("board-noticed")
            VStack(alignment: .leading, spacing: AppSpacing.lg) {
                ForEach(noticed) { line in
                    timedLine(line)
                        .id("board-outcome-\(line.id)")
                        .onAppear { if let item = line.finished { model.markFinishedSeen(item) } }
                }
            }
        }
    }

    private func timedLine(_ line: Line) -> some View {
        let layout = large
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AppSpacing.xs))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AppSpacing.md))
        let content = layout {
            Text(line.date.map(Self.column) ?? "")
                .font(.reading(.footnote)).foregroundStyle(Color.appMuted)
                .lineLimit(1)
                .frame(width: large ? nil : 48, alignment: .leading)
                .accessibilityLabel(line.date.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "")
            VStack(alignment: .leading, spacing: 2) {
                if line.failed {
                    Text("Couldn't finish").font(.role(.footnote, weight: .semibold)).foregroundStyle(Color.appDanger)
                }
                Text(line.title).font(.role(.callout, weight: .medium)).foregroundStyle(Color.appInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = line.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
                    Text(detail).font(.role(.callout)).foregroundStyle(Color.appMuted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        return Group {
            if let id = line.workflowID {
                Button { openWorkflow = OpenWorkflow(id: id) } label: { content }.buttonStyle(.plain)
            } else {
                content
            }
        }
    }

    // MARK: Watching: one sentence per standing request

    private func watchingList(_ watches: [HomeModel.Watch]) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.md) {
            groupLabel("Watching")
            ForEach(watches.prefix(4)) { watch in
                HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                    StatusDot(color: Color.appWorking, hollow: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(watch.title).font(.role(.callout, weight: .medium)).foregroundStyle(Color.appInk)
                        if let detail = watch.detail, !detail.isEmpty {
                            Text(detail).font(.role(.callout)).foregroundStyle(Color.appMuted)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// A status dot that sits on the text's x-height at every type size.
struct StatusDot: View {
    var color: Color
    var hollow = false
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 8
    @ScaledMetric(relativeTo: .body) private var lift: CGFloat = 0.5

    var body: some View {
        Group {
            if hollow { Circle().strokeBorder(color, lineWidth: 1.5) } else { Circle().fill(color) }
        }
        .frame(width: size, height: size)
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] + lift }
        .accessibilityHidden(true)
    }
}

/// How far a piece of work has got: one segment per step, finished ones filled.
private struct StepLadder: View {
    let done: Int
    let total: Int

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            if total <= 12 {
                HStack(spacing: 4) {
                    ForEach(0..<total, id: \.self) { index in
                        Capsule()
                            .fill(index < done ? Color.appWorking
                                  : index == done ? Color.appWorking.opacity(0.35) : Color.appHairline)
                            .frame(height: 5)
                    }
                }
                .accessibilityHidden(true)
            } else {
                ProgressView(value: Double(done), total: Double(total)).tint(Color.appWorking)
                    .accessibilityHidden(true)
            }
            Text(done >= total ? "All \(total) steps done" : "\(done) of \(total) steps done")
                .font(.role(.footnote)).foregroundStyle(Color.appMuted)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct OpenWorkflow: Identifiable {
    let id: String
}
