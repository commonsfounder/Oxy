import SwiftUI

// MARK: - Model

/// What kind of thing an entry is. These are Adam's verbs; chat messages and reactions are none of them.
enum ActivityKind: String, Codable {
    case noticed, did, asked, scheduled, checked

    var label: String {
        switch self {
        case .noticed: return "Noticed"
        case .did: return "Did"
        case .asked: return "Asked you"
        case .scheduled: return "Scheduled"
        case .checked: return "Checked"
        }
    }
}

struct ActivityEvent: Codable, Identifiable, Equatable {
    let id: String
    let type: ActivityKind
    let title: String
    let detail: String?
    let at: String?
    let failed: Bool?
    let open: Bool?
    let stale: Bool?
    let workflowId: String?

    var date: Date? { at.flatMap(Date.oxyParse) }
    var isFailure: Bool { failed == true }
}

struct ActivityFeed: Codable, Equatable {
    let events: [ActivityEvent]
    let asks: [ActivityEvent]
    let upcoming: [ActivityEvent]

    static let empty = ActivityFeed(events: [], asks: [], upcoming: [])
}

enum ActivityService {
    static func fetch() async throws -> ActivityFeed {
        let data = try await APIClient.shared.request(path: "/agent/activity")
        return try JSONDecoder().decode(ActivityFeed.self, from: data)
    }
}

// MARK: - View

/// Adam's record of what it noticed, did, asked and scheduled. Conversation lives in Chat.
struct AdamActivityView: View {
    private enum Filter: String, CaseIterable, Identifiable {
        case all = "All", done = "Done", comingUp = "Coming up"
        var id: String { rawValue }
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var filter: Filter = .all
    @State private var feed: ActivityFeed = .empty
    @State private var isLoading = false
    @State private var loaded = false
    @State private var errorMessage: String?
    @State private var expandedID: String?
    @State private var openWorkflowID: String?

    private var asks: [ActivityEvent] { filter == .done ? [] : feed.asks }

    private var upcoming: [ActivityEvent] {
        filter == .done ? [] : feed.upcoming
    }

    private var past: [ActivityEvent] {
        switch filter {
        case .all: return feed.events
        case .done: return feed.events.filter { $0.type == .did && !$0.isFailure }
        case .comingUp: return []
        }
    }

    private var isEmpty: Bool { asks.isEmpty && upcoming.isEmpty && past.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Activity")
                            .font(.appEditorial(28, weight: 400, soft: 30, wonk: false, relativeTo: .largeTitle))
                            .foregroundStyle(Color.appInk)
                            .accessibilityAddTraits(.isHeader)
                        filterBar
                    }

