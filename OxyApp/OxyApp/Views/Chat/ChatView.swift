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
                            Image(systemName: "wifi.slash")
                                .font(.system(size: 12, weight: .semibold))
                            Text("No internet connection")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(Color.nmlAttention)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }

                    if viewModel.isViewingHistorySnapshot {
                        HStack(spacing: 10) {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.system(size: 12, weight: .semibold))
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
                        .foregroundStyle(Color.nmlTitanium)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color.nmlTitanium.opacity(0.1))
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
                                    MessageBubble(
                                        message: message,
                                        showsTypingIndicator: viewModel.statusLabel == nil,
                                        isGroupStart: isGroupStart,
                                        isGroupEnd: isGroupEnd,
                                        onActionCommand: { command in
                                            viewModel.sendCommand(command, userId: appState.userId)
                                        },
                                        onOpenAction: { action in
                                            handleActionOpen(action)
                                        }
                                    )
                                    .id(message.id)
                                    .padding(.top, isGroupStart && idx > 0 ? 12 : 2)
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                                }

                                if let status = viewModel.statusLabel {
                                    StatusIndicator(label: status)
                                        .id("status")
                                        .padding(.horizontal, 16)
                                        .padding(.top, 4)
                                }
                            }
                            .padding(.vertical, 12)
                            .animation(.nmlSpring, value: viewModel.messages.count)
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
                            withAnimation(.nmlSpring) {
                                if let lastId = viewModel.messages.last?.id {
                                    proxy.scrollTo(lastId, anchor: .bottom)
                                } else {
                                    proxy.scrollTo("status", anchor: .bottom)
                                }
                            }
                        }
                        .onChange(of: viewModel.messages.last?.content) {
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            withAnimation(.nmlSpring) {
                                if let lastId = viewModel.messages.last?.id {
                                    proxy.scrollTo(lastId, anchor: .bottom)
                                } else {
                                    proxy.scrollTo("status", anchor: .bottom)
                                }
                            }
                        }
                        .onChange(of: viewModel.scrollTargetMessageID) { _, targetID in
                            guard let targetID else { return }
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(150))
                                withAnimation(.nmlStandard) {
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

                    // Voice recording overlay
                    if voiceInput.isRecording || voiceInput.isTranscribing {
                        VoiceRecordingBar(
                            transcript: voiceInput.isTranscribing ? nil : voiceInput.transcript,
                            isTranscribing: voiceInput.isTranscribing,
                            onStop: {
                                if !voiceInput.isTranscribing { voiceInput.stopRecording() }
                            },
                            onCancel: {
                                voiceInput.cancel()
                            }
                        )
                    }

                    // Input bar
                    ChatInputBar(
                        text: $viewModel.inputText,
                        isSending: viewModel.isSending || isOffline,
                        isRecording: voiceInput.isRecording,
                        isPreparingVoice: voiceInput.isTranscribing,
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
                // Modal sheet stays dark in both finishes (its surface is fixed obsidian).
                .preferredColorScheme(.dark)
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
                let text = voiceInput.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                voiceInput.transcript = ""
                guard !text.isEmpty else { return }
                viewModel.inputText = text
                viewModel.sendMessage(userId: appState.userId)
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
        }
        .onAppear {
            viewModel.requestLocationAccess()
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
                Color.nmlFillScrim
                    .ignoresSafeArea()
                    .onTapGesture { dismissAttachMenu() }

                VStack(spacing: 0) {
                    attachSheetRow("Photo Library") {
                        dismissAttachMenu()
                        showPhotoPicker = true
                    }
                    NamelessDivider()
                    attachSheetRow("Files") {
                        dismissAttachMenu()
                        showFileImporter = true
                    }
                }
                .background(.regularMaterial)
                .clipShape(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous)
                        .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
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
                .foregroundStyle(Color.nmlInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 17)
                .contentShape(Rectangle())
        }
        .buttonStyle(.nmlScale(0.98))
    }

    private func dismissAttachMenu() {
        withAnimation(.nmlFast) { showAttachMenu = false }
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
}

