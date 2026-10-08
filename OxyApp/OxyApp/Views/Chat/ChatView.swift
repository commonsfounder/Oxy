import MessageUI
import Network
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ChatView: View {
    var initialSession: ChatSessionSummary? = nil
    var autoSendTranscript: String? = nil
    var initialReviewAction: ActionResult? = nil
    var startFresh: Bool = false
    var onMenu: (() -> Void)? = nil
    var onMenuChoice: ((ThreadMenuChoice, CGPoint) -> Void)? = nil

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = ChatViewModel()
    @State private var boardModel = ThreadBoardModel()
    @State private var wheelOpen = false
    @AppStorage(ThreadMenuChoice.orderKey) private var wheelOrderRaw = ""
    @State private var showsPrivateExplainer = false
    @State private var replyingTo: Message?
    @State private var displayText: String?
    @State private var heldMessage: (message: Message, frame: CGRect)?
    @State private var hubCenter: CGPoint = .zero
    @Environment(\.scenePhase) private var scenePhase
    @State private var voiceInput = VoiceInputManager()
    @FocusState private var isInputFocused: Bool
    @State private var pendingReviewAction: ActionResult?
    @State private var messageDraft: MessageDraft?
    @State private var messageComposerAlert: String?
    @State private var handledReviewActionIDs = Set<String>()
    @State private var handledMessageComposeActionIDs = Set<String>()
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var showCamera = false
    @State private var attachmentError: String?
    @State private var showAttachMenu = false
    @State private var isIncognito = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var pendingImageData: Data?
    @State private var pendingImageName: String?
    @State private var pendingImageMimeType = "image/jpeg"
    @State private var pendingIsImage = true
    @State private var isOffline = false
    @State private var voiceErrorMessage: String?
    @State private var didSendAutoDemoMessage = false
    @State private var scrollViewportHeight: CGFloat = 0
    @State private var isScrollPinnedToBottom = true
    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }
    private let networkMonitor = NWPathMonitor()

    @ViewBuilder
    private func messageRow(idx: Int, message: Message) -> some View {
        if isHiddenInThread(message) {
            EmptyView()
        } else {
            visibleMessageRow(idx: idx, message: message)
        }
    }

    /// The user message an agent reaction lands on, or nil when it should be shown as the plain emoji.
    private func adamReactionTarget(of message: Message) -> Message? {
        guard let index = viewModel.messages.firstIndex(where: { $0.id == message.id }), index > 0 else { return nil }
        let target = viewModel.messages[index - 1]
        guard target.role == .user, !ReactionText.isReaction(target.content),
              ReactionText.canReact(to: target.content) else { return nil }
        return target
    }

    /// An agent reaction that couldn't become a badge is shown as just the emoji.
    private func plainEmojiIfNeeded(_ message: Message) -> Message {
        guard message.role == .assistant, let emoji = ReactionText.agentReaction(message.content) else { return message }
        var shown = message
        shown.content = emoji
        return shown
    }

    /// The emoji Adam reacted with on this user message, if the next message is such a reaction.
    private func adamReaction(on message: Message) -> String? {
        guard message.role == .user,
              let index = viewModel.messages.firstIndex(where: { $0.id == message.id }),
              index + 1 < viewModel.messages.count else { return nil }
        let next = viewModel.messages[index + 1]
        guard next.role == .assistant, let emoji = ReactionText.agentReaction(next.content),
              adamReactionTarget(of: next)?.id == message.id else { return nil }
        return emoji
    }

    /// Reactions sent to Adam, and replies Adam chose not to make, are not shown as messages.
    private func isHiddenInThread(_ message: Message) -> Bool {
        if message.role == .user { return ReactionText.isReaction(message.content) }
        if ReactionText.isQuiet(message.content) || ReactionText.isAgentReactionInProgress(message.content) { return true }
        if ReactionText.agentReaction(message.content) != nil { return adamReactionTarget(of: message) != nil }
        // A reply to a reaction that failed or never came isn't worth an error.
        guard message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let index = viewModel.messages.firstIndex(where: { $0.id == message.id }), index > 0 else { return false }
        return ReactionText.isReaction(viewModel.messages[index - 1].content)
    }

    @ViewBuilder
    private func visibleMessageRow(idx: Int, message: Message) -> some View {
        let msgs = viewModel.messages
        let prevRole = idx > 0 ? msgs[idx - 1].role : nil
        let nextRole = idx < msgs.count - 1 ? msgs[idx + 1].role : nil
        let isGroupStart = prevRole != message.role
        let isGroupEnd = nextRole != message.role
        let nextMessage = idx < msgs.count - 1 ? msgs[idx + 1] : nil
        let previousMessage = idx > 0 ? msgs[idx - 1] : nil
        if idx == 0 || !Calendar.current.isDate(previousMessage?.timestamp ?? message.timestamp, inSameDayAs: message.timestamp) || message.timestamp.timeIntervalSince(previousMessage?.timestamp ?? message.timestamp) > 20 * 60 {
            Text("\(Self.dayLabel(for: message.timestamp)) \(message.timestamp.formatted(date: .omitted, time: .shortened))")
                .font(.appBody(12))
                .foregroundStyle(Color.appMuted)
                .frame(maxWidth: .infinity)
                .padding(.top, idx == 0 ? 4 : 16)
                .padding(.bottom, 8)
        }
        ThreadMessageRow(
            message: message,
            reaction: ReactionStore.shared.reaction(for: message),
            onReply: { startReply(to: message) },
            onHold: { frame in heldMessage = (message, frame) }
        ) {
            MessageBubble(
                message: plainEmojiIfNeeded(message),
                showsTypingIndicator: false,
                isGroupStart: isGroupStart,
                isGroupEnd: isGroupEnd,
                showsTimestamp: shouldShowTimestamp(
                    for: message,
                    previous: previousMessage,
                    next: nextMessage,
                    isGroupEnd: isGroupEnd
                ),
                onActionCommand: { command in
                    viewModel.sendCommand(command, userId: appState.userId)
                },
                onOpenAction: { action in
                    handleActionOpen(action)
                },
                onRetryFailedTurn: {
                    viewModel.retryLastFailedMessage(userId: appState.userId)
                },
                onSceneRequest: { request in
                    viewModel.sendInterfaceRequest(request, userId: appState.userId)
                },
                reaction: adamReaction(on: message) ?? ReactionStore.shared.reaction(for: message)
            )
        }
        .id(message.id)
        .padding(.top, isGroupStart && idx > 0 ? 12 : 2)
        .transition(.opacity.combined(with: .move(edge: .bottom)))

        if message.id == viewModel.activeTurnUserMessageID, viewModel.isSending || viewModel.isWaitingForSavedReply, !replyStarted {
            WorkingBubble(label: currentStepLabel)
                .id("working-\(message.id)")
                .padding(.top, 10)
        }
    }

    @ViewBuilder
    private var reactionOverlay: some View {
        if let held = heldMessage {
            ReactionPicker(
                message: held.message,
                anchor: held.frame,
                current: ReactionStore.shared.reaction(for: held.message),
                onReact: { emoji in
                    if ReactionStore.shared.toggle(emoji, on: held.message) {
                        viewModel.sendReaction(emoji, on: held.message, userId: appState.userId)
                    }
                    HapticManager.shared.select()
                    heldMessage = nil
                },
                onReply: { startReply(to: held.message) },
                onCopy: { copyMessage(held.message) },
                onShowOnDisplay: {
                    displayText = held.message.content
                    heldMessage = nil
                },
                onClose: { heldMessage = nil }
            )
            .transition(.opacity)
        }
    }

    /// What the Adam button shows: you speaking, a yes being waited on, or work in progress.
    private var hubActivity: AdamActivityState? {
        if voiceInput.isRecording { return .listening }
        if boardModel.needsYou.contains(where: { boardModel.acknowledged[$0.id] == nil }) { return .waiting }
        if !boardModel.working.isEmpty || viewModel.isSending { return .working }
        return nil
    }

    private var wheelOverlay: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            ThreadWheelMenu(
                hub: CGPoint(x: hubCenter.x - origin.x, y: hubCenter.y - origin.y),
                isOpen: $wheelOpen,
                incognito: isIncognito,
                orderRaw: $wheelOrderRaw,
                onChoose: handleMenuChoice
            )
        }
        .ignoresSafeArea()
    }

    private func loadOlderMessages(_ proxy: ScrollViewProxy) {
        Task {
            guard let anchor = await viewModel.loadOlder(userId: appState.userId) else { return }
            proxy.scrollTo(anchor, anchor: .top)
        }
    }

    private static func dayLabel(for date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let sameYear = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
        return date.formatted(sameYear
            ? .dateTime.weekday(.abbreviated).day().month(.abbreviated)
            : .dateTime.day().month(.abbreviated).year())
    }

    private func handleMenuChoice(_ choice: ThreadMenuChoice) {
        if choice == .privateChat {
            withAnimation(.linear(duration: 0.15)) { isIncognito.toggle() }
            let key = "adam_private_explained"
            if isIncognito, !UserDefaults.standard.bool(forKey: key) {
                UserDefaults.standard.set(true, forKey: key)
                Task {
                    try? await Task.sleep(for: .milliseconds(600))
                    showsPrivateExplainer = true
                }
            }
        } else {
            onMenuChoice?(choice, hubCenter)
        }
    }

    /// What the user has asked here, so work that already answered in the thread isn't repeated as a card.
    private var askedInThread: [String] {
        viewModel.messages.suffix(60).filter { $0.role == .user }.map { ThreadBoardModel.normalized($0.content) }
    }

    /// The step in progress, only when it is something real to report.
    private var currentStepLabel: String? {
        guard let step = viewModel.activitySteps.last(where: { $0.state == .active }) else { return nil }
        let title = step.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty || title == "Working on it" ? nil : title
    }

    /// True once Adam's reply has any text, so the working animation can step aside.
    private var replyStarted: Bool {
        guard let last = viewModel.messages.last else { return false }
        return last.role == .assistant && !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var assistantReplySettled: Bool {
        guard let last = viewModel.messages.last else { return false }
        return last.role == .assistant && !last.isStreaming && !last.content.isEmpty
            && !ReactionText.isQuiet(last.content) && ReactionText.agentReaction(last.content) == nil
    }

    var body: some View {
        NavigationStack {
        ZStack {
            GlebChrome.pastelBlob
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // Offline banner
                if isOffline {
                    HStack(spacing: 8) {
                            AppIcon(sf: "wifi.slash", size: 14)
                            Text("No internet connection")
                                .font(.appBody(12, weight: .medium))
                        }
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color.appWarning)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    if viewModel.isViewingHistorySnapshot {
                        HStack(spacing: 10) {
                            AppIcon(sf: "clock.arrow.circlepath", size: 14)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Viewing history")
                                    .font(.appBody(12, weight: .semibold))
                                if let label = viewModel.historySnapshotLabel {
                                    Text(label)
                                        .font(.appBody(12))
                                }
                            }
                            Spacer()
                            Button("Current Chat") {
                                Task {
                                    await viewModel.returnToCurrentChat(userId: appState.userId)
                                }
                            }
                            .font(.appBody(12, weight: .semibold))
                        }
                        .foregroundStyle(Color.appMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color.appMuted.opacity(0.1))
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    if let networkError = viewModel.networkError {
                        ErrorBanner(
                            message: networkError,
                            onRetry: {
                                viewModel.retryLastFailedMessage(userId: appState.userId)
                            },
                            onDismiss: {
                                viewModel.networkError = nil
                            }
                        )
                        .padding(.top, 8)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    if let voiceErrorMessage {
                        ErrorBanner(
                            message: voiceErrorMessage,
                            onDismiss: {
                                self.voiceErrorMessage = nil
                                voiceInput.errorMessage = nil
                            }
                        )
                        .padding(.top, 8)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    // Messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                if viewModel.hasOlderHistory, !viewModel.messages.isEmpty {
                                    Color.clear
                                        .frame(height: 1)
                                        .onAppear { loadOlderMessages(proxy) }
                                }
                                ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { idx, message in
                                    messageRow(idx: idx, message: message)
                                }

                                ThreadBoardCards(model: boardModel, askedInThread: askedInThread)
                                    .padding(.horizontal, AppSpacing.chatMargin)
                                    .padding(.top, boardModel.isEmpty ? 0 : 14)

                                Color.clear
                                    .frame(height: 1)
                                    .id("bottom")
                                    .background(
                                        GeometryReader { geo in
                                            Color.clear.preference(
                                                key: ChatBottomDistanceKey.self,
                                                value: geo.frame(in: .named("chatScroll")).maxY
                                            )
                                        }
                                    )
                            }
                            .padding(.vertical, 12)
                            .animation(.appSpring, value: viewModel.messages.count)
                        }
                        .coordinateSpace(name: "chatScroll")
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(key: ChatViewportHeightKey.self, value: geo.size.height)
                            }
                        )
                        .onPreferenceChange(ChatViewportHeightKey.self) { height in
                            scrollViewportHeight = height
                        }
                        .onPreferenceChange(ChatBottomDistanceKey.self) { bottomY in
                            guard scrollViewportHeight > 0 else { return }
                            isScrollPinnedToBottom = bottomY <= scrollViewportHeight + 96
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            ThreadHeader(
                                isIncognito: isIncognito,
                                isWorking: !boardModel.working.isEmpty,
                                activity: hubActivity,
                                deviceOnline: boardModel.deviceOnline,
                                wheelOpen: $wheelOpen,
                                hubCenter: $hubCenter
                            )
                            .onChange(of: isIncognito) { _, on in
                                viewModel.incognito = on
                            }
                        }
                        .hidesTabBarOnScroll()
                        .onChange(of: viewModel.messages.count) {
                            ReactionStore.shared.migrate(with: viewModel.messages)
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            guard isScrollPinnedToBottom else { return }
                            withAnimation(.appSpring) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                        .onChange(of: viewModel.messages.last?.content) {
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            guard isScrollPinnedToBottom else { return }
                            withAnimation(.appSpring) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                        .onChange(of: viewModel.scrollTargetMessageID) { _, targetID in
                            guard let targetID else { return }
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(150))
                                withAnimation(.appStandard) {
                                    proxy.scrollTo(targetID, anchor: .center)
                                }
                                try? await Task.sleep(for: .milliseconds(700))
                                viewModel.scrollTargetMessageID = nil
                            }
                        }
                        .onChange(of: viewModel.messages.suffix(3).reduce(0) { $0 + $1.actions.count }) {
                            presentPendingReviewIfNeeded()
                            presentMessageComposerIfNeeded()
                        }
                    }

                    if let replyingTo {
                        ReplyPreviewBar(message: replyingTo) { withAnimation(.appSpring) { self.replyingTo = nil } }
                    }

                    // Input bar
                    ChatInputBar(
                        text: $viewModel.inputText,
                        isSending: isOffline,
                        isBusy: viewModel.isSending,
                        onStop: { viewModel.stopCurrentTurn() },
                        voiceLevel: { voiceInput.level() },
                        isRecording: voiceInput.isRecording,
                        isPreparingVoice: voiceInput.isTranscribing,
                        voiceTranscript: voiceInput.transcript,
                        attachmentLabel: pendingImageName,
                        attachmentData: pendingImageData,
                        attachmentIsImage: pendingIsImage,
                        isFocused: $isInputFocused,
                        incognito: isIncognito,
                        onSend: {
                            sendCurrentDraft()
                        },
                        onVoice: {
                            guard !voiceInput.isTranscribing else { return }
                            if voiceInput.isRecording {
                                HapticManager.shared.impact(.rigid)
                                voiceInput.stopRecording()
                            } else {
                                HapticManager.shared.impact(.medium)
                                voiceInput.startRecording(userId: appState.userId)
                            }
                        },
                        onAttach: {
                            HapticManager.shared.impact(.light)
                            isInputFocused = false
                            withAnimation(.spring(response: 0.38, dampingFraction: 0.72)) { showAttachMenu = true }
                        },
                        onCancelVoice: {
                            voiceInput.cancel()
                        },
                        onRemoveAttachment: {
                            pendingImageData = nil
                            pendingImageName = nil
                            pendingIsImage = true
                            selectedPhotoItem = nil
                        }
                    )
                }

                attachmentSheetOverlay
            }
            .toolbar(.hidden, for: .navigationBar)
            #if DEBUG
            .onAppear {
                if ProcessInfo.processInfo.environment["OXY_DEBUG_REVIEW"] == "1" {
                    let json = #"{"action":"transaction_authorize","success":false,"outcome":"awaiting_user","pending":true,"text":"Waiting for your yes","cardText":"Pay £54.20 to johnlewis.com with your Visa ending 4242.","actionSummary":"Place the order","subject":{"amount":"£54.20","merchant":"johnlewis.com","card":"Visa ending 4242"}}"#
                    pendingReviewAction = try? JSONDecoder().decode(ActionResult.self, from: Data(json.utf8))
                }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_RECORDING"] == "1" {
                    voiceInput.isRecording = true
                    voiceInput.transcript = "Remind me to call the dentist tomorrow morning and"
                }
            }
            #endif
            .modifier(ThreadLayers(reaction: reactionOverlay, wheel: wheelOverlay, heldID: heldMessage?.message.id, displayText: $displayText))
            .task {
                while !Task.isCancelled {
                    await boardModel.refresh()
                    try? await Task.sleep(for: boardModel.working.isEmpty ? .seconds(60) : .seconds(10))
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await boardModel.refresh() } }
            }
            .onReceive(NotificationCenter.default.publisher(for: AskAdam.notification)) { note in
                guard let text = note.object as? String else { return }
                viewModel.inputText = text
                Task {
                    try? await Task.sleep(for: .milliseconds(450))
                    isInputFocused = true
                }
            }
            .sheet(isPresented: $showsPrivateExplainer) {
                PrivateModeSheet()
                    .presentationDetents([.height(400)])
                    .presentationDragIndicator(.visible)
            }
            .modifier(ChatHaptics(replySettled: assistantReplySettled, failed: viewModel.networkError != nil))
            .onChange(of: assistantReplySettled) { _, settled in
                guard settled else { return }
                #if DEBUG
                let payload: [String: Any] = [
                    "area": "chat_ui",
                    "event": "ui_render_completion",
                    "t": Date().oxyISO8601String,
                    "messageCount": viewModel.messages.count
                ]
                if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                   let text = String(data: data, encoding: .utf8) {
                    print("[dev-timing] \(text)")
                }
                #endif
            }
            .sheet(item: $pendingReviewAction) { action in
                ActionReviewSheet(
                    action: action,
                    onConfirm: {
                        handledReviewActionIDs.insert(action.id)
                        pendingReviewAction = nil
                        viewModel.sendCommand("confirm", userId: appState.userId)
                    },
                    onCancel: {
                        handledReviewActionIDs.insert(action.id)
                        pendingReviewAction = nil
                        viewModel.sendCommand("cancel", userId: appState.userId)
                    }
                )
                .presentationDetents([.height(340), .medium])
                .presentationDragIndicator(.visible)
            }
            .sheet(item: $messageDraft) { draft in
                MessageComposeSheet(draft: draft) { result in
                    messageDraft = nil
                    handleMessageComposeResult(result)
                }
            }
            .alert("Messages unavailable", isPresented: Binding(
                get: { messageComposerAlert != nil },
                set: { if !$0 { messageComposerAlert = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(messageComposerAlert ?? "")
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhotoItem, matching: .any(of: [.images, .videos]))
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker(
                    onPhoto: { data in
                        showCamera = false
                        stageAttachment(data: data, name: "Photo", mime: "image/jpeg")
                    },
                    onVideo: { url in
                        showCamera = false
                        stageFile(at: url, name: "Video.mov", mime: "video/quicktime", deleteAfter: true)
                    },
                    onCancel: { showCamera = false }
                )
                .ignoresSafeArea()
            }
            .alert("Can't attach that", isPresented: Binding(
                get: { attachmentError != nil },
                set: { if !$0 { attachmentError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(attachmentError ?? "")
            }
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.pdf, .plainText, .commaSeparatedText, .json, .image, .audio, .data],
                allowsMultipleSelection: false
            ) { result in
                guard let url = try? result.get().first else { return }
                let didAccess = url.startAccessingSecurityScopedResource()
                defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
                stageFile(at: url, name: url.lastPathComponent, mime: mimeType(for: url))
            }
            .onChange(of: selectedPhotoItem) { _, item in
                guard let item else { return }
                Task {
                    if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                        if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                            await MainActor.run {
                                stageFile(at: movie.url, name: "Video.\(movie.url.pathExtension.isEmpty ? "mov" : movie.url.pathExtension)",
                                          mime: mimeType(for: movie.url), deleteAfter: true)
                            }
                        }
                    } else if let data = try? await item.loadTransferable(type: Data.self) {
                        await MainActor.run {
                            stageAttachment(data: data, name: "Photo",
                                            mime: data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? "image/png" : "image/jpeg")
                        }
                    }
                }
            }
            .onChange(of: pendingReviewAction) { oldValue, newValue in
                if let oldValue, newValue == nil {
                    handledReviewActionIDs.insert(oldValue.id)
                }
            }
            .onChange(of: voiceInput.isTranscribing) { _, nowTranscribing in
                guard !nowTranscribing else { return }
                submitVoiceTranscriptIfReady()
            }
            .onChange(of: voiceInput.transcript) {
                guard !voiceInput.isTranscribing else { return }
                submitVoiceTranscriptIfReady()
            }
            .onChange(of: voiceInput.errorMessage) {
                voiceErrorMessage = voiceInput.errorMessage
            }
            .onReceive(NotificationCenter.default.publisher(for: .oxyVoiceMessage)) { note in
                guard let text = note.userInfo?["text"] as? String else { return }
                SiriRequestBus.shared.pendingQuery = nil
                injectVoiceMessage(text)
            }
            .onReceive(NotificationCenter.default.publisher(for: .oxyDraftMessage)) { note in
                guard let text = note.userInfo?["text"] as? String else { return }
                viewModel.inputText = text
            }
            .onReceive(NotificationCenter.default.publisher(for: .oxyPendantCommand)) { note in
                guard let rawCommand = note.userInfo?["command"] as? String,
                      let command = PendantCommand.parse(Data(rawCommand.utf8)) else { return }
                let queued = PendantCommandBus.shared.takeAll()
                if queued.isEmpty {
                    handlePendantCommand(command)
                } else {
                    queued.forEach(handlePendantCommand)
                }
            }
        .task {
            #if DEBUG
            ChatInputBar.runComposerRuleCheck()
            #endif
            if let session = initialSession {
                await viewModel.loadHistoryAround(
                    userId: appState.userId,
                    createdAt: session.lastAt ?? session.startedAt ?? ""
                )
            } else if startFresh {
                viewModel.startNewChat(userId: appState.userId)
            } else {
                await viewModel.prepareChat(userId: appState.userId)
            }
            if let initialReviewAction {
                pendingReviewAction = initialReviewAction
            }
            if let transcript = autoSendTranscript, !transcript.isEmpty {
                injectVoiceMessage(transcript)
            }
            if let pending = SiriRequestBus.shared.take() {
                injectVoiceMessage(pending)
            }
            PendantCommandBus.shared.takeAll().forEach(handlePendantCommand)
            if appState.isDemoSession,
               !didSendAutoDemoMessage,
               let autoDemoMessage = UserDefaults.standard.string(forKey: "oxy_auto_demo_message"),
               !autoDemoMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !UserDefaults.standard.bool(forKey: "oxy_auto_demo_message_sent") {
                didSendAutoDemoMessage = true
                UserDefaults.standard.set(true, forKey: "oxy_auto_demo_message_sent")
                UserDefaults.standard.removeObject(forKey: "oxy_auto_demo_message")
                injectVoiceMessage(autoDemoMessage)
            }
        }
        .onAppear {
            if !appState.isDemoSession {
                viewModel.requestLocationAccess()
            }
            networkMonitor.pathUpdateHandler = { path in
                DispatchQueue.main.async {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        isOffline = path.status != .satisfied
                    }
                }
            }
            networkMonitor.start(queue: DispatchQueue(label: "oxy.networkMonitor"))
        }
        }
    }

    // MARK: - Attachment sheet (custom, flat obsidian)

    @ViewBuilder
    private var attachmentSheetOverlay: some View {
        if showAttachMenu {
            ZStack(alignment: .bottomLeading) {
                Color.black.opacity(0.18)
                    .ignoresSafeArea()
                    .onTapGesture { dismissAttachMenu() }

                VStack(spacing: 0) {
                    attachSheetRow("Camera", icon: "camera") {
                        dismissAttachMenu()
                        openCamera()
                    }
                    Rectangle().fill(Color.appCardOutline).frame(height: 1).padding(.leading, 52)
                    attachSheetRow("Photos & Videos", icon: "photo") {
                        dismissAttachMenu()
                        showPhotoPicker = true
                    }
                    Rectangle().fill(Color.appCardOutline).frame(height: 1).padding(.leading, 52)
                    attachSheetRow("Files", icon: "doc") {
                        dismissAttachMenu()
                        showFileImporter = true
                    }
                }
                .frame(width: 232)
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.appReceivedBubble))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.appCardOutline, lineWidth: 1))
                .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
                .padding(.leading, 14)
                .padding(.bottom, 74)
                .transition(.scale(scale: 0.4, anchor: .bottomLeading).combined(with: .opacity))
            }
            .zIndex(20)
        }
    }

    private func attachSheetRow(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.shared.impact(.light)
            action()
        } label: {
            HStack(spacing: 14) {
                AppIcon(icon, size: 20)
                    .foregroundStyle(Color.appInk)
                    .frame(width: 24)
                Text(title)
                    .font(.appBody(16, weight: .medium))
                    .foregroundStyle(Color.appInk)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.97))
    }

    private func dismissAttachMenu() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { showAttachMenu = false }
    }

    /// Send a spoken transcript once.
    private func injectVoiceMessage(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        viewModel.inputText = text
        viewModel.sendMessage(userId: appState.userId)
    }

    private func submitVoiceTranscriptIfReady() {
        let text = voiceInput.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        voiceInput.transcript = ""
        voiceErrorMessage = nil
        viewModel.inputText = text
        viewModel.sendMessage(userId: appState.userId)
    }

    private func sendCurrentDraft() {
        HapticManager.shared.impact(.light)
        if let pendingImageData {
            let defaultName = pendingImageMimeType == "image/png" ? "photo.png" : "photo.jpg"
            viewModel.sendImageMessage(
                userId: appState.userId,
                imageData: pendingImageData,
                fileName: (pendingIsImage ? nil : pendingImageName) ?? defaultName,
                mimeType: pendingImageMimeType,
                isImage: pendingIsImage
            )
            self.pendingImageData = nil
            pendingImageName = nil
            pendingIsImage = true
            selectedPhotoItem = nil
        } else {
            if let replyingTo, !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                viewModel.inputText = ReplyQuote.compose(quoting: replyingTo, body: viewModel.inputText)
            }
            withAnimation(.appSpring) { replyingTo = nil }
            viewModel.sendMessage(userId: appState.userId)
        }
    }

    private func startReply(to message: Message) {
        heldMessage = nil
        withAnimation(.appSpring) { replyingTo = message }
        isInputFocused = true
    }

    private func copyMessage(_ message: Message) {
        UIPasteboard.general.string = ReplyQuote.split(message.content)?.body ?? message.content
        HapticManager.shared.success()
        heldMessage = nil
    }

    /// The pendant only controls the same local interaction paths a person can
    /// tap. In particular, CONFIRM/CANCEL do nothing without a visible pending
    /// review; they can never turn an arbitrary BLE packet into an external
    /// action.
    private func handlePendantCommand(_ command: PendantCommand) {
        switch command {
        case .openChat, .connected, .pong:
            break
        case .startRecording:
            guard !voiceInput.isRecording, !voiceInput.isTranscribing else { return }
            HapticManager.shared.impact(.medium)
            voiceInput.startRecording(userId: appState.userId)
        case .stopRecording:
            guard voiceInput.isRecording else { return }
            HapticManager.shared.impact(.medium)
            voiceInput.stopRecording()
        case .toggleRecording:
            HapticManager.shared.impact(.medium)
            if voiceInput.isRecording {
                voiceInput.stopRecording()
            } else if !voiceInput.isTranscribing {
                voiceInput.startRecording(userId: appState.userId)
            }
        case .sendMessage:
            guard !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            sendCurrentDraft()
        case .confirm:
            guard let action = pendingReviewAction else { return }
            handledReviewActionIDs.insert(action.id)
            pendingReviewAction = nil
            viewModel.sendCommand("confirm", userId: appState.userId)
        case .cancel:
            guard let action = pendingReviewAction else { return }
            handledReviewActionIDs.insert(action.id)
            pendingReviewAction = nil
            viewModel.sendCommand("cancel", userId: appState.userId)
        }
    }

    private static let attachmentLimit = 25 * 1024 * 1024

    private func openCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            attachmentError = "The camera isn't available on this device."
            return
        }
        showCamera = true
    }

    private func stageAttachment(data: Data, name: String, mime: String) {
        guard data.count <= Self.attachmentLimit else {
            HapticManager.shared.error()
            attachmentError = "That's over the 25 MB limit."
            return
        }
        pendingImageData = data
        pendingImageName = name
        pendingImageMimeType = mime
        pendingIsImage = mime.hasPrefix("image/")
    }

    /// Reads a file for sending, checking its size first so a large video never gets loaded into memory.
    private func stageFile(at url: URL, name: String, mime: String, deleteAfter: Bool = false) {
        defer { if deleteAfter { try? FileManager.default.removeItem(at: url) } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Self.attachmentLimit else {
            HapticManager.shared.error()
            attachmentError = "That's over the 25 MB limit."
            return
        }
        guard let data = try? Data(contentsOf: url) else { return }
        stageAttachment(data: data, name: name, mime: mime)
    }

    private func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "txt", "text": return "text/plain"
        case "md", "markdown": return "text/markdown"
        case "csv": return "text/csv"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "doc": return "application/msword"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xls": return "application/vnd.ms-excel"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "heif": return "image/heif"
        case "mov": return "video/quicktime"
        case "mp4", "m4v": return "video/mp4"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "aac": return "audio/aac"
        default: return "application/octet-stream"
        }
    }

    private func presentPendingReviewIfNeeded() {
        guard pendingReviewAction == nil else { return }
        guard let action = viewModel.messages
            .suffix(3)
            .flatMap(\.actions)
            .last(where: { $0.pending && !handledReviewActionIDs.contains($0.id) }) else {
            return
        }
        handledReviewActionIDs.insert(action.id)
        pendingReviewAction = action
    }

    private func presentMessageComposerIfNeeded() {
        guard pendingReviewAction == nil, messageDraft == nil else { return }
        let cutoff = Date().addingTimeInterval(-90)
        guard let action = viewModel.messages
            .suffix(3)
            .filter({ $0.timestamp >= cutoff })
            .flatMap(\.actions)
            .last(where: {
                $0.action == "send_message"
                    && $0.success
                    && !$0.pending
                    && !handledMessageComposeActionIDs.contains($0.id)
            }) else {
            return
        }
        handledMessageComposeActionIDs.insert(action.id)
        guard let draft = MessageDraft(action: action) else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard pendingReviewAction == nil, messageDraft == nil else { return }
            presentMessageDraft(draft)
        }
    }

    private func handleActionOpen(_ action: ActionResult) {
        HapticManager.shared.impact(.light)
        if action.action == "send_message", let draft = MessageDraft(action: action) {
            presentMessageDraft(draft)
            return
        }
        viewModel.openActionLink(action)
    }

    private func presentMessageDraft(_ draft: MessageDraft) {
        guard MFMessageComposeViewController.canSendText() else {
            messageComposerAlert = "This device cannot send text messages from an in-app composer."
            return
        }
        messageDraft = draft
    }

    private func handleMessageComposeResult(_ result: MessageComposeResult) {
        switch result {
        case .sent:
            viewModel.statusLabel = "Message sent"
        case .cancelled:
            viewModel.statusLabel = nil
        case .failed:
            viewModel.statusLabel = "Message failed"
        @unknown default:
            viewModel.statusLabel = nil
        }
    }

    private func shouldShowTimestamp(
        for message: Message,
        previous: Message?,
        next: Message?,
        isGroupEnd: Bool
    ) -> Bool {
        // Times live in the dividers where the conversation pauses, not under messages.
        false
    }
}

