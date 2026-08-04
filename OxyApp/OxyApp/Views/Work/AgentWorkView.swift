import SwiftUI

/// The agent's durable workspace: goals that continue beyond one chat turn,
/// with their autonomy level and current state visible at a glance.
struct AgentWorkView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var tasks: [AgentTask] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var runningIDs = Set<String>()
    @State private var selectedTask: AgentTask?
    @State private var isShowingComposer = false

    private var activeTasks: [AgentTask] {
        tasks.filter { $0.isActive && $0.status.lowercased() != "recipe" }
    }

    private var historyTasks: [AgentTask] {
        tasks.filter { !$0.isActive && $0.status.lowercased() != "recipe" }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "Work", onBack: { dismiss() })

                        Button(action: { isShowingComposer = true }) {
                            HStack(spacing: 8) {
                                AppIcon("plus", size: 14)
                                Text("New goal")
                                    .font(.appBody(13, weight: .semibold))
                                Spacer(minLength: 0)
                                AppIcon("arrow-right", size: 13)
                            }
                            .foregroundStyle(Color.appInk)
                            .padding(.horizontal, 15)
                            .padding(.vertical, 12)
                            .background(Color.appAccent.opacity(0.14), in: Capsule())
                        }
                        .buttonStyle(.appScale)

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: {
                                Task { await load() }
                            })
                        }

                        if isLoading {
                            ForEach(0..<3, id: \.self) { _ in
                                OxySkeletonCard(height: 112, cornerRadius: 20)
                            }
                        } else if tasks.isEmpty {
                            emptyState
                        } else {
                            taskSection(title: "In progress", tasks: activeTasks)
                            if !historyTasks.isEmpty {
                                taskSection(title: "History", tasks: Array(historyTasks.prefix(12)))
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
                .refreshable { await load() }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(item: $selectedTask) { task in
                AgentTaskDetailView(task: task) { updated in
                    if let index = tasks.firstIndex(where: { $0.id == updated.id }) {
                        tasks[index] = updated
                    }
                    selectedTask = updated
                }
            }
            .sheet(isPresented: $isShowingComposer) {
                AgentGoalComposerView { created in
                    tasks.insert(created, at: 0)
                    isShowingComposer = false
                }
            }
            .task {
                await load()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(8))
                    guard !Task.isCancelled, activeTasks.contains(where: { $0.status.lowercased() == "running" }) else { continue }
                    await load()
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            AppIcon("dotted", size: 18)
                .foregroundStyle(Color.appAccent)
            Text("Nothing is running")
                .font(.appBody(18, weight: .semibold))
                .foregroundStyle(Color.appInk)
            Text("Ask in chat to keep a goal moving in the background.")
                .font(.appBody(14))
                .foregroundStyle(Color.appMuted)
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private func taskSection(title: String, tasks: [AgentTask]) -> some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.appBody(18, weight: .semibold))
                    .foregroundStyle(Color.appInk)
                ForEach(tasks) { task in
                    AgentTaskRow(
                        task: task,
                        isRunning: runningIDs.contains(task.id),
                        onRun: { Task { await run(task) } },
                        onOpen: { selectedTask = task }
                    )
                }
            }
        }
    }

    private func load() async {
        do {
            let fetched = try await AgentTasksService.fetchTasks()
            await MainActor.run {
                tasks = fetched
                isLoading = false
                errorMessage = nil
            }
        } catch {
            await MainActor.run {
                isLoading = false
                if tasks.isEmpty { errorMessage = "Could not load agent work." }
            }
        }
    }

    private func run(_ task: AgentTask) async {
        guard !runningIDs.contains(task.id) else { return }
        await MainActor.run {
            runningIDs.insert(task.id)
            if let index = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[index].status = "running"
            }
            HapticManager.shared.impact(.light)
        }
        do {
            try await AgentTasksService.runTask(id: task.id)
        } catch {
            await MainActor.run {
                runningIDs.remove(task.id)
                if let index = tasks.firstIndex(where: { $0.id == task.id }) {
                    tasks[index].status = task.status
                }
                errorMessage = "Could not start that work."
            }
        }
        _ = await MainActor.run { runningIDs.remove(task.id) }
        await load()
    }
}