/// The chat's two reward haptics, isolated from the main body so its type-checking
/// cost doesn't compound the (already large) `ChatView` body expression.
private struct ChatHaptics: ViewModifier {
    let replySettled: Bool
    let failed: Bool

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(trigger: replySettled) { _, settled in
                settled ? .impact(flexibility: .soft, intensity: 0.7) : nil
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

    private var title: String {
        action.actionSummary ?? {
            switch action.action {
            case "send_email": return "Review email"
            case "send_message": return "Review message"
            case "send_telegram": return "Review Telegram"
            case "make_call": return "Review call"
            default: return "Review action"
            }
        }()
    }

    private var detail: String {
        action.cardText ?? action.text ?? "Ready for review."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Capsule()
                .fill(Color.nmlHairline)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)

            HStack(spacing: 12) {
                Image(systemName: iconName)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.nmlTitanium)
                    .frame(width: 34, height: 34)
                    .nmlGlass(Circle(), tint: Color.nmlTitanium)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Color.nmlInk)
                    Text("One tap when it looks right.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.nmlMuted)
                }
                Spacer()
            }

            Text(detail)
                .font(.system(size: 15))
                .foregroundStyle(Color.nmlInk)
                .lineSpacing(5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color.nmlSurface.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.nmlHairline, lineWidth: 0.5)
                )

            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Label("Cancel", systemImage: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.nmlScale)
                .foregroundStyle(Color.nmlMuted)
                .background(Color.nmlSurface2)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                Button(action: onConfirm) {
                    Label("Send", systemImage: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.nmlScale)
                .foregroundStyle(Color.nmlObsidian)
                .background(Color.nmlTitanium)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.nmlObsidian)
    }

    private var iconName: String {
        switch action.action {
        case "send_email": return "envelope.fill"
        case "send_message": return "message.fill"
        case "send_telegram": return "paperplane.fill"
        case "make_call": return "phone.fill"
        default: return "checkmark.seal.fill"
        }
    }
}

// MARK: - Voice Recording Bar

private struct VoiceRecordingBar: View {
    let transcript: String?
    let isTranscribing: Bool
    let onStop: () -> Void
    let onCancel: () -> Void

    @State private var pulse = false

    var body: some View {
        VStack(spacing: 8) {
            Divider().overlay(Color.nmlHairline)

            HStack(spacing: 12) {
                Button(action: onCancel) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(Color.nmlMuted)
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(isTranscribing ? Color.nmlTitanium : Color.nmlDanger)
                            .frame(width: 8, height: 8)
                            .scaleEffect(pulse ? 1.2 : 0.8)
                            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: pulse)
                        Text(isTranscribing ? "Transcribing…" : "Listening...")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.nmlInk)
                    }
                    if let t = transcript, !t.isEmpty {
                        Text(t)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.nmlMuted)
                            .lineLimit(2)
                    }
                }

                Spacer()

                if !isTranscribing {
                    Button(action: onStop) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.nmlObsidian)
                            .frame(width: 36, height: 36)
                            .nmlGlass(Circle(), tint: Color.nmlTitanium, interactive: true)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.ultraThinMaterial)
        .onAppear { pulse = true }
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

/// Full-screen editorial welcome state. Fraunces title in the upper portion,
/// hairline-separated action rows in the lower portion. Silent luxury: generous
/// space, no fills, nothing decorated.
private struct WelcomeCard: View {
    var onAction: (String) -> Void
    @State private var appeared = false
    @AppStorage("oxy_starter_actions") private var storedActions = "Send an email\nPlay some music\nBook a ride"

    private static let pool: [(icon: String, label: String)] = [
        ("envelope", "Send an email"),
        ("music.note", "Play some music"),
        ("car", "Book a ride"),
        ("magnifyingglass", "Search the web"),
        ("calendar", "Add to my calendar"),
        ("cloud.sun", "What's the weather"),
        ("message", "Send a message"),
        ("map", "Get directions"),
        ("bell", "Set a reminder")
    ]