/// Chat haptics.
private struct ChatHaptics: ViewModifier {
    let replySettled: Bool
    let failed: Bool

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(trigger: replySettled) { _, settled in
                settled ? .impact(weight: .medium, intensity: 1.0) : nil
            }
            .sensoryFeedback(trigger: failed) { _, didFail in
                didFail ? .warning : nil
            }
    }
}

struct MessageDraft: Identifiable, Equatable {
    let id = UUID()
    let recipients: [String]
    let body: String

    init(recipients: [String], body: String) {
        self.recipients = recipients
        self.body = body
    }

    init?(action: ActionResult) {
        guard let link = action.deepLink ?? action.webLink,
              link.lowercased().hasPrefix("sms:") else { return nil }
        let rawPayload = String(link.dropFirst(4))
        let parts = rawPayload.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let rawRecipientAndMaybeBody = String(parts.first ?? "")
        let rawQuery = parts.count > 1 ? String(parts[1]) : ""
        let legacyPieces = rawRecipientAndMaybeBody.split(separator: "&", maxSplits: 1, omittingEmptySubsequences: false)
        let rawRecipient = String(legacyPieces.first ?? "")
        let query = rawQuery.isEmpty && legacyPieces.count > 1 ? String(legacyPieces[1]) : rawQuery
        let recipient = rawRecipient.removingPercentEncoding ?? rawRecipient
        let body = MessageDraft.body(from: query)
        guard !recipient.isEmpty || !body.isEmpty else { return nil }
        self.recipients = recipient.isEmpty ? [] : [recipient]
        self.body = body
    }

