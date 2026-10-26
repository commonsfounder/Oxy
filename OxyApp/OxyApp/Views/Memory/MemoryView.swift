import SwiftUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.revealClose) private var revealClose
    private func dismiss() { if let revealClose { revealClose() } else { systemDismiss() } }
    @State private var items: [MemoryItem] = []
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var isMutating = false
    @State private var draft = ""
    @State private var saveMessage: String?
    @State private var errorMessage: String?
    @State private var mutationError: String?
    @State private var showClearAllConfirm = false
    @State private var pendingDeleteItem: MemoryItem?
    @State private var editingItem: MemoryItem?
    @State private var search = ""
    @State private var photosExpanded = false
    // The composer stays collapsed to a single line so saved memories lead the screen —
    // you read memories far more often than you add one.
    @State private var composerExpanded = false
    private let embedded: Bool

    init(embedded: Bool = false) {
        self.embedded = embedded
    }

    var body: some View {
        if embedded {
            memoryContent
        } else {
            NavigationStack {
                memoryContent
                    // Edge-swipe-to-dismiss is provided once by `.swipeToDismiss()` on the
                    // presenting fullScreenCover (MoreView) — no per-screen copy needed.
            }
        }
    }

    @Environment(\.colorScheme) private var colorScheme
    private var lightMode: Bool { colorScheme == .light }

    private var memoryContent: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                if !embedded {
                    ScreenHeaderView(title: "Memory", onBack: revealClose == nil ? { dismiss() } : nil)
                }
                // A real List, not a hand-rolled ScrollView, so swipe-to-delete is the
                // native, reliable gesture instead of a custom drag (which rendered a
                // visible red sliver behind every row — not worth re-fighting SwiftUI for).
                List {
                    VStack(alignment: .leading, spacing: 18) {
                        MemorySearchField(text: $search)
                        let summaryLayout = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                            : AnyLayout(HStackLayout())
                        summaryLayout {
                            Text(isLoading ? "Loading memories" : (errorMessage != nil ? (items.isEmpty ? "Memories unavailable" : "Last loaded memories") : "\(items.count) saved memories"))
                                .font(.appBody(14)).foregroundStyle(Color.appMuted)
                            if !typeSize.isAccessibilitySize { Spacer() }
                            Button {
                                HapticManager.shared.impact(.light)
                                saveMessage = nil
                                withAnimation(reduceMotion ? nil : .appStandard) { composerExpanded.toggle() }
                            } label: {
                                HStack(spacing: 7) {
                                    AppIcon(composerExpanded ? "xmark" : "plus", size: 14)
                                    Text(composerExpanded ? "Close" : "Add memory")
                                }
                                .font(.appBody(14, weight: .semibold))
                                .foregroundStyle(Color.appAccent)
                                .frame(minHeight: 44)
                            }
                            .buttonStyle(.appScale(0.98))
                            .disabled(isMutating || isSaving)
                        }
                        if composerExpanded {
                            MemoryDropBox(draft: $draft, isSaving: isSaving, message: saveMessage,
                                onSave: { Task { await saveMemory() } })
                        }
                        if let errorMessage {
                            ErrorBanner(message: errorMessage, onRetry: { Task { await loadMemory() } })
                        }
                        if let mutationError {
                            ErrorBanner(message: mutationError, onDismiss: { self.mutationError = nil })
                        }
                        if isLoading {
                            OxySkeletonCard(height: 90, cornerRadius: 12)
                        } else if items.isEmpty && errorMessage == nil {
                            Text("Nothing saved yet")
                                .font(.appBody(20, weight: .medium)).foregroundStyle(Color.appInk)
                                .padding(.vertical, 30)
                        } else if groupedItems.isEmpty && !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("No memories match “\(search)”.")
                                .font(.appBody(16)).foregroundStyle(Color.appMuted)
                                .padding(.vertical, 20)
                        }
                    }
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                    .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)

                    ForEach(Array(groupedItems.enumerated()), id: \.element.title) { index, group in
                        Text(group.title)
                            .font(.appBody(15, weight: .semibold))
                            .foregroundStyle(Color.appInk)
                            .accessibilityAddTraits(.isHeader)
                            .padding(.top, index == 0 ? 8 : 26)
                            .padding(.bottom, 4)
                            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)

                        ForEach(group.items) { item in
                            memoryListRow(item)

                            SettingsDivider()
                                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                        }
                    }

                    if photoNoteCount > 0, search.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button {
                            withAnimation(reduceMotion ? nil : .appStandard) { photosExpanded.toggle() }
                        } label: {
                            HStack(spacing: 10) {
                                Text("From your photos").font(.appBody(17, weight: .medium))
                                Spacer()
                                Text(photoNoteCount == 1 ? "1 note" : "\(photoNoteCount) notes")
                                    .font(.appBody(13)).foregroundStyle(Color.appMuted)
                                AppIcon("chevron-down", size: 14)
                                    .rotationEffect(.degrees(photosExpanded ? 180 : 0))
                            }
                            .foregroundStyle(Color.appInk)
                            .frame(minHeight: 52)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.appScale)
                        .accessibilityValue(photosExpanded ? "Expanded" : "Collapsed")
                        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 0, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        if photosExpanded {
                            ForEach(items.filter { $0.source == "photos" }) { item in
                                memoryListRow(item)
                            }
                        }
                    }

                    if !items.isEmpty, search.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button {
                            HapticManager.shared.impact(.light)
                            showClearAllConfirm = true
                        } label: {
                            Text("Clear all memories")
                                .font(.appBody(13, weight: .regular))
                                .foregroundStyle(Color.appDestructive)
                                .padding(.vertical, 18)
                        }
                        .buttonStyle(.appScale(0.98))
                        .disabled(isMutating || isSaving)
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 0)
                .animation(reduceMotion ? nil : .appSpring, value: isLoading)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await loadMemory()
            #if DEBUG
            if PreviewData.isIsolated {
                if let query = ProcessInfo.processInfo.environment["OXY_DEBUG_MEMORY_SEARCH"] { search = query }
                if ["editor", "edit-failure"].contains(ProcessInfo.processInfo.environment["OXY_DEBUG_MEMORY"] ?? "") {
                    try? await Task.sleep(for: .milliseconds(400))
                    editingItem = items.first
                }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_MEMORY"] == "clear" { showClearAllConfirm = true }
                if ProcessInfo.processInfo.environment["OXY_DEBUG_MEMORY"] == "add" { composerExpanded = true }
            }
            #endif
        }
        .refreshable { await loadMemory() }
        .alert("Clear all memories?", isPresented: $showClearAllConfirm) {
            Button("Clear all", role: .destructive) { Task { await clearAll() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes saved memories, checkout details and the checkout payment card.")
        }
        .alert(
            "Delete this memory?",
            isPresented: Binding(get: { pendingDeleteItem != nil }, set: { if !$0 { pendingDeleteItem = nil } }),
            presenting: pendingDeleteItem
        ) { item in
            Button("Delete", role: .destructive) { Task { await deleteItem(item) } }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text(item.content)
        }
        .sheet(item: $editingItem) { item in
            MemoryEditSheet(
                item: item,
                onSave: { newContent in await editItem(item, content: newContent) },
                onCancel: { editingItem = nil }
            )
        }
    }

    private func memoryListRow(_ item: MemoryItem) -> some View {
        MemoryRow(item: item, onTap: { editingItem = item })
            .disabled(isMutating || isSaving)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 0))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    pendingDeleteItem = item
                } label: {
                    Label { Text("Delete") } icon: { AppIcon("trash", size: 16) }
                }
                                    // The app's accent tint (mint/etc.) otherwise bleeds into
                                    // swipe actions, overriding the system's destructive red.
                .tint(Color.appDestructive)
            }

    }

    // Group memories into a few buckets so the screen reads as curated
    // index rather than one long flat list. "Notes" is the catch-all — nothing is lost.
    private var photoNoteCount: Int { items.filter { $0.source == "photos" }.count }

    private var groupedItems: [(title: String, items: [MemoryItem])] {
        let query = search.trimmingCharacters(in: .whitespaces)
        // Notes from photos have their own summary line; hundreds of them would bury what you told Adam.
        let own = items.filter { $0.source != "photos" }
        let visible = query.isEmpty
            ? own
            : own.filter { $0.content.localizedCaseInsensitiveContains(query) }
        let order = ["About you", "How Adam works for you", "People", "Plans"]
        let grouped = Dictionary(grouping: visible, by: { $0.category })
        let ownGroups: [(title: String, items: [MemoryItem])] = order.compactMap { title in
            guard let group = grouped[title], !group.isEmpty else { return nil }
            return (title, group)
        }
        let photos = query.isEmpty ? [] : items.filter { $0.source == "photos" && $0.content.localizedCaseInsensitiveContains(query) }
        return photos.isEmpty ? ownGroups : ownGroups + [(title: "From your photos", items: photos)]
    }

    private func loadMemory() async {
        await MainActor.run { isLoading = true; saveMessage = nil; errorMessage = nil }
        do {
            let data = try await APIClient.shared.request(path: "/memory/\(appState.userId)/items")
            let response = try JSONDecoder().decode(MemoryItemsResponse.self, from: data)
            await MainActor.run {
                items = response.items
                isLoading = false
            }
        } catch {
            await MainActor.run { isLoading = false; errorMessage = "Couldn't load memories." }
        }
    }

    private func saveMemory() async {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isSaving else { return }
        await MainActor.run { isSaving = true; saveMessage = nil }
        do {
            _ = try await APIClient.shared.request(
                path: "/memory",
                method: "POST",
                body: ["userId": appState.userId, "content": content]
            )
            await MainActor.run {
                // A soft success note as it's committed to memory.
                HapticManager.shared.success()
                draft = ""
                saveMessage = nil
                isSaving = false
                // Collapse back to the quiet line so the freshly-saved memory leads again.
                withAnimation(reduceMotion ? nil : .appStandard) { composerExpanded = false }
            }
            await loadMemory()
        } catch {
            await MainActor.run {
                saveMessage = "Couldn't save that."
                isSaving = false
            }
        }
    }

    private func deleteItem(_ item: MemoryItem) async {
        guard !isMutating else { return }
        isMutating = true
        mutationError = nil
        defer { isMutating = false }
        do {
            let data = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)/items/\(item.id)", method: "DELETE"
            )
            let result = try JSONDecoder().decode(MemoryChangeResponse.self, from: data)
            if result.success {
                items.removeAll { $0.id == item.id }
                HapticManager.shared.success()
            } else {
                mutationError = "Couldn't delete this memory."
            }
        } catch {
            mutationError = "Couldn't delete this memory."
        }
    }

    private func editItem(_ item: MemoryItem, content: String) async -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Enter a memory to save." }
        guard trimmed != item.content else { return nil }
        do {
            let data = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)/items/\(item.id)", method: "PUT", body: ["content": trimmed]
            )
            let result = try JSONDecoder().decode(MemoryChangeResponse.self, from: data)
            guard result.success else { return "Couldn't save the change. Try again." }
            if let index = items.firstIndex(where: { $0.id == item.id }) {
                items[index] = MemoryItem(id: item.id, content: trimmed, source: item.source, createdAt: item.createdAt)
            }
            HapticManager.shared.success()
            return nil
        } catch {
            return "Couldn't save the change. Try again."
        }
    }

    private func clearAll() async {
        guard !isMutating else { return }
        isMutating = true
        mutationError = nil
        defer { isMutating = false }
        do {
            let data = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)", method: "DELETE", body: ["scope": "all"]
            )
            let result = try JSONDecoder().decode(MemoryChangeResponse.self, from: data)
            if result.success {
                items = []
                HapticManager.shared.success()
            } else {
                mutationError = "Couldn't clear memories."
            }
        } catch {
            mutationError = "Couldn't clear memories."
        }
    }

}

