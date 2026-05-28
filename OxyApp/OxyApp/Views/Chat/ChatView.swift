import MessageUI
import PhotosUI
import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ChatViewModel()
    @State private var voiceInput = VoiceInputManager()
    @FocusState private var isInputFocused: Bool
    @State private var showSearch = false
    @State private var isIncognito = false
    @State private var pendingReviewAction: ActionResult?
    @State private var messageDraft: MessageDraft?
    @State private var messageComposerAlert: String?
    @State private var handledReviewActionIDs = Set<String>()
    @State private var handledMessageComposeActionIDs = Set<String>()
    @State private var showPhotoPicker = false
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var pendingImageData: Data?
    @State private var pendingImageName: String?
    @State private var pendingImageMimeType = "image/jpeg"

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Incognito banner
                    if isIncognito {
                        HStack(spacing: 8) {
                            Image(systemName: "eye.slash.fill")
                                .font(.system(size: 12))
                            Text("Vanish mode — messages won't be saved")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(Color.oxyStone)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Color.oxyStone.opacity(0.1))
                    }

                    // Messages
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                if viewModel.messages.isEmpty && !viewModel.isSending {
                                    WelcomeCard(onQuickAction: { action in
                                        viewModel.inputText = action
                                        viewModel.sendMessage(userId: appState.userId)
                                    })
                                    .padding(.top, 40)
                                    .padding(.bottom, 20)
                                }

                                ForEach(viewModel.messages) { message in
                                    MessageBubble(
                                        message: message,
                                        showsTypingIndicator: viewModel.statusLabel == nil,
                                        onActionCommand: { command in
                                            viewModel.sendCommand(command, userId: appState.userId)
                                        },
                                        onOpenAction: { action in
                                            handleActionOpen(action)
                                        }
                                    )
                                        .id(message.id)
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
                    if voiceInput.isRecording {
                        VoiceRecordingBar(
                            transcript: voiceInput.transcript,
                            onStop: {
                                voiceInput.stopRecording()
                                if !voiceInput.transcript.isEmpty {
                                    viewModel.inputText = voiceInput.transcript
                                    viewModel.sendMessage(userId: appState.userId)
                                }
                            },
                            onCancel: {
                                voiceInput.stopRecording()
                            }
                        )
                    }

                    // Input bar
                    ChatInputBar(
                        text: $viewModel.inputText,
                        isSending: viewModel.isSending,
                        isRecording: voiceInput.isRecording,
                        isPreparingVoice: voiceInput.isPreparing,
                        attachmentLabel: pendingImageName,
                        isFocused: $isInputFocused,
                        onSend: {
                            sendCurrentDraft()
                        },
                        onVoice: {
                            if voiceInput.isRecording {
                                voiceInput.stopRecording()
                                if !voiceInput.transcript.isEmpty {
                                    viewModel.inputText = voiceInput.transcript
                                    viewModel.sendMessage(userId: appState.userId)
                                }
                            } else {
                                voiceInput.startRecording()
                            }
                        },
                        onAttach: {
                            showPhotoPicker = true
                        },
                        onRemoveAttachment: {
                            pendingImageData = nil
                            pendingImageName = nil
                            selectedPhotoItem = nil
                        }
                    )
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: { showSearch = true }) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 17))
                            .foregroundStyle(Color.oxySub)
                    }
                }

                ToolbarItem(placement: .principal) {
                    HStack(spacing: 10) {
                        ZStack {
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [Color.oxyStone.opacity(0.3), Color.oxyStone.opacity(0.15)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 34, height: 34)

                            Image(systemName: "sparkles")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Color.oxyStone)
                        }

                        VStack(alignment: .leading, spacing: 1) {
                            Text("Oxy")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Color.oxyText)
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(Color.oxyGreen)
                                    .frame(width: 6, height: 6)
                                Text("Online")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Color.oxySub)
                            }
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.startNewChat(userId: appState.userId)
                            }
                        }) {
                            Label("New Chat", systemImage: "square.and.pencil")
                        }
                        Divider()
                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                isIncognito.toggle()
                            }
                        }) {
                            Label(
                                isIncognito ? "Turn Off Vanish Mode" : "Vanish Mode",
                                systemImage: isIncognito ? "eye.fill" : "eye.slash.fill"
                            )
                        }
                        Button(action: {
                            viewModel.requestLocationAccess()
                        }) {
                            Label("Share Location", systemImage: "location.fill")
                        }
                        Divider()
                        Button(role: .destructive, action: { appState.logout() }) {
                            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.oxySub)
                    }
                }
            }
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .sheet(isPresented: $showSearch) {
                ChatSearchView(userId: appState.userId) { result in
                    guard let createdAt = result.createdAt else { return }
                    showSearch = false
                    Task {
                        await viewModel.loadHistoryAround(userId: appState.userId, createdAt: createdAt)
                    }
                }
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
            .onChange(of: selectedPhotoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await MainActor.run {
                            pendingImageData = data
                            pendingImageName = "Photo"
                            pendingImageMimeType = data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? "image/png" : "image/jpeg"
                        }
                    }
                }
            }
            .onChange(of: pendingReviewAction) { oldValue, newValue in
                if let oldValue, newValue == nil {
                    handledReviewActionIDs.insert(oldValue.id)
                }
            }
        }
        .task {
            await viewModel.prepareChat(userId: appState.userId)
        }
        .onAppear {
            viewModel.requestLocationAccess()
        }
    }

    private func sendCurrentDraft() {
        if let pendingImageData {
            viewModel.sendImageMessage(
                userId: appState.userId,
                imageData: pendingImageData,
                fileName: pendingImageMimeType == "image/png" ? "photo.png" : "photo.jpg",
                mimeType: pendingImageMimeType
            )
            self.pendingImageData = nil
            pendingImageName = nil
            selectedPhotoItem = nil
        } else {
            viewModel.sendMessage(userId: appState.userId)
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
                .fill(Color.oxyLine2)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)

            HStack(spacing: 12) {
                Image(systemName: iconName)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.oxyStone)
                    .frame(width: 34, height: 34)
                    .background(Color.oxyStone.opacity(0.12))
                    .clipShape(Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Color.oxyText)
                    Text("One tap when it looks right.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.oxySub)
                }
                Spacer()
            }

            Text(detail)
                .font(.system(size: 15))
                .foregroundStyle(Color.oxyText)
                .lineSpacing(5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color.oxySurface2.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.oxyLine, lineWidth: 1)
                )

            HStack(spacing: 10) {
                Button(action: onCancel) {
                    Label("Cancel", systemImage: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.oxySub)
                .background(Color.oxySurface3)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Button(action: onConfirm) {
                    Label("Send", systemImage: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.oxyOnAccent)
                .background(Color.oxyStone)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.oxySurface1)
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
    let transcript: String
    let onStop: () -> Void
    let onCancel: () -> Void

    @State private var pulse = false

    var body: some View {
        VStack(spacing: 8) {
            Divider().overlay(Color.oxyLine2)

            HStack(spacing: 12) {
                Button(action: onCancel) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(Color.oxyDim)
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.oxyRed)
                            .frame(width: 8, height: 8)
                            .scaleEffect(pulse ? 1.2 : 0.8)
                            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: pulse)
                        Text("Listening...")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.oxyText)
                    }
                    if !transcript.isEmpty {
                        Text(transcript)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.oxySub)
                            .lineLimit(2)
                    }
                }

                Spacer()

                Button(action: onStop) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.oxyOnAccent)
                        .frame(width: 36, height: 36)
                        .background(Color.oxyStone)
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color.oxySurface1)
        .onAppear { pulse = true }
    }
}