    private static func body(from query: String) -> String {
        guard !query.isEmpty else { return "" }
        var components = URLComponents()
        components.percentEncodedQuery = query.trimmingCharacters(in: CharacterSet(charactersIn: "&?"))
        return components.queryItems?.first(where: { $0.name == "body" })?.value ?? ""
    }
}

private struct MessageComposeSheet: UIViewControllerRepresentable {
    let draft: MessageDraft
    let onFinish: @MainActor @Sendable (MessageComposeResult) -> Void

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let controller = MFMessageComposeViewController()
        controller.messageComposeDelegate = context.coordinator
        controller.recipients = draft.recipients
        controller.body = draft.body
        return controller
    }

    func updateUIViewController(_ uiViewController: MFMessageComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: @MainActor @Sendable (MessageComposeResult) -> Void

        init(onFinish: @escaping @MainActor @Sendable (MessageComposeResult) -> Void) {
            self.onFinish = onFinish
        }

        func messageComposeViewController(
            _ controller: MFMessageComposeViewController,
            didFinishWith result: MessageComposeResult
        ) {
            let finish = onFinish
            Task { @MainActor in
                controller.dismiss(animated: true)
                finish(result)
            }
        }
    }
}

/// The system camera, for a photo or a short video.
private struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (Data) -> Void
    let onVideo: (URL) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoMaximumDuration = 30
        picker.videoQuality = .typeMedium
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                parent.onVideo(url)
            } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
                parent.onPhoto(data)
            } else {
                parent.onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.onCancel() }
    }
}