private struct MemoryRow: View {
    let item: MemoryItem
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.content)
                        .font(.appBody(18))
                        .foregroundStyle(Color.appInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 8)
                AppIcon("chevron-right", size: 13)
                    .foregroundStyle(Color.appMuted)
                    .padding(.top, 2)
                    .padding(.trailing, 24)
            }
            .padding(.vertical, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.content)
        .accessibilityHint("Edit memory")
    }
}

/// A small self-contained search field that reads as active and tappable —
/// leading glyph, legible placeholder, trailing clear button — rather than
/// the too-dim `AppLineField` this screen used before.
private struct MemorySearchField: View {
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            AppIcon("search", size: 15)
                .foregroundStyle(Color.appMuted)
            TextField("", text: $text, prompt: Text("Search memories").foregroundStyle(Color.appMuted))
                .font(.appBody(16))
                .foregroundStyle(Color.appInk)
                .tint(Color.appMuted)
                .accessibilityLabel("Search memories")
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .focused($isFocused)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    AppIcon("xmark-circle", size: 15)
                        .foregroundStyle(Color.appMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
                .accessibilityLabel("Clear search")
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.settingsRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
    }
}

/// Edit sheet opened by tapping a memory row — a simple multi-line editor
/// pre-filled with the current content, plus Save/Cancel.
private struct MemoryEditSheet: View {
    let item: MemoryItem
    let onSave: (String) async -> String?
    let onCancel: () -> Void
    @Environment(AppState.self) private var appState
    @State private var content: String
    @State private var isSaving = false
    @State private var saveError: String?

