import SwiftUI

@main
struct AdamMacApp: App {
    @StateObject private var model = MacGameCompanionModel()

    var body: some Scene {
        WindowGroup("Adam") {
            AdamMacRootView()
                .environmentObject(model)
                .frame(minWidth: 760, minHeight: 560)
        }
        .windowResizability(.contentSize)
    }
}

@MainActor
final class MacGameCompanionModel: ObservableObject {
    @Published private(set) var windows: [MacGameWindowDescriptor] = []
    @Published var selectedWindowID: UInt32?
    @Published private(set) var connectedWindowName: String?
    @Published private(set) var snapshot: GameSessionSnapshot?
    @Published private(set) var screenCaptureAllowed = false
    @Published private(set) var inputAllowed = false
    @Published private(set) var message = "Choose a game window to begin."
    @Published private(set) var isBusy = false
    @Published var moveCommand = "press space"
    @Published private(set) var proposedMove: GameMoveProposal?
    @Published private(set) var lastMove: GameMoveResult?

    private let catalog = MacGameWindowCatalog()
    private var session: GameSession?
    private var movePipeline: GameMovePipeline?

    var isConnected: Bool {
        snapshot?.phase != nil && snapshot?.phase != .disconnected
    }

    var controlEnabled: Bool {
        snapshot?.mode == .control
    }

    var traceEventCount: Int {
        snapshot?.trace.events.count ?? 0
    }

    func refreshPermissions() {
        screenCaptureAllowed = MacGamePermissions.screenCaptureIsGranted
        inputAllowed = MacGamePermissions.inputIsGranted
    }

    func requestScreenCaptureAccess() {
        _ = MacGamePermissions.requestScreenCapture()
        refreshPermissions()
    }

    func requestInputAccess() {
        _ = MacGamePermissions.requestInputAccess()
        refreshPermissions()
    }

    func refreshWindows() async {
        isBusy = true
        defer { isBusy = false }
        do {
            windows = try await catalog.list()
            if let selectedWindowID, !windows.contains(where: { $0.id == selectedWindowID }) {
                self.selectedWindowID = nil
            }
            message = windows.isEmpty
                ? "No visible app windows are available."
                : "Choose the game window Adam should watch."
        } catch {
            message = "Adam could not list the visible windows: \(error.localizedDescription)"
        }
    }

    func connect() async {
        guard let selectedWindowID else {
            message = "Choose a game window first."
            return
        }

        isBusy = true
        defer { isBusy = false }
        do {
            let adapter = try await catalog.makeAdapter(for: selectedWindowID)
            let newSession = GameSession(adapter: adapter, sessionType: .singlePlayer)
            try await newSession.connect()
            _ = try await newSession.observe()
            session = newSession
            movePipeline = nil
            proposedMove = nil
            lastMove = nil
            connectedWindowName = windows.first(where: { $0.id == selectedWindowID })?.title
                ?? adapter.name
            snapshot = await newSession.snapshot()
            message = "Adam is watching. Control stays off until you enable it."
        } catch {
            message = "Adam could not start watching: \(error.localizedDescription)"
        }
    }

    func proposeMove() async {
        guard let session else {
            message = "Start watching a game first."
            return
        }

        do {
            let planner = try GameMoveCommandPlanner(command: moveCommand)
            let pipeline = GameMovePipeline(session: session, planner: planner)
            let proposal = try await pipeline.proposeNextMove()
            movePipeline = pipeline
            proposedMove = proposal
            lastMove = nil
            snapshot = await session.snapshot()
            message = "Adam has proposed one move. Review it before issuing it."
        } catch {
            message = "Adam could not propose that move: \(error.localizedDescription)"
        }
    }

    func issueMove() async {
        guard let session, let movePipeline else { return }
        do {
            let result = try await movePipeline.issueNextMoveAndVerify()
            proposedMove = nil
            lastMove = result
            snapshot = await session.snapshot()
            message = result.verified
                ? "Move issued and verified."
                : "Move issued, but Adam could not verify a screen change."
        } catch {
            message = "Adam did not issue the move: \(error.localizedDescription)"
        }
    }

