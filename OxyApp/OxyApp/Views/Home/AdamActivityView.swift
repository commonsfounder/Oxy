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

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
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
            VStack(spacing: 0) {
                ScreenHeaderView(title: "Activity", onBack: { dismiss() })
            GeometryReader { geometry in
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 14) {
                        filterBar
                    }

                    if !loaded && isLoading {
                        VStack(spacing: 16) {
                            OxySkeletonCard(height: 88, cornerRadius: 14)
                            OxySkeletonCard(height: 88, cornerRadius: 14)
                            OxySkeletonCard(height: 88, cornerRadius: 14)
                        }
                        .frame(width: max(0, geometry.size.width - AppSpacing.margin * 2))
                        .accessibilityLabel("Loading activity")
                    } else {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
                                .disabled(isLoading)
                        }
                        if isEmpty && loaded && errorMessage == nil {
                            emptyState
                        } else {
                            if !asks.isEmpty { section("Waiting on you", asks) }
                            if !upcoming.isEmpty { section("Coming up", upcoming) }
                            if !past.isEmpty { section(filter == .done ? "Done" : "Recently", past) }
                        }
                    }
                }
                .frame(width: max(0, geometry.size.width - AppSpacing.margin * 2), alignment: .leading)
                .padding(.horizontal, AppSpacing.margin)
                .padding(.top, 18)
                .padding(.bottom, 40)
            }
            }
            }
            .background(Color.appBackground.ignoresSafeArea())
            .refreshable { await load() }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task {
            await load()
            #if DEBUG
            if PreviewData.isIsolated, let state = ProcessInfo.processInfo.environment["OXY_DEBUG_ACTIVITY"] {
                switch state {
                case "refresh-failure": await load()
                case "expanded": expandedID = feed.asks.first?.id ?? feed.events.first?.id
                case "done": filter = .done
                case "coming-up": filter = .comingUp
                case "workflow":
                    try? await Task.sleep(for: .milliseconds(700))
                    openWorkflowID = "sample-workflow"
                default: break
                }
            }
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        .fullScreenCover(item: Binding(
            get: { openWorkflowID.map(ActivityWorkflow.init) },
            set: { openWorkflowID = $0?.id }
        )) { workflow in
            WorkflowTimelineView(workflowId: workflow.id, onChanged: { Task { await load() } })
                .swipeToDismiss()
        }
    }

    // MARK: Pieces

    @ViewBuilder
    private var filterBar: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Menu {
                ForEach(Filter.allCases) { item in
                    Button(item.rawValue) { selectFilter(item) }
                        .accessibilityAddTraits(filter == item ? .isSelected : [])
                }
            } label: {
                HStack(spacing: 12) {
                    Text(filter.rawValue)
                        .font(.body.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    AppIcon("chevron-down", size: 16)
                }
                .foregroundStyle(Color.appAccent)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 14))
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Filter activity")
            .accessibilityValue(filter.rawValue)
        } else {
            HStack(spacing: 6) {
                ForEach(Filter.allCases) { item in
                    Button { selectFilter(item) } label: {
                        Text(item.rawValue)
                            .font(.appBody(15, weight: .semibold))
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(filter == item ? Color.appInk : Color.appMuted)
                            .padding(.horizontal, 15)
                            .frame(minHeight: 44)
                            .overlay(alignment: .bottom) {
                                Capsule().fill(filter == item ? Color.appAccent : Color.clear).frame(height: 2)
                            }
                    }
                    .buttonStyle(.appScale)
                    .accessibilityAddTraits(filter == item ? .isSelected : [])
                }
            }
            .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func selectFilter(_ item: Filter) {
        guard filter != item else { return }
        HapticManager.shared.select()
        withAnimation(reduceMotion ? nil : .appStandard) { filter = item }
    }

    private func section(_ title: String, _ items: [ActivityEvent]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.sectionLabel)
                .foregroundStyle(Color.appMuted)
                .padding(.horizontal, 4)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { SettingsRule() }
                    row(item)
                }
            }
            .padding(.top, 4)
        }
    }

    private func row(_ item: ActivityEvent) -> some View {
        let expanded = expandedID == item.id
        let rowLayout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 13))
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                HapticManager.shared.impact(.light)
                withAnimation(reduceMotion ? nil : .appExpand) { expandedID = expanded ? nil : item.id }
            } label: {
                rowLayout {
                    HStack {
                    Text(timeLabel(for: item))
                        .font(.appBody(13, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .minimumScaleFactor(0.75)
                        .accessibilityLabel(item.date == nil ? "Time unavailable" : timeLabel(for: item))
                        if dynamicTypeSize.isAccessibilitySize {
                            Spacer()
                            marker(for: item)
                            disclosure(expanded: expanded)
                        }
                    }
                    .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 66, alignment: .leading)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.isFailure ? "Couldn't finish" : item.type.label)
                            .font(.appBody(12, weight: .semibold))
                            .foregroundStyle(item.isFailure ? Color.appWarning : Color.appMuted)
                        Text(item.title)
                            .font(.appBody(17, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .lineLimit(expanded || dynamicTypeSize.isAccessibilitySize ? nil : 2)
                            .multilineTextAlignment(.leading)
                        if let detail = detailLine(for: item) {
                            Text(detail)
                                .font(.appBody(13))
                                .foregroundStyle(Color.appMuted)
                                .lineLimit(expanded || dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    if !dynamicTypeSize.isAccessibilitySize {
                        Spacer(minLength: 4)
                        marker(for: item)
                        disclosure(expanded: expanded)
                    }
                }
                .padding(.vertical, 16)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale(0.995))
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Show or hide activity actions")

            if expanded {
                let actionLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                    : AnyLayout(HStackLayout(spacing: 8))
                actionLayout {
                    if let workflowId = item.workflowId {
                        actionPill("View work") { openWorkflowID = workflowId }
                    }
                    actionPill("Ask about this") { AskAdam.draft("Tell me more about: \(item.title)") }
                        .accessibilityLabel("Ask about \(item.title)")
                        .accessibilityHint("Opens a draft in the conversation")
                }
                .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 79)
                .padding(.bottom, 14)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func disclosure(expanded: Bool) -> some View {
        AppIcon("chevron-down", size: 13)
            .foregroundStyle(Color.appMuted)
            .rotationEffect(.degrees(expanded ? 180 : 0))
            .accessibilityHidden(true)
    }

    private func actionPill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.appBody(13, weight: .medium))
                .foregroundStyle(Color.appAccent)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Capsule().fill(Color.appSurface2))
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
            if item.stale == true { return "Next run unavailable" }
            return item.detail
        }
        guard let detail = item.detail, !detail.isEmpty,
              detail.caseInsensitiveCompare(item.title) != .orderedSame else { return nil }
        return detail
    }

    private func timeLabel(for item: ActivityEvent) -> String {
        guard let date = item.date else { return "Unknown" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(filter == .comingUp ? "Nothing scheduled" : (filter == .done ? "No completed work" : "No activity yet"))
                .font(.sectionTitle)
                .foregroundStyle(Color.appInk)
        }
        .padding(.top, 24)
    }

    // MARK: Loading

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        #if DEBUG
        if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_BOARD"] == "1" {
            feed = Self.sampleFeed
            errorMessage = nil
            loaded = true
            return
        }
        #endif
        do {
            let fetched = try await ActivityService.fetch()
            #if DEBUG
            if PreviewData.isIsolated, loaded,
               ProcessInfo.processInfo.environment["OXY_DEBUG_ACTIVITY"] == "refresh-failure" {
                feed = try JSONDecoder().decode(ActivityFeed.self, from: Data("{invalid isolated activity response".utf8))
            } else {
                feed = ProcessInfo.processInfo.environment["OXY_DEBUG_ACTIVITY"] == "unknown" && PreviewData.isIsolated
                    ? Self.unknownFeed : fetched
            }
            #else
            feed = fetched
            #endif
            errorMessage = nil
        } catch {
            errorMessage = feed == .empty ? "Couldn't load Activity." : "Couldn't update Activity. Showing saved activity."
        }
        loaded = true
    }

    #if DEBUG
    private static let unknownFeed = ActivityFeed(events: [], asks: [
        ActivityEvent(id: "sample-unknown", type: .asked, title: "Review the delivery change", detail: "Waiting for your yes", at: nil, failed: false, open: true, stale: nil, workflowId: nil)
    ], upcoming: [
        ActivityEvent(id: "sample-stale", type: .scheduled, title: "Flight price check", detail: "Every Friday morning", at: nil, failed: false, open: nil, stale: true, workflowId: nil)
    ])

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