/// A video picked from Photos, copied to a temporary file so its size can be checked before it is read.
private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

private struct ActionReviewSheet: View {
    let action: ActionResult
    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var isPayment: Bool {
        action.action == "transaction_authorize" ||
        (action.actionSummary ?? "").localizedCaseInsensitiveContains("payment") ||
        (action.actionSummary ?? "").localizedCaseInsensitiveContains("order") ||
        (action.text ?? "").localizedCaseInsensitiveContains("charge") ||
        (action.cardText ?? "").localizedCaseInsensitiveContains("£") ||
        action.actionSummary == "Awaiting payment confirmation"
    }

    private var title: String {
        if isPayment {
            return action.actionSummary ?? "Confirm order"
        }
        return action.actionSummary ?? {
            switch action.action {
            case "send_email", "send_outlook_email": return "Email ready to send"
            case "send_message", "send_telegram": return "Message ready to send"
            case "make_call": return "Call ready to make"
            case "create_calendar_event": return "Calendar event ready"
            default: return "This needs your OK"
            }
        }()
    }

    /// The figures the payment page and saved card stated, when the server sent them.
    private var purchase: ResultSubject? {
        guard isPayment, let subject = action.subject, subject.amount != nil else { return nil }
        return subject
    }

    private var confirmLabel: String {
        if let amount = purchase?.amount { return "Pay \(amount)" }
        if isPayment { return "Confirm & Place Order" }
        switch action.action {
        case "send_email", "send_outlook_email": return "Send"
        case "send_message", "send_telegram": return "Send"
        case "make_call": return "Call"
        case "create_calendar_event": return "Add"
        case "book_appointment": return "Book"
        default: return "Confirm"
        }
    }

