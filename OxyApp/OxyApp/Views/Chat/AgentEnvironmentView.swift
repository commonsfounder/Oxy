import SwiftUI
import UIKit

struct AgentEnvironmentSnapshot: Decodable {
    let kind: String
    let state: String
    let taskId: String?
    let capturedAt: String?
    let address: String?
    let title: String?
    let frame: EnvironmentFrame?
    let lastAction: EnvironmentAction?
}

struct EnvironmentAction: Decodable {
    let label: String
    let at: String
}

struct EnvironmentFrame: Decodable {
    let mimeType: String
    let data: String
}

@Observable @MainActor
final class EnvironmentMonitor {
    var snapshot: AgentEnvironmentSnapshot?
    var tasks: [AgentTask] = []
    var runtime: AgentRuntimeSnapshot?
    var image: UIImage?
    var error: String?
    var activityError: String?
    var loading = true
    var clock = Date()
    private var receivedAt = Date.distantPast
    private var refreshing = false
    private var refreshingActivity = false

    func task(_ id: String?) -> AgentTask? { tasks.first { $0.id == (id ?? snapshot?.taskId) } }
    var pageTitle: String { snapshot?.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Workspace" }
    var isLive: Bool { snapshot?.state == "live" && image != nil && clock.timeIntervalSince(receivedAt) < 6 }
    var previewStatus: String {
        if image != nil { return isLive ? "Live" : "Last capture" }
        if loading { return "Opening…" }
        if error != nil || snapshot?.state == "unavailable" { return "Unavailable" }
        return "Activity and outputs"
    }

    func refreshFrame(taskID: String?) async {
        guard !refreshing else { return }
        refreshing = true
        defer { loading = false; refreshing = false }
        do {
            let path = taskID.map { "/agent/tasks/\($0)/environment" } ?? "/agent/environment"
            let data = try await APIClient.shared.request(path: path)
            snapshot = try JSONDecoder().decode(AgentEnvironmentSnapshot.self, from: data)
            image = snapshot?.frame.flatMap { Data(base64Encoded: $0.data) }.flatMap { UIImage(data: $0) }
            receivedAt = Date()
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            image = nil; snapshot = nil
            self.error = "Workspace unavailable. Try again."
        }
    }

    func refreshActivity(taskID: String?) async {
        guard !refreshingActivity else { return }
        refreshingActivity = true
        defer { refreshingActivity = false }
        do {
            if let taskID { tasks = [try await AgentTasksService.fetchTask(id: taskID)] }
            else { tasks = try await AgentTasksService.fetchTasks() }
            if let id = taskID ?? snapshot?.taskId { runtime = try await AgentTasksService.fetchRuntime(taskID: id) }
            else { runtime = nil }
            activityError = nil
        } catch {
            guard !Task.isCancelled else { return }
            tasks = []; runtime = nil
            activityError = "Activity unavailable. Try again."
        }
    }
}

// The active task carries its own window, so the person never has to hunt for it.
struct LiveWorkPreview: View {
    let taskID: String
    @State private var monitor = EnvironmentMonitor()
    @State private var open = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Button { open = true } label: {
            VStack(alignment: .leading, spacing: 0) {
                if let image = monitor.image {
                    GeometryReader { geometry in
                        Image(uiImage: image).resizable().scaledToFill()
                            .frame(width: geometry.size.width, height: 160, alignment: .top).clipped()
                    }.frame(height: 160).accessibilityHidden(true)
                }
                HStack(spacing: 10) {
                    AdamDot(solid: monitor.isLive, size: 8)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(monitor.pageTitle).font(.rowTitle).foregroundStyle(Color.appInk).lineLimit(1)
                        Text(monitor.previewStatus).font(.fineprint).foregroundStyle(Color.appMuted)
                    }
                    Spacer(minLength: 8)
                    AppIcon("arrow-up-right", size: 16).foregroundStyle(Color.appInk)
                }
                .padding(14).frame(minHeight: 52)
            }
            .settingsSurface(radius: 16)
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.appScale(0.98))
        .accessibilityLabel("Open workspace for \(monitor.task(taskID)?.displayGoal ?? "this task")")
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { date in
            if scenePhase != .background { monitor.clock = date }
        }
        .fullScreenCover(isPresented: $open) { AgentEnvironmentView(taskID: taskID, monitor: monitor) }
        .task {
            await monitor.refreshFrame(taskID: taskID)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                if scenePhase != .background { await monitor.refreshFrame(taskID: taskID) }
            }
        }
        .task {
            await monitor.refreshActivity(taskID: taskID)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(6)) } catch { return }
                if scenePhase != .background { await monitor.refreshActivity(taskID: taskID) }
            }
        }
    }
}