private struct AgentGoalComposerView: View {
    @Environment(\.dismiss) private var dismiss
    let onCreated: (AgentTask) -> Void
    @State private var goal = ""
    @State private var autonomy = "Balanced"
    @State private var guardMode = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let autonomyLevels = ["Reactive", "Reserved", "Balanced", "Proactive", "Autonomous"]

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "New goal", onBack: { dismiss() })

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Goal")
                                .font(.appBody(16, weight: .semibold))
                                .foregroundStyle(Color.appInk)
                            TextField("What should Millie keep moving?", text: $goal, axis: .vertical)
                                .font(.appBody(16))
                                .foregroundStyle(Color.appInk)
                                .lineLimit(3...7)
                                .padding(14)
                                .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }

                        VStack(alignment: .leading, spacing: 15) {
                            Toggle(isOn: $guardMode) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Ask before each action")
                                        .font(.appBody(15, weight: .medium))
                                        .foregroundStyle(Color.appInk)
                                    Text("Recommended for a new goal.")
                                        .font(.appBody(12))
                                        .foregroundStyle(Color.appMuted)
                                }
                            }
                            .tint(Color.appAccent)

                            Picker("Proactivity", selection: $autonomy) {
                                ForEach(autonomyLevels, id: \.self) { level in
                                    Text(level).tag(level)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(Color.appAccent)
                        }
                        .padding(16)
                        .background { MissionGlassPlate() }

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onDismiss: {
                                self.errorMessage = nil
                            })
                        }

                        Button(action: create) {
                            HStack(spacing: 8) {
                                if isSaving { ProgressView().scaleEffect(0.7).tint(Color.appInk) }
                                Text(isSaving ? "Creating" : "Create goal")
                                    .font(.appBody(14, weight: .semibold))
                            }
                            .foregroundStyle(Color.appInk)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Color.appAccent.opacity(0.18), in: Capsule())
                        }
                        .buttonStyle(.appScale)
                        .disabled(isSaving || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func create() {
        let trimmedGoal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedGoal.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                let task = try await AgentTasksService.createTask(
                    goal: trimmedGoal,
                    autonomy: autonomy,
                    guardMode: guardMode
                )
                await MainActor.run {
                    isSaving = false
                    onCreated(task)
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                    errorMessage = "Could not create that goal."
                }
            }
        }
    }
}

private struct AgentTaskRow: View {
    let task: AgentTask
    let isRunning: Bool
    let onRun: () -> Void
    let onOpen: () -> Void

    private var statusColor: Color {
        switch task.status.lowercased() {
        case "running": return Color(red: 0.18, green: 0.7, blue: 0.34)
        case "failed": return Color.mgDestructive
        case "completed": return Color(red: 0.18, green: 0.7, blue: 0.34)
        default: return Color.appAccent
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                AppIcon("dotted", size: 16)
                    .foregroundStyle(statusColor)
                    .frame(width: 36, height: 36)
                    .background(statusColor.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Circle().fill(statusColor).frame(width: 6, height: 6)
                        Text(task.statusLabel.uppercased())
                            .font(.appBody(10, weight: .semibold))
                            .tracking(0.8)
                            .foregroundStyle(statusColor)
                    }
                    Text(task.goal)
                        .font(.appBody(16, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(task.autonomy + " autonomy · " + (task.currentStep == 0 ? "Not started" : "Step " + String(task.currentStep)))
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)
                    // A run that stopped says why, and whether continuing picks up where it
                    // left off or starts the goal again.
                    if let lastError = task.lastError, !lastError.isEmpty, task.status.lowercased() != "completed" {
                        Text(task.resumable ? lastError + " Continues from where it stopped." : lastError)
                            .font(.appBody(12))
                            .foregroundStyle(Color.mgDestructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }

            if task.status.lowercased() != "completed" {
                HStack {
                    Button("Details", action: onOpen)
                        .font(.appBody(12, weight: .semibold))
                        .foregroundStyle(Color.appMuted)
                        .buttonStyle(.appScale)
                    Spacer(minLength: 0)
                    Button(action: onRun) {
                        HStack(spacing: 7) {
                            if isRunning { ProgressView().scaleEffect(0.65).tint(Color.appInk) }
                            Text(isRunning ? "Starting" : task.status.lowercased() == "running" ? "Working" : "Run")
                                .font(.appBody(12, weight: .semibold))
                        }
                        .foregroundStyle(Color.appInk)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Color.appAccent.opacity(0.16), in: Capsule())
                    }
                    .buttonStyle(.appScale)
                    .disabled(isRunning || task.status.lowercased() == "running")
                }
            }
        }
        .padding(16)
        .background { MissionGlassPlate() }
    }
}

private struct AgentTaskDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let task: AgentTask
    let onUpdated: (AgentTask) -> Void
    @State private var autonomy: String
    @State private var guardMode: Bool
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let autonomyLevels = ["Reactive", "Reserved", "Balanced", "Proactive", "Autonomous"]