    private var detail: String {
        cleanDetail(action.cardText ?? action.text ?? "Ready.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Capsule()
                .fill(Color.appHairline)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)

            HStack(spacing: 12) {
                AppIcon(sf: iconName, size: 17)
                    .foregroundStyle(isPayment ? Color.appAccent : Color.appMuted)
                    .frame(width: 36, height: 36)
                    .background(
                        Circle().fill(isPayment ? Color.appAccent.opacity(0.15) : Color.appSurface)
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.sectionTitle)
                        .foregroundStyle(Color.appInk)
                }
                Spacer()
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Needs your OK")
                    .appEyebrow()
                    .foregroundStyle(isPayment ? Color.appAccent.opacity(0.9) : Color.appMuted)
                if let purchase {
                    purchaseReceipt(purchase)
                } else {
                    Text(detail)
                        .font(.appBody(15))
                        .foregroundStyle(Color.appInk)
                        .lineSpacing(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
            .background(Color.appSurface.opacity(0.82))
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous)
                    .stroke(isPayment ? Color.appAccent.opacity(0.28) : Color.appHairline, lineWidth: 0.75)
            )

            if isPayment {
                Text("Double-check the total and address on the site if anything looks off.")
                    .font(.appBody(12))
                    .foregroundStyle(Color.appMuted)
            }

            HStack(spacing: 12) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.appBody(15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.appScale)
                .foregroundStyle(Color.appMuted)
                .background(Color.appSurface2)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.md))

                Button(action: onConfirm) {
                    Text(confirmLabel)
                        .font(.appBody(15, weight: .semibold))
                        .foregroundStyle(Color.appOnAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.appScale)
                .foregroundStyle(Color.appOnAccent)
                .background(isPayment ? Color.appAccent : Color.appAccent)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.md))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.appBackground)
    }

    /// The amount large, then the shop and the card, so the person sees exactly what they are approving.
    private func purchaseReceipt(_ purchase: ResultSubject) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let amount = purchase.amount {
                Text(amount)
                    .font(.appEditorial(36, weight: 400, soft: 30, wonk: false, relativeTo: .largeTitle))
                    .foregroundStyle(Color.appInk)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
            }
            if let merchant = purchase.merchant {
                HStack(spacing: 8) {
                    AppIcon("cube", size: 15).foregroundStyle(Color.appMuted)
                    Text(merchant)
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                }
            }
            if let card = purchase.card {
                HStack(spacing: 8) {
                    AppIcon("card", size: 15).foregroundStyle(Color.appMuted)
                    Text(card)
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func cleanDetail(_ raw: String) -> String {
        raw.strippingMarkdown
            .replacingOccurrences(of: #"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?"#, with: "$3/$2/$1 at $4:$5", options: .regularExpression)
            .replacingOccurrences(of: #"(?i)\b(title|start|end|notes|recipient|body):\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "\n\n+", with: "\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var iconName: String {
        if isPayment { return "creditcard.fill" }
        switch action.action {
        case "send_email": return "envelope.fill"
        case "send_message": return "message.fill"
        case "send_telegram": return "paperplane.fill"
        case "make_call": return "phone.fill"
        case "create_calendar_event": return "calendar.badge.plus"
        default: return "checkmark.circle.fill"
        }
    }
}

struct ChatSessionSummary: Codable, Identifiable, Hashable {
    static func == (lhs: ChatSessionSummary, rhs: ChatSessionSummary) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    let id: String
    let title: String
    let preview: String
    let startedAt: String?
    let lastAt: String?
    let messageCount: Int
    let channel: String?

    enum CodingKeys: String, CodingKey {
        case id, title, preview
        case startedAt = "started_at"
        case lastAt = "last_at"
        case messageCount = "message_count"
        case channel
    }

    var channelLabel: String? {
        channel == "telegram_bot" ? "Telegram" : nil
    }

    var formattedDate: String? {
        let date = Date.oxyParse(lastAt ?? startedAt)
        guard let date else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "d MMM · HH:mm"
        return fmt.string(from: date)
    }

    var relativeTime: String {
        guard let date = Date.oxyParse(lastAt ?? startedAt) else { return "" }
        let diff = Date().timeIntervalSince(date)
        if diff < 60 { return "just now" }
        if diff < 3600 { return "\(Int(diff / 60))m ago" }
        if diff < 86400 { return "\(Int(diff / 3600))h ago" }
        if diff < 7 * 86400 { return "\(Int(diff / 86400))d ago" }
        let fmt = DateFormatter()
        fmt.dateFormat = "d MMM"
        return fmt.string(from: date)
    }
}

// MARK: - Welcome Card

/// Empty chat.
// ScaleButtonStyle kept for local usage — delegates to AppScaleButtonStyle at 0.96
private typealias ScaleButtonStyle = AppScaleButtonStyle

private struct ChatViewportHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct ChatBottomDistanceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - Chat Input Bar

private struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    var isBusy: Bool = false
    var onStop: () -> Void = {}
    var voiceLevel: (() -> Double)? = nil
    let isRecording: Bool
    let isPreparingVoice: Bool
    let voiceTranscript: String
    let attachmentLabel: String?
    let attachmentData: Data?
    let attachmentIsImage: Bool
    var isFocused: FocusState<Bool>.Binding
    let incognito: Bool
    let onSend: () -> Void
    let onVoice: () -> Void
    let onAttach: () -> Void
    let onCancelVoice: () -> Void
    let onRemoveAttachment: () -> Void

    @State private var pulse = false

    var body: some View {
        VStack(spacing: 0) {
            if let attachmentLabel {
                HStack(spacing: 10) {
                    if attachmentIsImage, let attachmentData, let uiImage = UIImage(data: attachmentData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 38, height: 38)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(Color.primary.opacity(0.1), lineWidth: 1)
                            )
                    } else {
                        AppIcon(sf: attachmentIsImage ? "photo.fill" : "doc.fill", size: 17)
                            .foregroundStyle(Color.appMuted)
                            .frame(width: 38, height: 38)
                            .appGlass(RoundedRectangle(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachmentLabel)
                            .font(.appBody(13, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .lineLimit(1)
                        Text(attachmentIsImage ? "Ready for analysis" : "Ready to read")
                            .font(.appBody(12))
                            .foregroundStyle(Color.appMuted)
                    }
                    Spacer()
                    Button(action: onRemoveAttachment) {
                        AppIcon(sf: "xmark.circle.fill", size: 17)
                            .foregroundStyle(Color.appMuted)
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.appScale)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.appSurface)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.5))
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }

            HStack(alignment: .bottom, spacing: 8) {
                Button(action: onAttach) {
                    AppIcon(sf: "plus", size: 18)
                        .foregroundStyle(isVoiceActive ? Color.appMuted.opacity(0.45) : Color.appInk.opacity(0.8))
                        .frame(width: 38, height: 38)
                        .appGlass(Circle(), interactive: true)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .accessibilityLabel("Add a photo, video or file")
                .buttonStyle(.appScale)
                .disabled(isSending || isVoiceActive)

                Group {
                    if isVoiceActive {
                        voiceField
                    } else {
                        textField
                    }
                }
                .frame(minHeight: 38)

                Button(action: showsStop ? onStop : (canSend ? onSend : onVoice)) {
                    ZStack {
                        if showsStop {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(Color.appOnAction)
                                .frame(width: 12, height: 12)
                        } else if isPreparingVoice && !canSend {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color.appMuted)
                        } else {
                            AppIcon(sf: canSend ? "arrow.up" : (isRecording ? "stop.fill" : "mic.fill"), size: 15)
                        }
                    }
                    .foregroundStyle(buttonForeground)
                    .frame(width: 38, height: 38)
                    .background {
                        if isRecording {
                            Circle()
                                .strokeBorder(Color.appAction.opacity(pulse ? 0 : 0.4), lineWidth: 2)
                                .scaleEffect(pulse ? 1.6 : 1)
                                .animation(.easeOut(duration: 1.3).repeatForever(autoreverses: false), value: pulse)
                        }
                        if canSend || showsStop || isRecording {
                            Circle().fill(buttonFill)
                        } else {
                            Color.clear.appGlass(Circle(), interactive: true)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                }
                .disabled(!canAct && !showsStop)
                .accessibilityLabel(showsStop ? "Stop" : (canSend ? "Send" : "Talk to Adam"))
                .buttonStyle(ScaleButtonStyle())
                .animation(.appFast, value: canAct)
                .animation(.appFast, value: canSend)
                .animation(.appFast, value: isRecording)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 8)
        }
        .onAppear { pulse = true }
    }

    private var textField: some View {
        TextField(isSending ? "You're offline" : (incognito ? "Private · not saved" : "Message Adam"), text: $text, axis: .vertical)
            .font(.appBody(15, weight: .regular))
            .foregroundStyle(Color.appInk)
            .tint(Color.appMuted)
            .lineLimit(1...6)
            .focused(isFocused)
            .disabled(isSending)
            .opacity(isSending ? 0.72 : 1)
            .onSubmit { if canSend { onSend() } }
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background(Color.appSurface2.opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous)
                    .strokeBorder(
                        incognito
                            ? Color.appAccent.opacity(0.28)
                            : (isFocused.wrappedValue
                                ? Color.appAccent.opacity(0.12)
                                : Color.appHairline),
                        lineWidth: (incognito || isFocused.wrappedValue) ? 0.75 : 0.5
                    )
                    .animation(.appFast, value: isFocused.wrappedValue)
                    .animation(.appFast, value: incognito)
            )
            .accessibilityHint(incognito ? "Private chat. This turn is not saved." : "")
    }

    private var voiceField: some View {
        let heard = voiceTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(spacing: 10) {
            Button {
                HapticManager.shared.select()
                onCancelVoice()
            } label: {
                AppIcon(sf: "xmark", size: 13)
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.appScale)
            .accessibilityLabel("Cancel")

            AdamActivityMark(state: isPreparingVoice ? .working : .listening, size: 28, tint: isPreparingVoice ? Color.appMuted : Color.appAccent, level: voiceLevel)

            Group {
                if isPreparingVoice {
                    ShimmerText(text: "Writing it down", font: .appBody(15, weight: .medium))
                } else if heard.isEmpty {
                    Text("Listening")
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appInk)
                } else {
                    Text(heard)
                        .font(.appBody(15))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(2)
                        .truncationMode(.head)
                }
            }
            .animation(.appStandard, value: heard)
            Spacer(minLength: 0)
        }
        .padding(.trailing, 10)
        .frame(minHeight: 46)
        .background(Color.appReceivedBubble.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous)
                .strokeBorder(Color.appCardOutline, lineWidth: 1)
        )
    }

    /// While Adam is writing a reply and nothing is typed, the button becomes Stop.
    private var showsStop: Bool { isBusy && !canSend }

    private var canSend: Bool {
        Self.canSendDraft(text: text, attachmentLabel: attachmentLabel, isOffline: isSending)
    }

    private var isVoiceActive: Bool {
        isRecording || isPreparingVoice
    }

    private var buttonFill: Color {
        if canSend || showsStop || isRecording { return Color.appAction }
        return Color.appSurface
    }

    private var buttonForeground: Color {
        if canSend || isRecording { return Color.appOnAction }
        return canAct ? Color.appInk.opacity(0.8) : Color.appMuted.opacity(0.5)
    }

    private var canAct: Bool {
        !isSending && !isPreparingVoice
    }

    static func canSendDraft(text: String, attachmentLabel: String?, isOffline: Bool) -> Bool {
        !isOffline && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachmentLabel != nil)
    }

    #if DEBUG
    static func runComposerRuleCheck() {
        assert(canSendDraft(text: "I'm taking a train", attachmentLabel: nil, isOffline: false), "composer should allow corrections while assistant work is active")
        assert(!canSendDraft(text: "I'm taking a train", attachmentLabel: nil, isOffline: true), "composer should still respect offline state")
        assert(canSendDraft(text: "", attachmentLabel: "Photo", isOffline: false), "attachments should be sendable when online")
    }
    #endif
}

