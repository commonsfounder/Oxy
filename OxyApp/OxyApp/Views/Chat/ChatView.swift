import MessageUI
import Network
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ChatView: View {
    var initialSession: ChatSessionSummary? = nil
    var autoSendTranscript: String? = nil
    /// Start a brand-new empty chat instead of resuming the current one.
    var startFresh: Bool = false
    /// When set, the top-left toolbar shows a sidebar/menu button instead of a back chevron.
    var onMenu: (() -> Void)? = nil

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = ChatViewModel()
    @State private var voiceInput = VoiceInputManager()
    @FocusState private var isInputFocused: Bool
    @State private var pendingReviewAction: ActionResult?
    @State private var messageDraft: MessageDraft?
    @State private var messageComposerAlert: String?
    @State private var handledReviewActionIDs = Set<String>()
    @State private var handledMessageComposeActionIDs = Set<String>()
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
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
    // Resolved from the app-wide appearance setting via the root's preferredColorScheme.
    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }
    private let networkMonitor = NWPathMonitor()

    /// True the instant the last message is a finished assistant reply — the trigger for the
    /// soft "reply landed" tick. Reads only `.last`, so it stays O(1) per render.
    private var assistantReplySettled: Bool {
        guard let last = viewModel.messages.last else { return false }
        return last.role == .assistant && !last.isStreaming && !last.content.isEmpty
    }

    var body: some View {
        NavigationStack {
        ZStack {
            // Canvas is the app-level aurora (see MainTabView) so it bleeds full-screen.
            Color.clear

            VStack(spacing: 0) {
                // Offline banner
                if isOffline {
                    HStack(spacing: 8) {
                            AppIcon(sf: "wifi.slash", size: 14)
                            Text("No internet connection")
                                .font(.system(size: 12, weight: .medium))
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
                                    .font(.system(size: 12, weight: .semibold))
                                if let label = viewModel.historySnapshotLabel {
                                    Text(label)
                                        .font(.system(size: 11))
                                }
                            }
                            Spacer()
                            Button("Current Chat") {
                                Task {
                                    await viewModel.returnToCurrentChat(userId: appState.userId)
                                }
                            }
                            .font(.system(size: 12, weight: .semibold))
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
                                ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { idx, message in
                                    let msgs = viewModel.messages
                                    let prevRole = idx > 0 ? msgs[idx - 1].role : nil
                                    let nextRole = idx < msgs.count - 1 ? msgs[idx + 1].role : nil
                                    let isGroupStart = prevRole != message.role
                                    let isGroupEnd = nextRole != message.role
                                    let nextMessage = idx < msgs.count - 1 ? msgs[idx + 1] : nil
                                    let previousMessage = idx > 0 ? msgs[idx - 1] : nil
                                    MessageBubble(
                                        message: message,
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
                                        }
                                    )
                                    .id(message.id)
                                    .padding(.top, isGroupStart && idx > 0 ? 12 : 2)
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))

                                    if message.id == viewModel.activeTurnUserMessageID,
                                       !viewModel.activitySteps.isEmpty {
                                        ActivityCard(steps: viewModel.activitySteps)
                                            .id("activity-\(message.id)")
                                            .padding(.horizontal, AppSpacing.chatMargin)
                                            .padding(.top, 6)
                                            .transition(.opacity.combined(with: .move(edge: .top)))
                                    }
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
                        .overlay {
                            if viewModel.messages.isEmpty && !viewModel.isSending {
                                WelcomeCard { prompt in
                                    viewModel.inputText = prompt
                                    sendCurrentDraft()
                                }
                                .transition(.opacity)
                            }
                        }
                        .scrollDismissesKeyboard(.interactively)
                        // The header uses glass controls, but the region itself must be
                        // opaque. Otherwise history text ghosts under the menu button while
                        // scrolling, which makes the first visible message unreadable.
                        .safeAreaInset(edge: .top, spacing: 0) {
                            AppHeaderView(
                                isIncognito: $isIncognito,
                                isEmptyChat: viewModel.messages.isEmpty,
                                onLeading: {
                                    HapticManager.shared.impact(.light)
                                    if let onMenu { onMenu() } else { dismiss() }
                                },
                                onNewChat: {
                                    HapticManager.shared.impact(.light)
                                    viewModel.startNewChat(userId: appState.userId)
                                }
                            )
                            .onChange(of: isIncognito) { _, on in
                                viewModel.incognito = on
                            }
                            // No frosted band — the header's glass buttons float on the canvas.
                        }
                        .hidesTabBarOnScroll()
                        .onChange(of: viewModel.messages.count) {
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
                        // Both helpers only inspect `.actions` on the last few messages.
                        // Keying on the action count (instead of the whole messages array)
                        // avoids an O(conversation) Equatable compare on every streamed token.
                        .onChange(of: viewModel.messages.suffix(3).reduce(0) { $0 + $1.actions.count }) {
                            presentPendingReviewIfNeeded()
                            presentMessageComposerIfNeeded()
                        }
                    }

                    // Input bar
                    ChatInputBar(
                        text: $viewModel.inputText,
                        isSending: isOffline,
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
                            HapticManager.shared.impact(.medium)
                            if voiceInput.isRecording {
                                voiceInput.stopRecording()
                            } else {
                                voiceInput.startRecording(userId: appState.userId)
                            }
                        },
                        onAttach: {
                            HapticManager.shared.impact(.light)
                            isInputFocused = false
                            withAnimation(.easeOut(duration: 0.2)) { showAttachMenu = true }
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
            // A soft tick when Millie's reply settles; a warning buzz when a request fails.
            // Lives in its own modifier so this (large) body still type-checks in time.
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
            .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhotoItem, matching: .images)
            .fileImporter(
                isPresented: $showFileImporter,
                allowedContentTypes: [.pdf, .plainText, .commaSeparatedText, .json, .image, .data],
                allowsMultipleSelection: false
            ) { result in
                guard let url = try? result.get().first else { return }
                let didAccess = url.startAccessingSecurityScopedResource()
                defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { return }
                pendingImageData = data
                pendingImageName = url.lastPathComponent
                pendingImageMimeType = mimeType(for: url)
                pendingIsImage = pendingImageMimeType.hasPrefix("image/")
            }
            .onChange(of: selectedPhotoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await MainActor.run {
                            pendingImageData = data
                            pendingImageName = "Photo"
                            pendingImageMimeType = data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? "image/png" : "image/jpeg"
                            pendingIsImage = true
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
            // Spoken input from the pendant or the "Ask Oxy" Siri intent — routed
            // into this existing chat instead of opening a second screen.
            .onReceive(NotificationCenter.default.publisher(for: .oxyVoiceMessage)) { note in
                guard let text = note.userInfo?["text"] as? String else { return }
                SiriRequestBus.shared.pendingQuery = nil
                injectVoiceMessage(text)
            }
            // Draft handoff (e.g. from a Today card) — fill the composer, don't send.
            .onReceive(NotificationCenter.default.publisher(for: .oxyDraftMessage)) { note in
                guard let text = note.userInfo?["text"] as? String else { return }
                viewModel.inputText = text
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
            if let transcript = autoSendTranscript, !transcript.isEmpty {
                injectVoiceMessage(transcript)
            }
            // Cold-launch from the Siri intent: the notification may have fired
            // before this view subscribed, so drain any pending query here.
            if let pending = SiriRequestBus.shared.take() {
                injectVoiceMessage(pending)
            }
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
            ZStack(alignment: .bottom) {
                Color.appScrim
                    .ignoresSafeArea()
                    .onTapGesture { dismissAttachMenu() }

                VStack(spacing: 0) {
                    attachSheetRow("Photo Library") {
                        dismissAttachMenu()
                        showPhotoPicker = true
                    }
                    AppDivider()
                    attachSheetRow("Files") {
                        dismissAttachMenu()
                        showFileImporter = true
                    }
                }
                .background(.regularMaterial)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                        .strokeBorder(Color.appHairline, lineWidth: 0.5)
                )
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .zIndex(20)
        }
    }

    private func attachSheetRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(Color.appInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 17)
                .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.98))
    }

    private func dismissAttachMenu() {
        withAnimation(.appFast) { showAttachMenu = false }
    }

    /// Send a spoken transcript as a message into this conversation. De-dupes
    /// against an in-flight send so an overlapping pendant + Siri trigger can't
    /// fire the same text twice.
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
            viewModel.sendMessage(userId: appState.userId)
        }
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
        guard isGroupEnd, !message.isStreaming else { return false }
        if next == nil { return true }
        if message.role == .assistant, !(message.content.isEmpty && message.actions.isEmpty) { return true }
        if let next, next.timestamp.timeIntervalSince(message.timestamp) > 5 * 60 { return true }
        if let previous, message.timestamp.timeIntervalSince(previous.timestamp) > 5 * 60 { return true }
        return false
    }
}