struct AgentEnvironmentView: View {
    let taskID: String?
    @State private var monitor: EnvironmentMonitor
    @State private var activityOpen = false
    @State private var fitRequest = 0
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.revealClose) private var revealClose
    private func dismiss() { if let revealClose { revealClose() } else { systemDismiss() } }
    @Environment(\.scenePhase) private var scenePhase

    init(taskID: String? = nil, monitor: EnvironmentMonitor? = nil) {
        self.taskID = taskID
        _monitor = State(initialValue: monitor ?? EnvironmentMonitor())
    }

    private var task: AgentTask? { monitor.task(taskID) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    AdamDot(solid: monitor.isLive, size: 8)
                    Text(monitor.image != nil ? monitor.pageTitle : "No live screen")
                        .font(.rowSecondary).foregroundStyle(Color.appInk).lineLimit(1)
                    if monitor.image != nil, !monitor.isLive { Text("Last capture").font(.fineprint).foregroundStyle(Color.appMuted) }
                    Spacer(minLength: 8)
                    if let at = monitor.snapshot?.capturedAt, let date = Date.oxyParse(at) {
                        Text(date.formatted(date: .omitted, time: .standard))
                            .font(.fineprint).monospacedDigit().foregroundStyle(Color.appMuted)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 10)

                if let image = monitor.image {
                    WorkScreenCanvas(image: image, fitRequest: fitRequest)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel("Live browser screen. Pinch to zoom and drag to inspect.")
                } else {
                    VStack(spacing: 16) {
                        if monitor.loading { ProgressView() }
                        else {
                            Text(monitor.error ?? "No screen is open.").font(.bodyText).foregroundStyle(Color.appMuted)
                            if monitor.error != nil {
                                Button("Retry") { Task { await monitor.refreshFrame(taskID: taskID) } }
                                    .font(.control).frame(minWidth: 44, minHeight: 44)
                            }
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(monitor.snapshot?.lastAction?.label ?? task?.activities.last?.summary ?? task?.statusLabel ?? (monitor.isLive ? "Live browser" : "Workspace"))
                                .font(.bodyText).foregroundStyle(Color.appInk).lineLimit(3)
                            if let task, monitor.snapshot?.lastAction != nil || !task.activities.isEmpty { Text(task.statusLabel).font(.fineprint).foregroundStyle(Color.appMuted) }
                        }
                        Spacer(minLength: 8)
                        Button("Activity") { activityOpen = true }
                            .font(.control).foregroundStyle(Color.appAccent).frame(minWidth: 44, minHeight: 44)
                    }
                }
                .padding(16).background(Color.appReceivedBubble)
            }
            .background(Color.appBackground)
            .navigationTitle(task?.activityTitle ?? "Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if monitor.image != nil { Button("Fit") { fitRequest += 1 } }
                    if revealClose == nil { Button("Close") { dismiss() } }
                }
            }
            .sheet(isPresented: $activityOpen) { activity }
        }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { date in
            if scenePhase != .background { monitor.clock = date }
        }
        .task {
            await monitor.refreshFrame(taskID: taskID)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                if scenePhase != .background { await monitor.refreshFrame(taskID: taskID) }
            }
        }
        .task {
            await monitor.refreshActivity(taskID: taskID)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(6)) } catch { return }
                if scenePhase != .background { await monitor.refreshActivity(taskID: taskID) }
            }
        }
    }

    private var activity: some View {
        SettingsPage(title: "Activity") {
            VStack(alignment: .leading, spacing: 18) {
                if let error = monitor.activityError {
                    ErrorBanner(message: error, onRetry: { Task { await monitor.refreshActivity(taskID: taskID) } })
                }
                if let task {
                    Text(task.displayGoal).font(.sectionTitle).foregroundStyle(Color.appInk)
                    ForEach(task.activities.suffix(20)) { step in
                        HStack(alignment: .top, spacing: 10) {
                            AdamDot(solid: step.success, size: 8).padding(.top, 5)
                            Text(step.summary).font(.bodyText).foregroundStyle(Color.appInk)
                        }
                    }
                    if task.activities.isEmpty { Text(task.statusLabel).font(.bodyText).foregroundStyle(Color.appMuted) }
                } else {
                    ForEach(monitor.tasks.filter(\.isActive)) { task in
                        Text(task.displayGoal).font(.rowTitle).foregroundStyle(Color.appInk)
                    }
                    if monitor.tasks.isEmpty { Text("No activity available.").font(.bodyText).foregroundStyle(Color.appMuted) }
                }
                if let runtime = monitor.runtime, !runtime.artifacts.isEmpty {
                    Text("Outputs").font(.sectionTitle).foregroundStyle(Color.appInk)
                    ForEach(runtime.artifacts) { artifact in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(artifact.title).font(.rowTitle).foregroundStyle(Color.appInk)
                            Text(artifact.summary).font(.rowSecondary).foregroundStyle(Color.appMuted)
                        }
                    }
                }
            }
        }.presentationDragIndicator(.visible)
    }
}

// Keep the live image at readable scale; image updates preserve the person's zoom and position.
private struct WorkScreenCanvas: UIViewRepresentable {
    let image: UIImage
    let fitRequest: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ScreenScrollView {
        let scroll = ScreenScrollView()
        scroll.delegate = context.coordinator
        scroll.backgroundColor = UIColor(Color.appBackground)
        scroll.addSubview(scroll.picture)
        scroll.maximumZoomScale = 3
        scroll.bouncesZoom = true
        return scroll
    }

    func updateUIView(_ scroll: ScreenScrollView, context: Context) {
        scroll.picture.image = image
        if scroll.picture.bounds.size != image.size {
            scroll.picture.frame = CGRect(origin: .zero, size: image.size)
            scroll.contentSize = image.size
        }
        if context.coordinator.fitRequest != fitRequest {
            context.coordinator.fitRequest = fitRequest
            scroll.fitOnLayout = true
        }
        scroll.setNeedsLayout()
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var fitRequest = 0
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? ScreenScrollView)?.picture }
    }

    final class ScreenScrollView: UIScrollView {
        let picture = UIImageView()
        var initialized = false
        var fitOnLayout = false

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.width > 0, bounds.height > 0, picture.bounds.width > 0 else { return }
            minimumZoomScale = min(1, min(bounds.width / picture.bounds.width, bounds.height / picture.bounds.height))
            if !initialized || fitOnLayout {
                initialized = true
                setZoomScale(fitOnLayout ? minimumZoomScale : 1, animated: false)
                contentOffset = .zero
                fitOnLayout = false
            }
            let zoomedSize = CGSize(width: picture.bounds.width * zoomScale, height: picture.bounds.height * zoomScale)
            if contentSize != zoomedSize { contentSize = zoomedSize }
        }
    }
}