    init(item: MemoryItem, onSave: @escaping (String) async -> String?, onCancel: @escaping () -> Void) {
        self.item = item
        self.onSave = onSave
        self.onCancel = onCancel
        _content = State(initialValue: item.content)
    }

    private var canSave: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                ScrollView {
                  VStack(alignment: .leading, spacing: 18) {
                    if appState.isDemoSession { Text("Sample").font(.caption).foregroundStyle(Color.appMuted) }
                    AppLineField(
                        placeholder: "Remember that…",
                        text: $content,
                        axis: .vertical,
                        lineLimit: 3...10
                    )
                    .disabled(isSaving)
                    if let saveError {
                        Text(saveError).font(.appBody(15)).foregroundStyle(Color.appDestructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                  }
                  .padding(.horizontal, 24)
                  .padding(.vertical, 20)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .foregroundStyle(Color.appAccent)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView().accessibilityLabel("Saving memory")
                    } else {
                        Button("Save") { Task { await save() } }
                            .foregroundStyle(Color.appAccent)
                            .disabled(!canSave)
                    }
                }
            }
            .navigationTitle("Edit memory")
            .navigationBarTitleDisplayMode(.inline)
            #if DEBUG
            .task {
                if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_MEMORY"] == "edit-failure" {
                    content = "Sample revised note to preserve after a save failure."
                    try? await Task.sleep(for: .milliseconds(600))
                    await save()
                }
            }
            #endif
        }
        .interactiveDismissDisabled(isSaving)
    }

    private func save() async {
        guard canSave else { return }
        isSaving = true
        saveError = nil
        saveError = await onSave(content)
        isSaving = false
        if saveError == nil { onCancel() }
    }
}