/// The chat's two reward haptics, isolated from the main body so its type-checking
/// cost doesn't compound the (already large) `ChatView` body expression.
private struct ChatHaptics: ViewModifier {
    let replySettled: Bool
    let failed: Bool

    func body(content: Content) -> some View {
        content
            // Was .impact(flexibility: .soft, intensity: 0.7) — read as imperceptible on
            // a real device. Medium weight at full intensity is a distinctly crisper tap.
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

private struct ActionReviewSheet: View {
    let action: ActionResult
    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var isPayment: Bool {
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
            case "send_email": return "Review email"
            case "send_message": return "Review message"
            case "send_telegram": return "Review Telegram"
            case "make_call": return "Review call"
            default: return "Review"
            }
        }()
    }

    private var subtitle: String {
        isPayment ? "This will use the saved payment method on the site." : "One tap when it looks right."
    }

    private var confirmLabel: String {
        isPayment ? "Confirm & Place Order" : "Confirm"
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
                        .font(.appTitle(20, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    Text(subtitle)
                        .font(.appBody(13))
                        .foregroundStyle(Color.appMuted)
                }
                Spacer()
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Ready for review")
                    .appEyebrow()
                    .foregroundStyle(isPayment ? Color.appAccent.opacity(0.9) : Color.appMuted)
                Text(detail)
                    .font(.appBody(15))
                    .foregroundStyle(Color.appInk)
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
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

struct SearchResult: Codable, Identifiable {
    let messageId: String?
    let role: String
    let content: String
    let createdAt: String?

    var id: String { messageId ?? ((createdAt ?? "") + role + String(content.prefix(20))) }

    init(messageId: String? = nil, role: String, content: String, createdAt: String?) {
        self.messageId = messageId
        self.role = role
        self.content = content
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case messageId = "id"
        case role, content
        case createdAt = "created_at"
    }

    var formattedDate: String? {
        let date = Date.oxyParse(createdAt)
        guard let date else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "d MMM · HH:mm"
        return fmt.string(from: date)
    }
}

struct SearchResponse: Codable {
    let results: [SearchResult]
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

    enum CodingKeys: String, CodingKey {
        case id, title, preview
        case startedAt = "started_at"
        case lastAt = "last_at"
        case messageCount = "message_count"
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

struct ChatSessionsResponse: Codable {
    let sessions: [ChatSessionSummary]
}

// MARK: - Welcome Card

/// Full-screen welcome. Calm, personal, and ready for future dynamic suggestions.
private struct WelcomeCard: View {
    var onAction: (String) -> Void
    @State private var appeared = false
    @AppStorage("oxy_starter_actions") private var storedActions = "What needs attention today?\nSummarise my inbox\nCheck my calendar"

    private static let pool: [(icon: String, label: String)] = [
        ("sparkle.magnifyingglass", "What needs attention today?"),
        ("envelope", "Summarise my inbox"),
        ("calendar", "Check my calendar"),
        ("magnifyingglass", "Find something for me"),
        ("envelope", "Send an email"),
        ("magnifyingglass", "Search the web"),
        ("calendar", "Add to my calendar"),
        ("message", "Send a message"),
        ("bell", "Set a reminder")
    ]

    private var actions: [String] {
        let allowed = Set(Self.pool.map(\.label))
        let parts = storedActions.split(separator: "\n").map(String.init).filter { allowed.contains($0) }
        return parts.isEmpty ? Array(Self.pool.prefix(3).map(\.label)) : parts
    }

    private func icon(for label: String) -> String {
        Self.pool.first { $0.label == label }?.icon ?? "sparkles"
    }

    private func replace(slot: Int, with label: String) {
        var parts = actions
        guard slot < parts.count else { return }
        parts[slot] = label
        storedActions = parts.joined(separator: "\n")
        HapticManager.shared.impact(.light)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                BrandWordmark(height: 15, color: Color.appMuted)
                    .padding(.bottom, 26)
                    .opacity(appeared ? 1 : 0)
                    .animation(.appSpring.delay(0.06), value: appeared)

                Text(greeting)
                    .font(.appEditorial(31))
                    .appHeroTracking(31)
                    .foregroundStyle(Color.appInk)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .appEntrance(appeared, riseOffset: 18, delay: 0.1)
            }
            .padding(.horizontal, 24)
            .padding(.top, 58)

            Spacer()

            VStack(alignment: .leading, spacing: 12) {
                Text("Suggestions")
                    .font(.appBody(11, weight: .medium))
                    .tracking(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.appMuted)
                    .padding(.horizontal, 24)

                ForEach(Array(actions.enumerated()), id: \.offset) { index, label in
                    Button { onAction(label) } label: {
                        HStack(spacing: 14) {
                            AppIcon(sf: icon(for: label), size: 15)
                                .foregroundStyle(Color.appMuted)
                                .frame(width: 18, alignment: .center)
                            Text(label)
                                .font(.appBody(15.5, weight: .medium))
                                .foregroundStyle(Color.appInk)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            AppIcon(sf: "arrow.up.right", size: 11)
                                .foregroundStyle(Color.appMuted.opacity(0.5))
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 15)
                        .contentShape(Rectangle())
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(Color.appHairline).frame(height: 0.5)
                        }
                    }
                    .buttonStyle(.appScale(0.97))
                    .appEntrance(appeared, riseOffset: 10, delay: 0.22 + Double(index) * 0.07)
                    .contextMenu {
                        ForEach(Self.pool.filter { !actions.contains($0.label) }, id: \.label) { option in
                            Button { replace(slot: index, with: option.label) } label: {
                                Label { Text(option.label) } icon: { AppIcon(sf: option.icon, size: 16) }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .onAppear { withAnimation { appeared = true } }
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning."
        case 12..<17: return "Good afternoon."
        default: return "Good evening."
        }
    }
}

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
            // Attachment strip
            if let attachmentLabel {
                HStack(spacing: 10) {
                    if attachmentIsImage, let attachmentData, let uiImage = UIImage(data: attachmentData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 38, height: 38)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            // A hairline edge so the photo reads as a crisp object, not a
                            // torn-out scrap. Color.primary is pure-ish black in light /
                            // white in dark — never a tinted neutral that reads as dirt.
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
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.appInk)
                            .lineLimit(1)
                        Text(attachmentIsImage ? "Ready for analysis" : "Ready to read")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.appMuted)
                    }
                    Spacer()
                    Button(action: onRemoveAttachment) {
                        AppIcon(sf: "xmark.circle.fill", size: 17)
                            .foregroundStyle(Color.appMuted)
                            // Glyph stays 16pt; the tap target grows to the 40×40 minimum.
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
                // Attach
                Button(action: onAttach) {
                    AppIcon(sf: "plus", size: 19)
                        .foregroundStyle(isVoiceActive ? Color.appMuted.opacity(0.45) : Color.appMuted)
                        .frame(width: 34, height: 34)
                        .appGlass(Circle(), interactive: true)
                }
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

                // Send / voice
                Button(action: canSend ? onSend : onVoice) {
                    ZStack {
                        if isPreparingVoice && !canSend {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color.appMuted)
                        } else {
                            AppIcon(sf: canSend ? "arrow.up" : (isRecording ? "stop.fill" : "mic.fill"), size: 15)
                        }
                    }
                    // A filled circle when there's something to act on (send or stop
                    // recording); a quiet bordered outline for the idle mic — no
                    // reliance on the (now no-op) glass effect for legibility.
                    .foregroundStyle(buttonForeground)
                    .frame(width: 34, height: 34)
                    .contentShape(Circle())
                    .background {
                        Circle().fill(buttonFill)
                        if !canSend && !isRecording {
                            Circle().strokeBorder(Color.appHairline, lineWidth: 0.5)
                        }
                    }
                }
                .disabled(!canAct)
                .buttonStyle(ScaleButtonStyle())
                .animation(.appFast, value: canAct)
                .animation(.appFast, value: canSend)
                .animation(.appFast, value: isRecording)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 8)
            // No frosted band — the field pill floats on the canvas like ChatGPT's composer.
        }
        .onAppear { pulse = true }
    }

    private var textField: some View {
        TextField(incognito ? "Private — not saved" : "Ask Milgrain", text: $text, axis: .vertical)
            .font(.system(size: 14.5, weight: .regular))
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
        HStack(spacing: 10) {
            Button(action: onCancelVoice) {
                AppIcon(sf: "xmark", size: 13)
                    .foregroundStyle(Color.appMuted)
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
            .buttonStyle(.appScale)

            Circle()
                .fill(isPreparingVoice ? Color.appMuted : Color.appDanger)
                .frame(width: 7, height: 7)
                .scaleEffect(pulse && isRecording ? 1.2 : 0.85)
                .opacity(isPreparingVoice ? 0.65 : 1)
                .animation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true), value: pulse)

            VStack(alignment: .leading, spacing: 1) {
                Text(isPreparingVoice ? "Transcribing" : "Listening")
                    .font(.appBody(13, weight: .medium))
                    .foregroundStyle(Color.appInk)
                if !voiceTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isPreparingVoice {
                    Text(voiceTranscript)
                        .font(.appBody(12))
                        .foregroundStyle(Color.appMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.xl, style: .continuous)
                .strokeBorder(isRecording ? Color.appDanger.opacity(0.22) : Color.appHairline, lineWidth: 0.75)
        )
    }

    private var canSend: Bool {
        Self.canSendDraft(text: text, attachmentLabel: attachmentLabel, isOffline: isSending)
    }

    private var isVoiceActive: Bool {
        isRecording || isPreparingVoice
    }

    private var buttonFill: Color {
        if canSend { return Color.appAccent }
        if isRecording { return Color.appDanger }
        return Color.appSurface
    }

    private var buttonForeground: Color {
        if canSend { return Color.appOnAccent }
        if isRecording { return Color.appInk }
        return canAct ? Color.appMuted : Color.appMuted.opacity(0.5)
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

private struct ActivityCard: View {
    let steps: [ActivityStep]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    private var visibleSteps: [ActivityStep] {
        guard !steps.isEmpty else { return [] }
        let activeIndex = steps.firstIndex { $0.state == .active || $0.state == .failed }
            ?? steps.firstIndex { $0.state == .pending }
            ?? steps.indices.last
        guard let activeIndex else { return [] }
        var indices = Set<Int>()
        if activeIndex > 0 { indices.insert(activeIndex - 1) }
        indices.insert(activeIndex)
        if activeIndex + 1 < steps.count { indices.insert(activeIndex + 1) }
        return indices.sorted().map { steps[$0] }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(visibleSteps) { step in
                ActivityStepRow(step: step, pulse: pulse && !reduceMotion)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface.opacity(0.62))
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                .strokeBorder(Color.appHairline, lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .animation(.appStandard, value: steps)
        .onAppear { pulse = true }
    }

    private var accessibilityLabel: String {
        visibleSteps.map { "\($0.title), \($0.state.rawValue)" }.joined(separator: ". ")
    }
}

private struct ActivityStepRow: View {
    let step: ActivityStep
    let pulse: Bool

    private var isDimmed: Bool {
        step.state == .complete || step.state == .pending
    }

    var body: some View {
        HStack(spacing: 9) {
            glyph
                .frame(width: 14, height: 16)
            Text(step.title)
                .font(.appBody(step.state == .active ? 13 : 12.5, weight: step.state == .active ? .medium : .regular))
                .foregroundStyle(Color.appMuted.opacity(isDimmed ? 0.62 : 0.96))
                .lineLimit(1)
                .contentTransition(.opacity)
            Spacer(minLength: 24)
        }
        .opacity(step.state == .pending ? 0.58 : 1)
    }

    @ViewBuilder
    private var glyph: some View {
        switch step.state {
        case .pending:
            Circle()
                .strokeBorder(Color.appMuted.opacity(0.4), lineWidth: 1)
                .frame(width: 7, height: 7)
        case .active:
            Circle()
                .fill(Color.appAccent.opacity(0.86))
                .frame(width: 7, height: 7)
                .scaleEffect(pulse ? 1.18 : 0.9)
                .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
        case .complete:
            AppIcon(sf: "checkmark", size: 11)
                .foregroundStyle(Color.appMuted.opacity(0.7))
        case .failed:
            AppIcon(sf: "exclamationmark", size: 11)
                .foregroundStyle(Color.appDanger)
        }
    }
}

// MARK: - Pendant Floating Overlay

struct PendantOverlay: View {
    let state: PendantAudioBridge.BridgeState
    let transcript: String?
    var notice: String? = nil

    var body: some View {
        HStack(spacing: 11) {
            if let notice {
                AppIcon(sf: "exclamationmark.circle.fill", size: 15)
                    .foregroundStyle(Color.appWarning)
                Text(notice)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            } else if state == .listening {
                PendantWaveform(active: true)
                Text("Listening")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                if let t = transcript, !t.isEmpty {
                    Text("·").foregroundStyle(.tertiary)
                    Text(t)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .animation(.appFast, value: t)
                }
            } else {
                AppIcon(sf: "waveform", size: 15)
                    .foregroundStyle(.secondary)
                    .symbolEffect(.variableColor.iterative, isActive: true)
                if let t = transcript, !t.isEmpty {
                    Text(t)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.appInk)
                        .lineLimit(1)
                } else {
                    Text("Transcribing…")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.appMuted)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .appGlass(Capsule())
        .animation(.appFast, value: state)
    }
}

struct PendantWaveform: View {
    let active: Bool

    var body: some View {
        HStack(spacing: 3) {
            WaveBar(maxH: 6,  dur: 0.55, delay: 0.00, active: active)
            WaveBar(maxH: 13, dur: 0.42, delay: 0.12, active: active)
            WaveBar(maxH: 19, dur: 0.50, delay: 0.24, active: active)
            WaveBar(maxH: 13, dur: 0.42, delay: 0.12, active: active)
            WaveBar(maxH: 6,  dur: 0.55, delay: 0.00, active: active)
        }
        .frame(height: 22)
    }

    private struct WaveBar: View {
        let maxH: CGFloat
        let dur: Double
        let delay: Double
        let active: Bool
        @State private var on = false

        var body: some View {
            Capsule()
                .fill(Color.appMuted)
                .frame(width: 3, height: on ? maxH : 3)
                .animation(
                    active
                        ? .easeInOut(duration: dur).repeatForever(autoreverses: true).delay(delay)
                        : .appFast,
                    value: on
                )
                .onAppear { if active { on = true } }
                .onChange(of: active) { _, a in on = a }
        }
    }
}

#Preview {
    ChatView()
        .environment(AppState())
        .environment(TabBarVisibility())
}
