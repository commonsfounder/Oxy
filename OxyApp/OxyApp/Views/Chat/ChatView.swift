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
    @State private var showChatMenu = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var pendingImageData: Data?
    @State private var pendingImageName: String?
    @State private var pendingImageMimeType = "image/jpeg"
    @State private var pendingIsImage = true
    @State private var isOffline = false
    private let networkMonitor = NWPathMonitor()

    var body: some View {
        NavigationStack {
        ZStack {
            Color.nmlObsidian.ignoresSafeArea()

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
                        .background(Color(red: 0.85, green: 0.62, blue: 0.22))
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
                            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: viewModel.messages.count)
                        }
                        .overlay(alignment: .bottomLeading) {
                            if viewModel.messages.isEmpty && !viewModel.isSending {
                                WelcomeCard { prompt in
                                    viewModel.inputText = prompt
                                    sendCurrentDraft()
                                }
                                .padding(.horizontal, 20)
                                .padding(.bottom, 12)
                                .transition(.opacity)
                            }
                        }
                        .scrollDismissesKeyboard(.interactively)
                        .onChange(of: viewModel.messages.count) {
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                                if let lastId = viewModel.messages.last?.id {
                                    proxy.scrollTo(lastId, anchor: .bottom)
                                } else {
                                    proxy.scrollTo("status", anchor: .bottom)
                                }
                            }
                        }
                        .onChange(of: viewModel.messages.last?.content) {
                            guard viewModel.scrollTargetMessageID == nil else { return }
                            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
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
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    proxy.scrollTo(targetID, anchor: .center)
                                }
                                try? await Task.sleep(for: .milliseconds(700))
                                viewModel.scrollTargetMessageID = nil
                            }
                        }
                        .onChange(of: viewModel.messages) {
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
                        onSend: {
                            sendCurrentDraft()
                        },
                        onVoice: {
                            guard !voiceInput.isTranscribing else { return }
                            if voiceInput.isRecording {
                                voiceInput.stopRecording()
                            } else {
                                voiceInput.startRecording(userId: appState.userId)
                            }
                        },
                        onAttach: {
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
                chatMenuOverlay
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let onMenu {
                        Button {
                            HapticManager.shared.impact(.light)
                            onMenu()
                        } label: {
                            Image(systemName: "line.3.horizontal")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(Color.nmlMuted)
                        }
                    } else {
                        Button(action: { dismiss() }) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.nmlMuted)
                        }
                    }
                }

                if let session = initialSession {
                    ToolbarItem(placement: .principal) {
                        Text(session.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.nmlInk)
                            .lineLimit(1)
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        withAnimation(.easeOut(duration: 0.16)) { showChatMenu.toggle() }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Color.nmlMuted)
                    }
                }
            }
            .toolbarBackground(Color.nmlObsidian, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
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
                let text = voiceInput.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                voiceInput.transcript = ""
                guard !text.isEmpty else { return }
                viewModel.inputText = text
                viewModel.sendMessage(userId: appState.userId)
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
                viewModel.inputText = transcript
                viewModel.sendMessage(userId: appState.userId)
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
                Color.black.opacity(0.45)
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
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
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
        .buttonStyle(.plain)
    }

    private func dismissAttachMenu() {
        withAnimation(.easeOut(duration: 0.18)) { showAttachMenu = false }
    }

    // MARK: - Chat menu (custom, flat obsidian popover)

    @ViewBuilder
    private var chatMenuOverlay: some View {
        if showChatMenu {
            ZStack(alignment: .topTrailing) {
                Color.clear
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { dismissChatMenu() }

                VStack(spacing: 0) {
                    chatMenuRow("New Chat") {
                        dismissChatMenu()
                        withAnimation(.easeInOut(duration: 0.2)) {
                            viewModel.startNewChat(userId: appState.userId)
                        }
                    }
                    NamelessDivider()
                    chatMenuRow("Share Location") {
                        dismissChatMenu()
                        viewModel.requestLocationAccess()
                    }
                    NamelessDivider()
                    chatMenuRow("Sign Out", destructive: true) {
                        dismissChatMenu()
                        appState.logout()
                    }
                }
                .frame(width: 196)
                .background(Color(white: 9.0 / 255.0))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.nmlHairline, lineWidth: 0.5)
                )
                .padding(.trailing, 12)
                .padding(.top, 6)
                .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topTrailing)))
            }
            .zIndex(20)
        }
    }

    private func chatMenuRow(_ title: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(destructive ? Color.nmlDanger : Color.nmlInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func dismissChatMenu() {
        withAnimation(.easeOut(duration: 0.16)) { showChatMenu = false }
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
                    .background(Color.nmlTitanium.opacity(0.12))
                    .clipShape(Circle())

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
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.nmlHairline, lineWidth: 0.5)
                )

            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Label("Cancel", systemImage: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.nmlMuted)
                .background(Color.nmlSurface2)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Button(action: onConfirm) {
                    Label("Send", systemImage: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.nmlObsidian)
                .background(Color.nmlTitanium)
                .clipShape(RoundedRectangle(cornerRadius: 12))
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
                            .fill(isTranscribing ? Color.nmlTitanium : Color.oxyRed)
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
                            .background(Color.nmlTitanium)
                            .clipShape(Circle())
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color.nmlObsidian)
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

/// The empty-conversation state, anchored bottom-left just above the input: a
/// quiet prompt over three high-leverage starter actions. Naked ultra-light
/// icons, muted grey type, 0.5px rules — nothing filled or coloured.
private struct WelcomeCard: View {
    var onAction: (String) -> Void
    @State private var appeared = false

    private let actions: [(icon: String, label: String)] = [
        ("envelope", "Send an email"),
        ("music.note", "Play some music"),
        ("car", "Book a ride")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Where should we begin?")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Color.nmlInk)

            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                    Button {
                        onAction(action.label)
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: action.icon)
                                .font(.system(size: 18, weight: .ultraLight))
                                .foregroundStyle(Color.nmlMuted)
                                .frame(width: 22, alignment: .leading)
                            Text(action.label)
                                .font(.system(size: 16, weight: .regular))
                                .foregroundStyle(Color.nmlMuted)
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 8)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) { appeared = true }
        }
    }
}

