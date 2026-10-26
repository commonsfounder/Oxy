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
    @State private var overviewSelected = true
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var showsOverview: Bool {
        overviewSelected && !isIncognito && initialSession == nil && !startFresh && !viewModel.isViewingHistorySnapshot
    }
    @State private var expandedExchanges = Set<UUID>()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @State private var nextAttachmentSource: AttachmentSource?
    @State private var isLoadingAttachment = false

    private enum AttachmentSource { case camera, photos, files }
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
    @State private var didSettleAtBottom = false
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
        if message.role == .assistant, let previousMessage,
           !Calendar.current.isDate(previousMessage.timestamp, inSameDayAs: message.timestamp)
                || message.timestamp.timeIntervalSince(previousMessage.timestamp) > 20 * 60 {
            Text("\(Self.dayLabel(for: message.timestamp)) · \(message.timestamp.formatted(date: .omitted, time: .shortened))")
                .font(.appBody(12))
                .foregroundStyle(Color.appMuted)
                .padding(.horizontal, AppSpacing.chatMargin)
                .padding(.top, 16)
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
                showsTimestamp: false,
                onActionCommand: { command in
                    viewModel.sendCommand(command, userId: appState.userId)
                },
                onOpenAction: { action in
                    handleActionOpen(action)
                },
                onRetryFailedTurn: viewModel.canRetryFailedMessage(id: message.id) ? {
                    viewModel.retryFailedMessage(id: message.id, userId: appState.userId)
                } : nil,
                onSceneRequest: { request in
                    viewModel.sendInterfaceRequest(request, userId: appState.userId)
                },
                reaction: adamReaction(on: message) ?? ReactionStore.shared.reaction(for: message)
            )
        }
        .id(message.id)
        .padding(.top, isGroupStart && message.role == .assistant ? 12 : 2)
        .transition(.opacity.combined(with: .move(edge: .bottom)))

        if message.id == viewModel.activeTurnUserMessageID, viewModel.isSending || viewModel.isWaitingForSavedReply, !replyStarted {
            WorkingBubble(label: currentStepLabel)
                .id("working-\(message.id)")
                .padding(.top, 10)
        }
    }

    private var exchanges: [ThreadExchange] {
        ThreadExchange.group(viewModel.messages.filter { !isHiddenInThread($0) })
    }

    private func exchangeIsOpen(_ exchange: ThreadExchange) -> Bool {
        exchange.id == exchanges.last?.id || expandedExchanges.contains(exchange.id)
            || exchange.messages.contains { message in
                message.isStreaming || message.turnError != nil || message.actions.contains(where: \.needsUser)
                    || (viewModel.isSending && message.id == viewModel.activeTurnUserMessageID)
            }
    }

    @ViewBuilder
    private func exchangeSection(_ exchange: ThreadExchange) -> some View {
        let isOpen = exchangeIsOpen(exchange)
        VStack(alignment: .leading, spacing: 0) {
            if exchange.id != exchanges.last?.id {
                Button {
                    HapticManager.shared.select()
                    withAnimation(reduceMotion ? nil : .appStandard) {
                        if !expandedExchanges.insert(exchange.id).inserted {
                            expandedExchanges.remove(exchange.id)
                        }
                    }
                } label: {
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(Self.dayLabel(for: exchange.date))
                                .font(.appBody(12, weight: .medium))
                                .foregroundStyle(Color.appMuted)
                            if !isOpen {
                                Text(exchange.title)
                                    .font(.appBody(17, weight: .medium))
                                    .foregroundStyle(Color.appInk)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 0)
                        if !exchange.requiresAttention {
                            AppIcon("chevron-down", size: 14)
                                .foregroundStyle(Color.appMuted)
                                .rotationEffect(.degrees(isOpen ? 180 : 0))
                                .padding(.top, 5)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, AppSpacing.chatMargin)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(exchange.title)
                .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
                .accessibilityHint("Show or hide earlier messages")
                .disabled(exchange.requiresAttention)
            }
            if isOpen {
                ForEach(exchange.messages) { message in
                    if let idx = viewModel.messages.firstIndex(where: { $0.id == message.id }) {
                        messageRow(idx: idx, message: message)
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .background(isOpen ? Color.appSurface : Color.clear)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.appHairline).frame(height: 0.5)
        }
        .id("exchange-\(exchange.id)")
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
        if !boardModel.submittingDecisions.isEmpty || boardModel.hasDecisionReadback { return .working }
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

    private var overview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if horizontalSizeClass == .regular && !typeSize.isAccessibilitySize {
                HStack(alignment: .top, spacing: 32) {
                    ThreadBoardCards(model: boardModel, askedInThread: askedInThread, isOverview: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    overviewContext
                        .frame(width: 280)
                }
            } else {
                ThreadBoardCards(model: boardModel, askedInThread: askedInThread, isOverview: true)
                overviewContext
            }
        }
        .padding(.horizontal, AppSpacing.chatMargin)
        .padding(.top, 0).padding(.bottom, 24)
        .id("overview")
    }

    private var overviewContext: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 14) {
                Text("For today").font(.sectionTitle).foregroundStyle(Color.appInk)
                    .accessibilityAddTraits(.isHeader)
                TodaySuggestionsContent(limit: 1, onMore: { onMenuChoice?(.today, hubCenter) })
            }
            VStack(alignment: .leading, spacing: 0) {
                    contextDestination(.memory, icon: "wheel-memory")
                    contextDestination(.home, icon: "wheel-home")
            }
            .id("overview-context")
        }
    }

    private func contextDestination(_ choice: ThreadMenuChoice, icon: String) -> some View {
        Button { onMenuChoice?(choice, hubCenter) } label: {
            HStack(spacing: 16) {
                AppIcon(icon, size: 22).foregroundStyle(Color.appAccent)
                    .accessibilityHidden(true)
                    Text(choice.title).font(.appBody(17, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    AppIcon("chevron-right", size: 14).foregroundStyle(Color.appMuted)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { Color.appHairline.frame(height: 0.5) }
        }
        .buttonStyle(.appScale)
    }

    private var quietConversation: some View {
        VStack(alignment: .leading, spacing: 24) {
            if viewModel.isLoadingHistory {
                ProgressView("Loading conversation")
                    .font(.appBody(15))
                    .foregroundStyle(Color.appMuted)
            } else if viewModel.networkError == nil {
                Text("No messages yet")
                    .font(.appRounded(28, weight: .semibold, relativeTo: .title1))
                    .foregroundStyle(Color.appInk)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        quietDestination(.today, icon: "wheel-today")
                        quietDestination(.memory, icon: "wheel-memory")
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        quietDestination(.today, icon: "wheel-today")
                        quietDestination(.memory, icon: "wheel-memory")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AppSpacing.chatMargin)
        .padding(.vertical, 32)
    }

    private func quietDestination(_ choice: ThreadMenuChoice, icon: String) -> some View {
        Button { onMenuChoice?(choice, hubCenter) } label: {
            HStack(spacing: 10) {
                AppIcon(icon, size: 20)
                Text(choice.title).font(.appBody(16, weight: .medium))
            }
            .foregroundStyle(Color.appAccent)
            .padding(.horizontal, 18)
            .frame(minHeight: 52)
            .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.appScale)
    }

    private func loadOlderMessages(_ proxy: ScrollViewProxy) {
        Task {
            guard let anchor = await viewModel.loadOlder(userId: appState.userId) else { return }
            if let exchange = exchanges.first(where: { $0.messages.contains { $0.id == anchor } }), !exchangeIsOpen(exchange) {
                proxy.scrollTo("exchange-\(exchange.id)", anchor: .top)
            } else {
                proxy.scrollTo(anchor, anchor: .top)
            }
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

    private var isReviewPreview: Bool {
        #if DEBUG
        PreviewData.isIsolated && ProcessInfo.processInfo.environment["OXY_DEBUG_REVIEW"] != nil
        #else
        false
        #endif
    }

    private var assistantReplySettled: Bool {
        guard let last = viewModel.messages.last else { return false }
        return last.role == .assistant && !last.isStreaming && !last.content.isEmpty
            && !ReactionText.isQuiet(last.content) && ReactionText.agentReaction(last.content) == nil
    }

    var body: some View {
        NavigationStack {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                            ThreadHeader(
                                isIncognito: isIncognito,
                                isWorking: !boardModel.working.isEmpty,
                                activity: hubActivity,
                                deviceOnline: boardModel.deviceOnline,
                                isDemo: appState.isDemoSession,
                                isComposing: isInputFocused,
                                showsStatus: !showsOverview,
                                wheelOpen: $wheelOpen,
                                hubCenter: $hubCenter
                            )
                            .onChange(of: isIncognito) { _, on in
                                viewModel.incognito = on
                            }
                if !isIncognito && initialSession == nil && !startFresh && !viewModel.isViewingHistorySnapshot {
                    Picker("Adam workspace", selection: $overviewSelected) {
                        Text("Now").tag(true)
                        Text("Conversation").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, AppSpacing.chatMargin)
                    .padding(.top, 4).padding(.bottom, 4)
                }
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

                    if let networkError = viewModel.networkError, !viewModel.messages.contains(where: { $0.turnError != nil }) {
                        ErrorBanner(
                            message: networkError,
                            onRetry: {
                                if viewModel.messages.isEmpty {
                                    Task { await viewModel.loadHistory(userId: appState.userId) }
                                } else {
                                    viewModel.retryLastFailedMessage(userId: appState.userId)
                                }
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
                            VStack(spacing: 0) {
                                if showsOverview {
                                    overview
                                } else {
                                if viewModel.messages.isEmpty && boardModel.isEmpty {
                                    quietConversation
                                }
                                if viewModel.hasOlderHistory, !viewModel.messages.isEmpty, didSettleAtBottom {
                                    Color.clear
                                        .frame(height: 1)
                                        .onAppear { loadOlderMessages(proxy) }
                                }
                                ForEach(exchanges) { exchange in
                                    exchangeSection(exchange)
                                }

                                ThreadBoardCards(model: boardModel, askedInThread: askedInThread)
                                    .padding(.horizontal, AppSpacing.chatMargin)
                                    .padding(.top, boardModel.isEmpty ? 0 : 14)

                                }
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
                        .defaultScrollAnchor(showsOverview || viewModel.messages.isEmpty ? .top : .bottom)
                        .modifier(ThreadShortContentAlignment())
                        .coordinateSpace(name: "chatScroll")
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(key: ChatViewportHeightKey.self, value: geo.size.height)
                            }
                        )
                        .onPreferenceChange(ChatViewportHeightKey.self) { height in
                            let resized = scrollViewportHeight != height
                            scrollViewportHeight = height
                            if !showsOverview, resized, didSettleAtBottom, isScrollPinnedToBottom {
                                Task { @MainActor in
                                    await Task.yield()
                                    proxy.scrollTo("bottom", anchor: .bottom)
                                }
                            }
                        }
                        .onPreferenceChange(ChatBottomDistanceKey.self) { bottomY in
                            guard scrollViewportHeight > 0 else { return }
                            isScrollPinnedToBottom = bottomY <= scrollViewportHeight + 96
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            VStack(spacing: 0) {
                    if let replyingTo {
                        ReplyPreviewBar(message: replyingTo) { withAnimation(.appSpring) { self.replyingTo = nil } }
                    }

                    if isLoadingAttachment {
                        AttachmentLoadingStatus {
                            selectedPhotoItem = nil
                            isLoadingAttachment = false
                        }
                    }

                    // Input bar
                    ChatInputBar(
                        text: $viewModel.inputText,
                        isSending: isOffline,
                        isBusy: viewModel.isSending,
                        isLoadingAttachment: isLoadingAttachment,
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
                            showAttachMenu = true
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
                            .background(alignment: .bottom) {
                                ComposerBackdrop()
                            }
                        }
                        #if DEBUG
                        .task(id: "\(showsOverview)-\(boardModel.decisionErrors.count)") {
                            guard PreviewData.isIsolated, showsOverview,
                                  let focus = ProcessInfo.processInfo.environment["OXY_DEBUG_OVERVIEW_FOCUS"] else { return }
                            try? await Task.sleep(for: .seconds(1))
                            guard !Task.isCancelled else { return }
                            if focus == "decision", let first = boardModel.needsYou.first {
                                proxy.scrollTo("board-decision-\(first.id)", anchor: .bottom)
                            } else if focus == "context" {
                                proxy.scrollTo("overview-context", anchor: .bottom)
                            } else if focus == "updates" {
                                proxy.scrollTo("board-updates", anchor: .top)
                            } else if focus == "work" {
                                proxy.scrollTo("board-work", anchor: .top)
                            } else if focus == "work-bottom", let last = boardModel.working.last {
                                proxy.scrollTo("board-work-\(last.id)", anchor: .bottom)
                            } else if focus == "outcomes" {
                                proxy.scrollTo("board-outcomes", anchor: .top)
                            } else if focus == "outcome-bottom", let last = boardModel.finished.last {
                                proxy.scrollTo("board-outcome-\(last.id)", anchor: .bottom)
                            }
                        }
                        #endif
                        #if DEBUG
                        .task(id: showsOverview) {
                            guard PreviewData.isIsolated, !showsOverview,
                                  let focus = ProcessInfo.processInfo.environment["OXY_DEBUG_CONVERSATION_FOCUS"] else { return }
                            try? await Task.sleep(for: .seconds(1))
                            guard !Task.isCancelled else { return }
                            if focus == "request", let first = exchanges.first {
                                proxy.scrollTo("exchange-\(first.id)", anchor: .top)
                            } else if focus == "results",
                                      let message = viewModel.messages.first(where: { $0.actions.contains { !($0.results ?? []).isEmpty } }),
                                      let first = message.actions.compactMap(\.results).first?.first {
                                proxy.scrollTo("result-option-\(message.id)-\(first.id)", anchor: .top)
                            }
                        }
                        #endif
                        .onChange(of: overviewSelected) { _, selected in
                            if selected { isInputFocused = false }
                            Task { @MainActor in
                                await Task.yield()
                                proxy.scrollTo(selected ? "overview" : "bottom", anchor: selected ? .top : .bottom)
                                if !selected && !viewModel.messages.isEmpty { didSettleAtBottom = true }
                            }
                        }
                        .onChange(of: viewModel.isSending) { _, sending in
                            if sending { overviewSelected = false }
                        }
                        .onChange(of: isInputFocused) { _, focused in
                            if focused { overviewSelected = false }
                        }
                        .onChange(of: viewModel.messages.count) {
                            ReactionStore.shared.migrate(with: viewModel.messages)
                            guard !showsOverview else { return }
                            if !didSettleAtBottom, !viewModel.messages.isEmpty, viewModel.scrollTargetMessageID == nil {
                                // First load: jump to the newest message, with no animation, and again once rows have measured.
                                proxy.scrollTo("bottom", anchor: .bottom)
                                Task { @MainActor in
                                    try? await Task.sleep(for: .milliseconds(250))
                                    proxy.scrollTo("bottom", anchor: .bottom)
                                    didSettleAtBottom = true
                                }
                                return
                            }
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            guard isScrollPinnedToBottom else { return }
                            withAnimation(.appSpring) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                        .onChange(of: viewModel.inputText) {
                            guard !showsOverview, isScrollPinnedToBottom else { return }
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(100))
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                        .onChange(of: viewModel.messages.last?.content) {
                            guard !showsOverview else { return }
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            guard isScrollPinnedToBottom else { return }
                            withAnimation(.appSpring) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                        .onChange(of: viewModel.scrollTargetMessageID) { _, targetID in
                            guard let targetID else { return }
                            overviewSelected = false
                            if let exchange = exchanges.first(where: { $0.messages.contains { $0.id == targetID } }) {
                                expandedExchanges.insert(exchange.id)
                            }
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
                }

            }
            .toolbar(.hidden, for: .navigationBar)
            #if DEBUG
            .onAppear {
                if PreviewData.isIsolated, let review = ProcessInfo.processInfo.environment["OXY_DEBUG_REVIEW"] {
                    let paymentJSON = #"{"action":"transaction_authorize","success":false,"outcome":"awaiting_user","pending":true,"text":"Waiting for your yes","cardText":"Pay £54.20 to johnlewis.com with your Visa ending 4242.","actionSummary":"Place the order","subject":{"name":"Wireless headphones","amount":"£54.20","merchant":"johnlewis.com","card":"Visa ending 4242","options":["Standard delivery · Thursday"]}}"#
                    let emailJSON = #"{"action":"send_email","success":false,"outcome":"awaiting_user","pending":true,"cardText":"Recipient: alex@example.com\nSubject: Order update\n\nBody: The supplier quoted £50. Please send the revised delivery date.","actionSummary":"Send order update"}"#
                    pendingReviewAction = try? JSONDecoder().decode(ActionResult.self, from: Data((review == "email" ? emailJSON : paymentJSON).utf8))
                }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_RECORDING"] == "1" {
                    voiceInput.isRecording = true
                    voiceInput.transcript = "Remind me to call the dentist tomorrow morning"
                }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_TRANSCRIBING"] == "1" {
                    voiceInput.isTranscribing = true
                }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_VOICE_ERROR"] == "1" {
                    voiceErrorMessage = "Microphone access is off. Enable it in Settings to use voice."
                }
            }
            #endif
            .modifier(ThreadLayers(reaction: reactionOverlay, wheel: wheelOverlay, heldID: heldMessage?.message.id, displayText: $displayText))
            .task {
                while !Task.isCancelled {
                    await boardModel.refresh()
                    #if DEBUG
                    await boardModel.checkDecisionFailurePreview()
                    #endif
                    try? await Task.sleep(for: boardModel.working.isEmpty ? .seconds(60) : .seconds(10))
                }
            }
            .task(id: boardModel.hasDecisionReadback && scenePhase == .active) {
                guard boardModel.hasDecisionReadback, scenePhase == .active else { return }
                while !Task.isCancelled && boardModel.hasDecisionReadback {
                    await boardModel.refresh()
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await boardModel.refresh() } }
            }
            .onReceive(NotificationCenter.default.publisher(for: AskAdam.sendNotification)) { note in
                guard let text = note.object as? String else { return }
                overviewSelected = false
                viewModel.inputText = text
                viewModel.sendMessage(userId: appState.userId)
            }
            .onReceive(NotificationCenter.default.publisher(for: AskAdam.notification)) { note in
                guard let text = note.object as? String else { return }
                overviewSelected = false
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
                        if !isReviewPreview { viewModel.sendCommand("confirm", userId: appState.userId) }
                    },
                    onCancel: {
                        handledReviewActionIDs.insert(action.id)
                        pendingReviewAction = nil
                        if !isReviewPreview { viewModel.sendCommand("cancel", userId: appState.userId) }
                    }
                )
                .presentationDetents([.large])
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
            .sheet(isPresented: $showAttachMenu, onDismiss: presentAttachmentSource) {
                AttachmentChooser { source in
                    nextAttachmentSource = source
                    showAttachMenu = false
                }
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
                switch result {
                case .success(let urls):
                    guard let url = urls.first else { return }
                    let didAccess = url.startAccessingSecurityScopedResource()
                    defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
                    stageFile(at: url, name: url.lastPathComponent, mime: mimeType(for: url))
                case .failure(let error):
                    if (error as NSError).code != NSUserCancelledError {
                        attachmentError = "The file couldn't be opened. Choose it again."
                    }
                }
            }
            .task(id: selectedPhotoItem) {
                guard let item = selectedPhotoItem else {
                    isLoadingAttachment = false
                    return
                }
                isLoadingAttachment = true
                defer {
                    if selectedPhotoItem == item {
                        selectedPhotoItem = nil
                        isLoadingAttachment = false
                    }
                }
                do {
                    if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                            throw CocoaError(.fileReadUnknown)
                        }
                        guard !Task.isCancelled else {
                            try? FileManager.default.removeItem(at: movie.url)
                            return
                        }
                        stageFile(at: movie.url, name: "Video.\(movie.url.pathExtension.isEmpty ? "mov" : movie.url.pathExtension)",
                                  mime: mimeType(for: movie.url), deleteAfter: true)
                    } else {
                        guard let data = try await item.loadTransferable(type: Data.self) else {
                            throw CocoaError(.fileReadUnknown)
                        }
                        guard !Task.isCancelled else { return }
                        let mime = item.supportedContentTypes.first(where: { $0.conforms(to: .image) })?.preferredMIMEType ?? "image/jpeg"
                        stageAttachment(data: data, name: "Photo", mime: mime)
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    attachmentError = "The photo or video couldn't be loaded. Choose it again."
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
                overviewSelected = false
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
            #if DEBUG
            if appState.isDemoSession, let flow = ProcessInfo.processInfo.environment["OXY_DEBUG_FLOW"],
               let messages = PreviewData.threadMessages(for: flow) {
                viewModel.prepareUIPreview(messages: messages, flow: flow)
                overviewSelected = ProcessInfo.processInfo.environment["OXY_DEBUG_OVERVIEW"] == "1"
            }
            if let draft = ProcessInfo.processInfo.environment["OXY_DEBUG_DRAFT"] {
                viewModel.inputText = draft
                isInputFocused = true
            }
            if ProcessInfo.processInfo.environment["OXY_DEBUG_ATTACHMENT"] == "file" {
                pendingImageData = Data("Local UI review fixture.".utf8)
                pendingImageName = "UI review.txt"
                pendingImageMimeType = "text/plain"
                pendingIsImage = false
            }
            if PreviewData.isIsolated {
                switch ProcessInfo.processInfo.environment["OXY_DEBUG_ATTACHMENT"] {
                case "menu": showAttachMenu = true
                case "photos": showPhotoPicker = true
                case "files": showFileImporter = true
                case "camera": openCamera()
                case "unreadable":
                    stageFile(at: FileManager.default.temporaryDirectory.appendingPathComponent("missing-ui-review.txt"),
                              name: "UI review.txt", mime: "text/plain")
                case "oversize":
                    stageAttachment(data: Data(count: Self.attachmentLimit + 1), name: "UI review.txt", mime: "text/plain")
                case "loading": isLoadingAttachment = true
                case "retry-failure": await viewModel.checkAttachmentRetryPreview(userId: appState.userId)
                default: break
                }
            }
            #endif

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

    // MARK: - Attachments

    /// Present the system picker only after the source chooser has dismissed.
    private func presentAttachmentSource() {
        guard let source = nextAttachmentSource else { return }
        nextAttachmentSource = nil
        switch source {
        case .camera: openCamera()
        case .photos: showPhotoPicker = true
        case .files: showFileImporter = true
        }
    }

    private struct AttachmentLoadingStatus: View {
        @Environment(\.dynamicTypeSize) private var typeSize
        let cancel: () -> Void

        var body: some View {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 12))
            layout {
                HStack(spacing: 12) {
                    ProgressView().tint(Color.appAccent)
                    Text("Loading attachment")
                        .font(.body)
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Cancel", action: cancel)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.appAccent)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minHeight: 44)
            }
            .padding(.horizontal, AppSpacing.chatMargin)
            .accessibilityElement(children: .contain)
        }
    }

    private struct AttachmentChooser: View {
        @Environment(\.dismiss) private var dismiss
        @Environment(\.dynamicTypeSize) private var typeSize
        @Environment(AppState.self) private var appState
        let select: (AttachmentSource) -> Void

        var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Add attachment")
                            .font(.title2.bold())
                            .foregroundStyle(Color.appInk)
                            .accessibilityAddTraits(.isHeader)
                        if appState.isDemoSession {
                            Text("Sample").font(.caption).foregroundStyle(Color.appMuted)
                        }
                    }
                    VStack(spacing: 0) {
                        sourceRow("Photos and videos", icon: "photo", source: .photos)
                        Divider().overlay(Color.appHairline)
                        sourceRow("Camera", icon: "camera", source: .camera)
                        Divider().overlay(Color.appHairline)
                        sourceRow("Files", icon: "doc", source: .files)
                    }
                    .background(Color.appSurface, in: RoundedRectangle(cornerRadius: 16))
                }
                .padding(AppSpacing.margin)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button("Cancel") { dismiss() }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.appAccent)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.vertical, 12)
                    .background(Color.appBackground)
            }
            .background(Color.appBackground)
            .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
            .presentationDragIndicator(.visible)
        }

        private func sourceRow(_ title: String, icon: String, source: AttachmentSource) -> some View {
            Button { select(source) } label: {
                HStack(spacing: 16) {
                    AppIcon(icon, size: 24)
                        .foregroundStyle(Color.appAccent)
                        .frame(width: 32)
                    Text(title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    AppIcon("chevron-right", size: 14)
                        .foregroundStyle(Color.appMuted)
                }
                .padding(16)
                .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.appScale)
        }
    }

    /// Send a spoken transcript once.
    private func injectVoiceMessage(_ rawText: String) {
        overviewSelected = false
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        viewModel.inputText = text
        viewModel.sendMessage(userId: appState.userId)
    }

    private func submitVoiceTranscriptIfReady() {
        let text = voiceInput.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !voiceInput.isRecording, !voiceInput.isTranscribing else { return }
        voiceInput.transcript = ""
        voiceErrorMessage = nil
        viewModel.inputText = text
        viewModel.sendMessage(userId: appState.userId)
    }

    private func sendCurrentDraft() {
        overviewSelected = false
        guard !isLoadingAttachment else { return }
        // Attachment uploads cannot be queued by the text-only turn queue.
        guard pendingImageData == nil || !viewModel.isSending else { return }
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
        guard let data = try? Data(contentsOf: url) else {
            attachmentError = "The file couldn't be read. Choose it again."
            return
        }
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

/// A solid dock keeps the last reply readable above the input controls.
private struct ComposerBackdrop: View {
    var body: some View {
        Color.appBackground
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.appHairline).frame(height: 0.5)
            }
            .allowsHitTesting(false)
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

    /// The capability identifies the consequence. Prices in an email or event do not.
    private var isPayment: Bool {
        action.action == "transaction_authorize"
    }

    private var title: String {
        if isPayment {
            return action.actionSummary ?? "Review payment"
        }
        return action.actionSummary ?? {
            switch action.action {
            case "send_email", "send_outlook_email": return "Email ready to send"
            case "send_message", "send_telegram": return "Message ready to send"
            case "make_call": return "Call ready to make"
            case "create_calendar_event": return "Calendar event ready"
            default: return "Review action"
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
        if isPayment { return "Confirm payment" }
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

    private var detailRepeatsReceipt: Bool {
        guard let purchase, let amount = purchase.amount, let merchant = purchase.merchant, let card = purchase.card else { return false }
        let receipt = "Pay \(amount) to \(merchant) with your \(card)."
        return detail.caseInsensitiveCompare(receipt) == .orderedSame
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack {
                    AppIcon(reviewIcon, size: 26)
                        .foregroundStyle(Color.appAccent)
                        .frame(width: 60, height: 60)
                        .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 18))
                    Spacer()
                    #if DEBUG
                    if PreviewData.isActive {
                        Text("Sample")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Color.appMuted)
                    }
                    #endif
                }
                Text(title)
                    .font(.appRounded(32, weight: .bold, relativeTo: .largeTitle))
                    .tracking(-0.7)
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)

                if let purchase {
                    purchaseReceipt(purchase)
                }
                if !detailRepeatsReceipt {
                    Text(detail)
                        .font(.appBody(17))
                        .foregroundStyle(Color.appMuted)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 26)
            .padding(.top, 32)
            .padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                Button(action: onConfirm) {
                    Text(confirmLabel)
                        .font(.appBody(17, weight: .semibold))
                        .foregroundStyle(Color.appOnAction)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .padding(.vertical, 4)
                        .background(Color.appAction, in: RoundedRectangle(cornerRadius: 18))
                }
                .buttonStyle(.appScale)
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.appBody(17, weight: .medium))
                        .foregroundStyle(Color.appMuted)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.appScale)
            }
            .padding(.horizontal, 26)
            .padding(.top, 14)
            .padding(.bottom, 12)
            .background(Color.appBackground)
        }
        .background(Color.appBackground)
    }

    /// The amount large, then the shop and the card, so the person sees exactly what they are approving.
    private func purchaseReceipt(_ purchase: ResultSubject) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if let name = purchase.name, !name.isEmpty {
                Text(name)
                    .font(.appBody(20, weight: .medium))
                    .foregroundStyle(Color.appInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let amount = purchase.amount {
                Text(amount)
                    .font(.appRounded(44, weight: .semibold, relativeTo: .largeTitle))
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
            if let options = purchase.options {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Text(option)
                        .font(.appBody(16))
                        .foregroundStyle(Color.appMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func cleanDetail(_ raw: String) -> String {
        raw.strippingMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var reviewIcon: String {
        if isPayment { return "card" }
        switch action.action {
        case "send_email", "send_outlook_email": return "envelope"
        case "send_message", "send_telegram": return "chat"
        case "make_call": return "phone"
        case "create_calendar_event": return "calendar"
        default: return "check-circle"
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
    var isLoadingAttachment: Bool = false
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

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
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Button(action: onRemoveAttachment) {
                        AppIcon(sf: "xmark.circle.fill", size: 17)
                            .foregroundStyle(Color.appMuted)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel("Remove attachment")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.appSurface)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous).strokeBorder(Color.appHairline, lineWidth: 0.5))
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }

            composer
                .padding(.horizontal, AppSpacing.chatMargin)
                .padding(.top, 14)
                .padding(.bottom, 12)
        }
        .onAppear { pulse = true }
    }

    /// Attachment and voice are distinct controls around the text entry.
    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if !isVoiceActive {
                Button(action: onAttach) {
                    AppIcon("plus", size: 20)
                        .foregroundStyle(Color.appInk)
                        .frame(width: 44, height: 52)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Add a photo, video or file")
                .buttonStyle(.appScale)
                .disabled(isSending || isLoadingAttachment)
            }

            HStack(alignment: .bottom, spacing: 4) {
                if isVoiceActive { voiceField } else { textField }
            }
            .padding(4)
            .background(Color.appReceivedBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(isFocused.wrappedValue || incognito ? Color.appAccent : Color.appCardOutline, lineWidth: 1)
            }
            .animation(.appFast, value: isFocused.wrappedValue)

            actionButton
        }
    }

    private var actionButton: some View {
        Button(action: showsStop ? onStop : (canSend ? onSend : onVoice)) {
            ZStack {
                if showsStop {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.appOnAction)
                        .frame(width: 12, height: 12)
                } else if isPreparingVoice && !canSend {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Color.appOnAction)
                } else {
                    AppIcon(canSend ? "arrow-up" : (isRecording ? "stop" : "mic"), size: 18)
                }
            }
            .foregroundStyle(buttonForeground)
            .frame(width: 48, height: 48)
            .background {
                if isRecording && !reduceMotion {
                    Circle()
                        .strokeBorder(Color.appAction.opacity(pulse ? 0 : 0.4), lineWidth: 2)
                        .scaleEffect(pulse ? 1.6 : 1)
                        .animation(.easeOut(duration: 1.3).repeatForever(autoreverses: false), value: pulse)
                }
                Circle().fill(buttonFill)
            }
            .frame(width: 52, height: 52)
            .contentShape(Circle())
        }
        .disabled(!canAct && !showsStop)
        .accessibilityLabel(showsStop ? "Stop" : (canSend ? "Send" : (isRecording ? "Finish recording" : "Talk to Adam")))
        .buttonStyle(ScaleButtonStyle())
        .animation(.appFast, value: canAct)
        .animation(.appFast, value: canSend)
        .animation(.appFast, value: isRecording)
    }

    private var textField: some View {
        TextField("", text: $text, prompt: Text(isSending ? "You're offline" : (incognito ? "Private message" : (typeSize.isAccessibilitySize ? "Ask" : "Ask Adam"))).foregroundStyle(Color.appMuted), axis: .vertical)
            .font(.appBody(17, weight: .regular))
            .foregroundStyle(Color.appInk)
            .tint(Color.appAccent)
            .lineLimit(1...(typeSize.isAccessibilitySize ? (attachmentLabel == nil ? 2 : 1) : 6))
            .focused(isFocused)
            .disabled(isSending)
            .opacity(isSending ? 0.72 : 1)
            .onSubmit { if canSend { onSend() } }
            .padding(.horizontal, 4)
            .padding(.vertical, 12)
            .accessibilityLabel(incognito ? "Private message" : "Ask Adam")
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

            if !isPreparingVoice {
                AdamActivityMark(state: .listening, size: 28, tint: Color.appAccent, level: voiceLevel)
            }

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
        .frame(minHeight: 46)
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
        return Color.appAction
    }

    private var buttonForeground: Color {
        if canSend || showsStop || isRecording { return Color.appOnAction }
        return canAct ? Color.appOnAction : Color.appMuted
    }

    private var canAct: Bool {
        !isSending && !isPreparingVoice && !isLoadingAttachment && !(isBusy && attachmentLabel != nil)
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

private struct ThreadExchange: Identifiable {
    let id: UUID
    var messages: [Message]
    var date: Date { messages[0].timestamp }
    var requiresAttention: Bool {
        messages.contains { $0.actions.contains(where: \.needsUser) || $0.turnError != nil }
    }
    var title: String {
        let first = messages.first(where: { $0.role == .user }) ?? messages[0]
        let attachment = AttachmentTag.splitFileTag(first.content)
        let text = ReplyQuote.split(attachment.text)?.body ?? attachment.text
        return text.isEmpty ? attachment.name ?? "Attachment" : text.replacingOccurrences(of: "\n", with: " ")
    }

    static func group(_ messages: [Message]) -> [ThreadExchange] {
        var result: [ThreadExchange] = []
        for message in messages {
            if message.role == .assistant, !result.isEmpty {
                result[result.count - 1].messages.append(message)
            } else {
                result.append(ThreadExchange(id: message.id, messages: [message]))
            }
        }
        return result
    }
}

private struct ThreadShortContentAlignment: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.top, for: .alignment)
        } else {
            content
        }
    }
}