    func enableControl() async {
        guard let session else { return }
        do {
            try await session.authorizeControl()
            snapshot = await session.snapshot()
            message = "Control enabled. Adam will verify each action changes the game."
        } catch {
            message = "Control could not be enabled: \(error.localizedDescription)"
        }
    }

    func pause() async {
        guard let session else { return }
        await session.pause()
        movePipeline = nil
        proposedMove = nil
        snapshot = await session.snapshot()
        message = "Paused. Adam will not send input."
    }

    func stop() async {
        guard let session else { return }
        await session.stop()
        self.session = nil
        movePipeline = nil
        proposedMove = nil
        lastMove = nil
        snapshot = nil
        connectedWindowName = nil
        message = "Stopped."
    }
}

struct AdamMacRootView: View {
    @EnvironmentObject private var model: MacGameCompanionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    permissions
                    gameWindow
                    sessionControls
                    Text(model.message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .padding(32)
            }
        }
        .task {
            model.refreshPermissions()
            await model.refreshWindows()
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("ADAM")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .tracking(1.5)
                Text("Game companion")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isConnected {
                Button("Stop") {
                    Task { await model.stop() }
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 22)
    }

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Permissions")
                .font(.headline)

            HStack(spacing: 12) {
                permissionCard(
                    title: "Screen Recording",
                    granted: model.screenCaptureAllowed,
                    action: model.requestScreenCaptureAccess
                )
                permissionCard(
                    title: "Accessibility",
                    granted: model.inputAllowed,
                    action: model.requestInputAccess
                )
            }
        }
    }

    private func permissionCard(
        title: String,
        granted: Bool,
        action: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(granted ? "Ready" : "Needs approval")
                .font(.caption)
                .foregroundStyle(granted ? .green : .orange)
            if !granted {
                Button("Allow") { action() }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }

    private var gameWindow: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Game window")
                    .font(.headline)
                Spacer()
                Button("Refresh") {
                    Task { await model.refreshWindows() }
                }
                .disabled(model.isBusy || model.isConnected)
            }

            if model.windows.isEmpty {
                Text("Open a game, then refresh this list.")
                    .foregroundStyle(.secondary)
            } else {
                Picker("Game window", selection: $model.selectedWindowID) {
                    Text("Choose a window")
                        .tag(UInt32?.none)
                    ForEach(model.windows) { window in
                        Text(windowLabel(window))
                            .tag(UInt32?.some(window.id))
                    }
                }
                .labelsHidden()
                .disabled(model.isConnected)
            }

            Button(model.isConnected ? "Watching" : "Start watching") {
                Task { await model.connect() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.selectedWindowID == nil || model.isBusy || model.isConnected)
        }
    }

    private var sessionControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Adam’s control")
                .font(.headline)

            HStack(spacing: 12) {
                Text(model.controlEnabled ? "Control enabled" : "Assist only")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("Trace \(model.traceEventCount)/64")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.isConnected && !model.controlEnabled {
                    Button("Enable control") {
                        Task { await model.enableControl() }
                    }
                    .buttonStyle(.bordered)
                }
                if model.isConnected {
                    Button("Pause") {
                        Task { await model.pause() }
                    }
                    .buttonStyle(.bordered)
                }
            }

            if model.isConnected {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Next move")
                        .font(.subheadline.weight(.semibold))
                    TextField("press space or click 400 300", text: $model.moveCommand)
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Suggest move") {
                            Task { await model.proposeMove() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isBusy || model.proposedMove != nil)
                        if let proposedMove = model.proposedMove {
                            Text(proposedMove.intent)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Button("Issue move") {
                                Task { await model.issueMove() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!model.controlEnabled)
                        }
                    }
                    if let lastMove = model.lastMove {
                        Text(lastMove.verified ? "Verified screen change" : "No verified screen change")
                            .font(.caption)
                            .foregroundStyle(lastMove.verified ? .green : .orange)
                    }
                }
            }

            Text("Assist watches the selected game. Control lets Adam send one deliberate keyboard or mouse action at a time, then check that the screen changed.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }

    private func windowLabel(_ window: MacGameWindowDescriptor) -> String {
        [window.applicationName, window.title]
            .filter { !$0.isEmpty }
            .joined(separator: " — ")
    }
}