private struct ScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

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
    let onSend: () -> Void
    let onVoice: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: () -> Void
    @State private var voicePulse = false

    var body: some View {
        VStack(spacing: 0) {
            Divider()
                .overlay(Color.nmlHairline)

            if let attachmentLabel {
                HStack(spacing: 10) {
                    if attachmentIsImage, let attachmentData, let uiImage = UIImage(data: attachmentData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 38, height: 38)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        Image(systemName: attachmentIsImage ? "photo.fill" : "doc.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.nmlTitanium)
                            .frame(width: 38, height: 38)
                            .background(Color.nmlSurface2)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
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
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.nmlSurface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }

            HStack(alignment: .bottom, spacing: 10) {
                Button(action: onAttach) {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.nmlMuted)
                        .frame(width: 36, height: 36)
                }
                .disabled(isSending)

                VStack(spacing: 8) {
                    TextField("", text: $text, axis: .vertical)
                        .font(.system(size: 15, weight: .light))
                        .foregroundStyle(Color.nmlInk)
                        .lineLimit(1...5)
                        .focused(isFocused)
                        .onSubmit {
                            if canSend { onSend() }
                        }
                    Rectangle()
                        .fill(Color.nmlHairline)
                        .frame(height: 0.5)
                }
                .padding(.horizontal, 2)

                Button(action: canSend ? onSend : onVoice) {
                    ZStack {
                        if isRecording && !canSend {
                            Circle()
                                .stroke(Color.nmlGlow.opacity(0.30), lineWidth: 2)
                                .frame(width: 50, height: 50)
                                .scaleEffect(voicePulse ? 1.32 : 0.78)
                                .opacity(voicePulse ? 0 : 0.85)
                            Circle()
                                .stroke(Color.nmlGlow.opacity(0.20), lineWidth: 1.5)
                                .frame(width: 62, height: 62)
                                .scaleEffect(voicePulse ? 1.18 : 0.72)
                                .opacity(voicePulse ? 0 : 0.65)
                        }
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
                    .background(canAct ? (isRecording && !canSend ? Color.oxyRed : Color.nmlTitanium) : Color.nmlSurface2)
                    .clipShape(Circle())
                }
                .disabled(!canAct)
                .buttonStyle(ScaleButtonStyle())
                .animation(.easeInOut(duration: 0.15), value: canAct)
                .animation(.easeInOut(duration: 1.05).repeatForever(autoreverses: false), value: voicePulse)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.nmlObsidian)
        }
        .onAppear { voicePulse = true }
        .onChange(of: isRecording) { _, recording in
            if recording {
                voicePulse = false
                DispatchQueue.main.async { voicePulse = true }
            }
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
                    .foregroundStyle(Color(red: 0.85, green: 0.62, blue: 0.22))
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
                        .animation(.easeInOut(duration: 0.2), value: t)
                }
            } else {
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
                    .symbolEffect(.variableColor.iterative, isActive: true)
                if let t = transcript, !t.isEmpty {
                    Text(t)
                        .font(.system(size: 14))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                } else {
                    Text("Transcribing…")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.primary.opacity(0.07), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.13), radius: 18, x: 0, y: 6)
        .animation(.easeInOut(duration: 0.2), value: state)
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
                        : .easeInOut(duration: 0.2),
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
}