// MARK: - Activity Card

// MARK: - Pendant Floating Overlay



/// The reaction picker and the menu wheel sit above the thread; grouped so the screen's body stays simple.
private struct ThreadLayers<Reaction: View, Wheel: View>: ViewModifier {
    let reaction: Reaction
    let wheel: Wheel
    let heldID: UUID?
    @Binding var displayText: String?

    func body(content: Content) -> some View {
        content
            .overlay { reaction }
            .animation(.appStandard, value: heldID)
            .overlay { wheel }
            .sheet(isPresented: Binding(
                get: { displayText != nil },
                set: { if !$0 { displayText = nil } }
            )) {
                DisplayRenderSheet(content: displayText ?? "")
            }
    }
}


/// What Private mode does and doesn't do, at full contrast and without claiming more than Adam controls.
private struct PrivateModeSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Private mode")
                .font(.pageTitle)
                .foregroundStyle(Color.appInk)
            point("Adam doesn't save this chat or learn from it.")
            point("To answer, Adam may still use the web, your connected apps and its AI provider. They handle your data under their own rules.")
            point("Anything Adam does for you, like sending a message, still shows in Activity.")
            Spacer(minLength: 0)
            Button {
                HapticManager.shared.impact(.light)
                dismiss()
            } label: {
                Text("Got it")
                    .font(.appBody(16, weight: .semibold))
                    .foregroundStyle(Color.appOnAction)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Capsule().fill(Color.appAction))
            }
            .buttonStyle(.appScale(0.98))
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appBackground.ignoresSafeArea())
    }

    private func point(_ text: String) -> some View {
        Text(text)
            .font(.appBody(16))
            .foregroundStyle(Color.appInk)
            .fixedSize(horizontal: false, vertical: true)
    }
}