// MARK: - Chat Search View

struct ChatSearchView: View {
    let userId: String
    let onSelect: (SearchResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var isSearching = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if results.isEmpty && !isSearching && query.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 36))
                            .foregroundStyle(Color.oxyDim)
                        Text("Search conversations")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                        Text("Find messages from your chat history")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.oxyDim)
                    }
                } else if results.isEmpty && !isSearching && !query.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 36))
                            .foregroundStyle(Color.oxyDim)
                        Text("No results found")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(results) { result in
                                Button {
                                    onSelect(result)
                                    dismiss()
                                } label: {
                                    SearchResultRow(result: result)
                                }
                                .buttonStyle(.plain)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 10)

                                if result.id != results.last?.id {
                                    Divider()
                                        .overlay(Color.oxyLine)
                                        .padding(.leading, 52)
                                }
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }

                if isSearching {
                    ProgressView()
                        .tint(Color.oxyStone)
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.oxyStone)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search messages...")
            .onChange(of: query) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    results = []
                    return
                }
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    await search(trimmed)
                }
            }
        }
    }

    private func search(_ q: String) async {
        isSearching = true
        do {
            let data = try await APIClient.shared.request(
                path: "/history/\(userId)/search",
                queryItems: [URLQueryItem(name: "q", value: q)]
            )
            let response = try JSONDecoder().decode(SearchResponse.self, from: data)
            results = response.results
        } catch {
            results = []
        }
        isSearching = false
    }
}

private struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(result.role == "user" ? Color.oxyStone.opacity(0.15) : Color.oxySurface3)
                    .frame(width: 36, height: 36)
                Image(systemName: result.role == "user" ? "person.fill" : "sparkles")
                    .font(.system(size: 13))
                    .foregroundStyle(result.role == "user" ? Color.oxyStone : Color.oxySub)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(result.role == "user" ? "You" : "Oxy")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.oxyText)

                Text(result.content)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .lineLimit(3)

                if let date = result.formattedDate {
                    Text(date)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.oxyDim)
                }
            }

            Spacer()
        }
    }
}

struct SearchResult: Codable, Identifiable {
    let role: String
    let content: String
    let createdAt: String?

    var id: String { (createdAt ?? "") + role + String(content.prefix(20)) }

    enum CodingKeys: String, CodingKey {
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

// MARK: - Welcome Card

private struct WelcomeCard: View {
    let onQuickAction: (String) -> Void

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color.oxyStone.opacity(0.2), Color.oxyStone.opacity(0.05)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 72, height: 72)

                Image(systemName: "sparkles")
                    .font(.system(size: 36))
                    .foregroundStyle(Color.oxyStone)
            }

            VStack(spacing: 6) {
                Text("Hey! I'm Oxy")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.oxyText)

                Text("Your AI assistant. Ask me anything\nor tell me to do something.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: 8) {
                QuickChip(icon: "envelope.fill", label: "Check emails") {
                    onQuickAction("Check my emails")
                }
                QuickChip(icon: "calendar", label: "My schedule") {
                    onQuickAction("What's my schedule today?")
                }
                QuickChip(icon: "car.fill", label: "Book a ride") {
                    onQuickAction("Book me a ride")
                }
            }
        }
        .padding(.horizontal, 32)
    }
}

private struct QuickChip: View {
    let icon: String
    let label: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.oxyStone)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.oxySub)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.oxySurface2)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.oxyLine2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chat Input Bar

private struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    let isRecording: Bool
    let isPreparingVoice: Bool
    let attachmentLabel: String?
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onVoice: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: () -> Void
    @State private var voicePulse = false

    var body: some View {
        VStack(spacing: 0) {
            Divider()
                .overlay(Color.oxyLine2)

            if let attachmentLabel {
                HStack(spacing: 8) {
                    Image(systemName: "photo.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.oxyStone)
                    Text(attachmentLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.oxySub)
                    Spacer()
                    Button(action: onRemoveAttachment) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.oxyDim)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color.oxySurface2)
                .clipShape(Capsule())
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }

            HStack(alignment: .bottom, spacing: 10) {
                Button(action: onAttach) {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.oxySub)
                        .frame(width: 36, height: 36)
                }
                .disabled(isSending)

                HStack(spacing: 8) {
                    TextField("Message Oxy...", text: $text, axis: .vertical)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.oxyText)
                        .lineLimit(1...5)
                        .focused(isFocused)
                        .onSubmit {
                            if canSend { onSend() }
                        }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.oxySurface2)
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .overlay(
                    RoundedRectangle(cornerRadius: 22)
                        .stroke(Color.oxyLine2, lineWidth: 1)
                )

                Button(action: canSend ? onSend : onVoice) {
                    ZStack {
                        if isRecording && !canSend {
                            Circle()
                                .stroke(Color.oxyGreen.opacity(0.30), lineWidth: 2)
                                .frame(width: 50, height: 50)
                                .scaleEffect(voicePulse ? 1.32 : 0.78)
                                .opacity(voicePulse ? 0 : 0.85)
                            Circle()
                                .stroke(Color.oxyGreen.opacity(0.20), lineWidth: 1.5)
                                .frame(width: 62, height: 62)
                                .scaleEffect(voicePulse ? 1.18 : 0.72)
                                .opacity(voicePulse ? 0 : 0.65)
                        }
                        if isPreparingVoice && !canSend {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color.oxyOnAccent)
                        } else {
                            Image(systemName: canSend ? "arrow.up" : (isRecording ? "stop.fill" : "mic.fill"))
                                .font(.system(size: 15, weight: .semibold))
                        }
                    }
                    .foregroundStyle(canAct ? Color.oxyOnAccent : Color.oxyDim)
                    .frame(width: 36, height: 36)
                    .background(canAct ? (isRecording && !canSend ? Color.oxyRed : Color.oxyStone) : Color.oxySurface3)
                    .clipShape(Circle())
                    .scaleEffect(isRecording && !canSend && voicePulse ? 1.05 : 1.0)
                }
                .disabled(!canAct)
                .animation(.spring(response: 0.4, dampingFraction: 0.8), value: canAct)
                .animation(.easeInOut(duration: 1.05).repeatForever(autoreverses: false), value: voicePulse)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.oxySurface1)
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
                .background(Color.oxyStone.opacity(0.08))
                .clipShape(Capsule())
            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 2)
    }
}

#Preview {
    ChatView()
        .environment(AppState())
}
