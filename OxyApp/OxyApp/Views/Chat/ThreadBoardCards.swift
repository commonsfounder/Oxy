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
        PreviewData.isIsolated && ["1", "quiet"].contains(ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] ?? "")
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
        if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "quiet" {
            let sample = Self.sampleBoard
            board = HomeBoard(generatedAt: nil, lastSeenAt: nil, needsYou: [], handling: sample.handling,
                              changed: sample.changed, completed: sample.completed, counts: sample.counts)
            home = Self.sampleHome
            hasLoaded = true
            refreshFailed = false
            absorbFinished()
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