private struct MemoryDropBox: View {
    @Binding var draft: String
    let isSaving: Bool
    let message: String?
    let onSave: () -> Void

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            AppLineField(
                placeholder: "Remember that…",
                text: $draft,
                axis: .vertical,
                lineLimit: 1...4,
                autofocus: true
            )

            HStack {
                if let message {
                    Text(message)
                        .font(.appBody(12, weight: .medium))
                        .foregroundStyle(message == "Saved." ? Color.appInk : Color.appDestructive)
                }
                Spacer()
                Button(action: onSave) {
                    HStack(spacing: 8) {
                        if isSaving {
                            ProgressView()
                                .scaleEffect(0.6)
                                .tint(Color.appMuted)
                        }
                        Text(isSaving ? "Saving" : "Save")
                            .font(.appBody(12, weight: .semibold))
                    }
                    .foregroundStyle(Color.appOnAction)
                    .padding(.horizontal, 18)
                    .frame(minHeight: 44)
                    .background(Color.appAction, in: Capsule())
                    .opacity(canSave ? 1 : 0.45)
                }
                .buttonStyle(.appScale)
                .disabled(!canSave)
            }
        }
    }
}

struct MemoryItem: Codable, Identifiable, Equatable {
    let id: String
    let content: String
    let source: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, content, source
        case createdAt = "created_at"
    }

    // Client-side bucket for the grouped Memory layout. First match wins; whole words only,
    // so "person" never reads as "son".
    var category: String {
        let meaningfulChars = content.filter { $0.isLetter }.count
        if meaningfulChars < 3 { return "About you" }
        let lowered = content.lowercased()
        let words = Set(lowered.split(whereSeparator: { !$0.isLetter && $0 != "'" }).map(String.init))
        func hasWord(_ keys: [String]) -> Bool { keys.contains { words.contains($0) } }
        func hasPhrase(_ keys: [String]) -> Bool { keys.contains { lowered.contains($0) } }
        if hasWord(["adam"]) || hasPhrase(["ask me", "ask before", "remind me", "always ", "never ", "when i ask", "reply ", "keep it short", "tone", "concise", "brief me"]) { return "How Adam works for you" }
        if hasWord(["plan", "plans", "trip", "booked", "holiday", "wedding", "flight", "appointment", "deadline", "project", "tomorrow", "tonight", "upcoming", "visiting", "moving"]) || hasPhrase(["next week", "next month", "going to", "working on", "this weekend", "planning"]) { return "Plans" }
        if hasWord(["partner", "wife", "husband", "girlfriend", "boyfriend", "friend", "mum", "mom", "dad", "mother", "father", "brother", "sister", "boss", "son", "daughter", "colleague", "cousin", "aunt", "uncle", "grandma", "grandmother", "grandfather", "pookie"]) || hasPhrase(["loved one"]) { return "People" }
        return "About you"
    }
}

private struct MemoryChangeResponse: Codable {
    let success: Bool
}

struct MemoryItemsResponse: Codable {
    let items: [MemoryItem]
}

#Preview {
    MemoryView()
        .environment(AppState())
}