    private var actions: [String] {
        let parts = storedActions.split(separator: "\n").map(String.init)
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
            // ── Editorial title ─────────────────────────────────────────────
            VStack(alignment: .leading, spacing: 20) {
                BrandWordmark(height: 11)
                    .opacity(appeared ? 0.55 : 0)
                    .animation(.nmlRelax.delay(0.06), value: appeared)

                Text("Where should\nwe begin?")
                    .font(.nmlDisplay(42, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                    .lineSpacing(8)
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 18)
                    .animation(.nmlSpring.delay(0.1), value: appeared)
            }
            .padding(.horizontal, 24)
            .padding(.top, 52)

            Spacer()

            // ── Action rows ─────────────────────────────────────────────────
            VStack(alignment: .leading, spacing: 0) {
                Rectangle()
                    .fill(Color.nmlHairline)
                    .frame(height: 0.5)
                    .opacity(appeared ? 1 : 0)
                    .animation(.nmlSpring.delay(0.18), value: appeared)

                ForEach(Array(actions.enumerated()), id: \.offset) { index, label in
                    Button { onAction(label) } label: {
                        HStack(spacing: 14) {
                            Image(systemName: icon(for: label))
                                .font(.system(size: 14, weight: .ultraLight))
                                .foregroundStyle(Color.nmlMuted.opacity(0.5))
                                .frame(width: 18, alignment: .center)
                            Text(label)
                                .font(.nmlBody(16, weight: .light))
                                .foregroundStyle(Color.nmlMuted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9, weight: .light))
                                .foregroundStyle(Color.nmlMuted.opacity(0.3))
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 20)
                        .contentShape(Rectangle())
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(Color.nmlHairline).frame(height: 0.5)
                        }
                    }
                    .buttonStyle(.nmlScale(0.97))
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 10)
                    .animation(.nmlSpring.delay(0.22 + Double(index) * 0.07), value: appeared)
                    .contextMenu {
                        ForEach(Self.pool.filter { !actions.contains($0.label) }, id: \.label) { option in
                            Button { replace(slot: index, with: option.label) } label: {
                                Label(option.label, systemImage: option.icon)
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .onAppear { withAnimation { appeared = true } }
    }
}

// ScaleButtonStyle kept for local usage — delegates to NMLScaleButtonStyle at 0.96
private typealias ScaleButtonStyle = NMLScaleButtonStyle

// MARK: - Chat Input Bar

private struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    let isRecording: Bool
    let isPreparingVoice: Bool
    let attachmentLabel: String?
    let attachmentData: Data?
    let attachmentIsImage: Bool
    var isFocused: FocusState<Bool>.Binding
    let incognito: Bool
    let onSend: () -> Void
    let onVoice: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: () -> Void

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
                        Image(systemName: attachmentIsImage ? "photo.fill" : "doc.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.nmlTitanium)
                            .frame(width: 38, height: 38)
                            .nmlGlass(RoundedRectangle(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachmentLabel)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.nmlInk)
                            .lineLimit(1)
                        Text(attachmentIsImage ? "Ready for analysis" : "Ready to read")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    Spacer()
                    Button(action: onRemoveAttachment) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Color.nmlMuted)
                            // Glyph stays 16pt; the tap target grows to the 40×40 minimum.
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.nmlScale)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.nmlSurface)
                .clipShape(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NMLRadius.card, style: .continuous).strokeBorder(Color.nmlHairline, lineWidth: 0.5))
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }

            HStack(alignment: .bottom, spacing: 10) {
                // Attach
                Button(action: onAttach) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(Color.nmlMuted)
                        .frame(width: 36, height: 36)
                        .nmlGlass(Circle(), interactive: true)
                }
                .buttonStyle(.nmlScale)
                .disabled(isSending)

                // Text field in a rounded container — the chat surface
                TextField(incognito ? "Shadow mode" : "Message", text: $text, axis: .vertical)
                    .font(.system(size: 15, weight: .light))
                    .foregroundStyle(Color.nmlInk)
                    .tint(Color.nmlTitanium)
                    .lineLimit(1...6)
                    .focused(isFocused)
                    .onSubmit { if canSend { onSend() } }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.nmlSurface)
                    .clipShape(RoundedRectangle(cornerRadius: NMLRadius.input, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: NMLRadius.input, style: .continuous)
                            .strokeBorder(
                                isFocused.wrappedValue
                                    ? Color.nmlTitanium.opacity(0.28)
                                    : Color.nmlHairline,
                                lineWidth: isFocused.wrappedValue ? 1.0 : 0.5
                            )
                            .animation(.nmlFast, value: isFocused.wrappedValue)
                    )

                // Send / voice
                Button(action: canSend ? onSend : onVoice) {
                    ZStack {
                        if isPreparingVoice && !canSend {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color.nmlObsidian)
                        } else {
                            Image(systemName: canSend ? "arrow.up" : (isRecording ? "stop.fill" : "mic.fill"))
                                .font(.system(size: 15, weight: .semibold))
                                .contentTransition(.symbolEffect(.replace))
                        }
                    }
                    .foregroundStyle(canAct ? Color.nmlObsidian : Color.nmlMuted)
                    .frame(width: 36, height: 36)
                    .contentShape(Circle())
                    .nmlGlass(
                        Circle(),
                        tint: canAct ? (isRecording && !canSend ? Color.nmlDanger : Color.nmlTitanium) : nil,
                        interactive: false
                    )
                    .shadow(color: Color.nmlFillScrim, radius: 6, y: 2)
                }
                .disabled(!canAct)
                .buttonStyle(ScaleButtonStyle())
                .animation(.nmlFast, value: canAct)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 12)
            // No frosted band — the field pill floats on the canvas like ChatGPT's composer.
        }
    }

    private var canSend: Bool {
        !isSending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachmentLabel != nil)
    }

    private var canAct: Bool {
        !isSending && !isPreparingVoice
    }
}

// MARK: - Status Indicator

private struct StatusIndicator: View {
    let label: String

    var body: some View {
        HStack {
            OxyThinkingIndicator(label: label, compact: true)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(Color.nmlTitanium.opacity(0.08))
                .clipShape(Capsule())
            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 2)
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
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.nmlAttention)
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
                        .animation(.nmlFast, value: t)
                }
            } else {
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
                    .symbolEffect(.variableColor.iterative, isActive: true)
                if let t = transcript, !t.isEmpty {
                    Text(t)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.nmlInk)
                        .lineLimit(1)
                } else {
                    Text("Transcribing…")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.nmlMuted)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .nmlGlass(Capsule())
        .animation(.nmlFast, value: state)
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
                .fill(Color.nmlTitanium)
                .frame(width: 3, height: on ? maxH : 3)
                .animation(
                    active
                        ? .easeInOut(duration: dur).repeatForever(autoreverses: true).delay(delay)
                        : .nmlFast,
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