    init(task: AgentTask, onUpdated: @escaping (AgentTask) -> Void) {
        self.task = task
        self.onUpdated = onUpdated
        _autonomy = State(initialValue: OxySettings.normalizedAutonomy(task.autonomy))
        _guardMode = State(initialValue: task.guardMode)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        ScreenHeaderView(title: "Goal controls", onBack: { dismiss() })

                        VStack(alignment: .leading, spacing: 8) {
                            Text(task.goal)
                                .font(.appBody(20, weight: .semibold))
                                .foregroundStyle(Color.appInk)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(task.statusLabel + " · " + task.autonomy + " autonomy")
                                .font(.appBody(13))
                                .foregroundStyle(Color.appMuted)
                        }

                        VStack(alignment: .leading, spacing: 15) {
                            Text("Permission")
                                .font(.appBody(16, weight: .semibold))
                                .foregroundStyle(Color.appInk)
                            Toggle(isOn: $guardMode) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Ask before each action")
                                        .font(.appBody(15, weight: .medium))
                                        .foregroundStyle(Color.appInk)
                                    Text("Keep this goal behind the approval gate.")
                                        .font(.appBody(12))
                                        .foregroundStyle(Color.appMuted)
                                }
                            }
                            .tint(Color.appAccent)
                        }
                        .padding(16)
                        .background { MissionGlassPlate() }

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Proactivity")
                                .font(.appBody(16, weight: .semibold))
                                .foregroundStyle(Color.appInk)
                            Picker("Proactivity", selection: $autonomy) {
                                ForEach(autonomyLevels, id: \.self) { level in
                                    Text(level).tag(level)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(Color.appAccent)
                        }
                        .padding(16)
                        .background { MissionGlassPlate() }

                        activitySection

                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onDismiss: {
                                self.errorMessage = nil
                            })
                        }

                        Button(action: save) {
                            HStack(spacing: 8) {
                                if isSaving { ProgressView().scaleEffect(0.7).tint(Color.appInk) }
                                Text(isSaving ? "Saving" : "Save controls")
                                    .font(.appBody(14, weight: .semibold))
                            }
                            .foregroundStyle(Color.appInk)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(Color.appAccent.opacity(0.18), in: Capsule())
                        }
                        .buttonStyle(.appScale)
                        .disabled(isSaving)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    @ViewBuilder
    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Activity")
                .font(.appBody(16, weight: .semibold))
                .foregroundStyle(Color.appInk)
            if task.activities.isEmpty {
                Text("No actions recorded yet.")
                    .font(.appBody(13))
                    .foregroundStyle(Color.appMuted)
                    .padding(.vertical, 4)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(task.activities.reversed()) { activity in
                        HStack(alignment: .top, spacing: 10) {
                            AppIcon(
                                activity.pending ? "clock" : activity.success ? "check-circle" : "alert-circle",
                                size: 15
                            )
                            .foregroundStyle(activity.pending ? Color.appAccent : activity.success ? Color.appSuccess : Color.mgDestructive)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(activity.action)
                                    .font(.appBody(12, weight: .semibold))
                                    .foregroundStyle(Color.appInk)
                                Text(activity.summary)
                                    .font(.appBody(12))
                                    .foregroundStyle(Color.appMuted)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 9)
                    }
                }
                .padding(.horizontal, 16)
                .background { MissionGlassPlate() }
            }
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                let updated = try await AgentTasksService.updateTask(
                    id: task.id,
                    autonomy: autonomy,
                    guardMode: guardMode
                )
                await MainActor.run {
                    isSaving = false
                    onUpdated(updated)
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                    errorMessage = "Could not save these controls."
                }
            }
        }
    }
}

#Preview {
    AgentWorkView()
        .environment(AppState())
}