                    if let errorMessage {
                        ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                    } else if isEmpty && loaded {
                        emptyState
                    } else {
                        if !asks.isEmpty { section("Waiting on you", asks) }
                        if !upcoming.isEmpty { section("Coming up", upcoming) }
                        if !past.isEmpty { section(filter == .done ? "Done" : "Recently", past) }
                    }
                }
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 18)
                .padding(.bottom, 40)
            }
            .background(Color.appBackground.ignoresSafeArea())
            .refreshable { await load() }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await load() }
        .fullScreenCover(item: Binding(
            get: { openWorkflowID.map(ActivityWorkflow.init) },
            set: { openWorkflowID = $0?.id }
        )) { workflow in
            WorkflowTimelineView(workflowId: workflow.id, onChanged: { Task { await load() } })
                .swipeToDismiss()
        }
    }

    // MARK: Pieces

    private var filterBar: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(spacing: 6))
        return layout {
            ForEach(Filter.allCases) { item in
                Button {
                    guard filter != item else { return }
                    HapticManager.shared.select()
                    withAnimation(.appStandard) { filter = item }
                } label: {
                    Text(item.rawValue)
                        .font(.footnote.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(filter == item ? Color.appInk : Color.appMuted)
                        .padding(.horizontal, 15)
                        .frame(minHeight: 44)
                        .background(filter == item ? Color.appBackground : Color.clear, in: Capsule())
                }
                .buttonStyle(.appScale)
                .accessibilityAddTraits(filter == item ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Color.appReceivedBubble, in: RoundedRectangle(cornerRadius: dynamicTypeSize.isAccessibilitySize ? 24 : 28))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func section(_ title: String, _ items: [ActivityEvent]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.appBody(13, weight: .semibold))
                .foregroundStyle(Color.appMuted)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Rectangle().fill(Color.appCardOutline).frame(height: 1) }
                    row(item)
                }
            }
            .padding(.horizontal, 16)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.appReceivedBubble))
        }
    }

    private func row(_ item: ActivityEvent) -> some View {
        let expanded = expandedID == item.id
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                withAnimation(.appExpand) { expandedID = expanded ? nil : item.id }
            } label: {
                HStack(alignment: .top, spacing: 13) {
                    Text(timeLabel(for: item))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(width: 66, alignment: .leading)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.isFailure ? "Couldn't finish" : item.type.label)
                            .font(.appBody(11, weight: .semibold))
                            .foregroundStyle(item.isFailure ? Color.appWarning : Color.appMuted)
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.appInk)
                            .lineLimit(expanded ? nil : 2)
                            .multilineTextAlignment(.leading)
                        if let detail = detailLine(for: item) {
                            Text(detail)
                                .font(.footnote)
                                .foregroundStyle(Color.appMuted)
                                .lineLimit(expanded ? nil : 2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 4)
                    marker(for: item)
                }
                .padding(.vertical, 15)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.995))

            if expanded {
                HStack(spacing: 8) {
                    if let workflowId = item.workflowId {
                        actionPill("Open") { openWorkflowID = workflowId }
                    }
                    actionPill("Ask Adam about this") { AskAdam.draft("Tell me more about: \(item.title)") }
                }
                .padding(.leading, 57)
                .padding(.bottom, 14)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func actionPill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(13, weight: .medium))
                .foregroundStyle(Color.appInk)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(Capsule().fill(Color.appBackground))
                .frame(minHeight: 44)
        }
        .buttonStyle(.appScale(0.95))
    }

    /// A tick only means something was done successfully. Sensed events and checks carry no mark.
    @ViewBuilder
    private func marker(for item: ActivityEvent) -> some View {
        if item.isFailure {
            AppIcon("alert-circle", size: 16).foregroundStyle(Color.appWarning)
                .accessibilityLabel("Couldn't finish")
        } else {
            switch item.type {
            case .did:
                AppIcon("check-circle", size: 16).foregroundStyle(Color.appSuccess)
                    .accessibilityLabel("Done")
            case .asked:
                Circle().fill(Color.appNeedsYou).frame(width: 8, height: 8)
                    .frame(width: 16, height: 16)
                    .accessibilityLabel("Waiting on you")
            case .noticed, .scheduled, .checked:
                Color.clear.frame(width: 16, height: 16)
            }
        }
    }

    private func detailLine(for item: ActivityEvent) -> String? {
        if item.type == .scheduled {
            if item.stale == true { return "Waiting to run" }
            return item.detail.map { $0.capitalized }
        }
        guard let detail = item.detail, !detail.isEmpty,
              detail.caseInsensitiveCompare(item.title) != .orderedSame else { return nil }
        return detail
    }

    private func timeLabel(for item: ActivityEvent) -> String {
        guard let date = item.date else { return item.type == .asked ? "Now" : "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(filter == .comingUp ? "Nothing scheduled" : "Nothing yet")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.appInk)
            Text("What Adam notices, does, asks you and schedules shows up here. Your conversations stay in Chat.")
                .font(.subheadline)
                .foregroundStyle(Color.appMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 24)
    }

    // MARK: Loading

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        #if DEBUG
        if ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            feed = Self.sampleFeed
            errorMessage = nil
            loaded = true
            return
        }
        #endif
        do {
            feed = try await ActivityService.fetch()
            errorMessage = nil
        } catch {
            errorMessage = "Couldn't load Activity."
        }
        loaded = true
    }

    #if DEBUG
    private static let sampleFeed: ActivityFeed = {
        func iso(_ minutesAgo: Double) -> String {
            ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60))
        }
        return ActivityFeed(
            events: [
                ActivityEvent(id: "e1", type: .did, title: "Sent a message to Arina", detail: nil, at: iso(12), failed: false, open: nil, stale: nil, workflowId: nil),
                ActivityEvent(id: "e2", type: .checked, title: "Looked up “AirPods case under £50”", detail: "No matching listing found", at: iso(40), failed: false, open: nil, stale: nil, workflowId: nil),
                ActivityEvent(id: "e3", type: .noticed, title: "Washing machine finished", detail: nil, at: iso(95), failed: false, open: nil, stale: nil, workflowId: nil)
            ],
            asks: [ActivityEvent(id: "a1", type: .asked, title: "Place the order, up to £60", detail: "Waiting for your yes", at: iso(3), failed: false, open: true, stale: nil, workflowId: nil)],
            upcoming: [
                ActivityEvent(id: "s1", type: .scheduled, title: "Remind you to leave for work", detail: "daily", at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(8 * 3600)), failed: false, open: nil, stale: false, workflowId: nil),
                ActivityEvent(id: "s2", type: .scheduled, title: "Bin day", detail: "weekly", at: nil, failed: false, open: nil, stale: true, workflowId: nil)
            ]
        )
    }()
    #endif
}

private struct ActivityWorkflow: Identifiable { let id: String }
