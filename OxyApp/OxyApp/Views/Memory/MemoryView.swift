import SwiftUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var items: [MemoryItem] = []
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var draft = ""
    @State private var saveMessage: String?
    @State private var showClearAllConfirm = false
    @State private var pendingDeleteItem: MemoryItem?
    @State private var editingItem: MemoryItem?
    @State private var search = ""
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
                    ScreenHeaderView(title: "Memory", onBack: { dismiss() })
                }
                // A real List, not a hand-rolled ScrollView, so swipe-to-delete is the
                // native, reliable gesture instead of a custom drag (which rendered a
                // visible red sliver behind every row — not worth re-fighting SwiftUI for).
                List {
                    Group {
                        VStack(alignment: .leading, spacing: 20) {
                            if composerExpanded {
                                MilgrainSectionHeader(title: "Remember")
                                MemoryDropBox(
                                    draft: $draft,
                                    isSaving: isSaving,
                                    message: saveMessage,
                                    onSave: { Task { await saveMemory() } },
                                    onCollapse: { withAnimation(.appStandard) { composerExpanded = false } }
                                )
                            } else {
                                // Collapsed: a single quiet line. Tapping it reveals the full composer.
                                Button {
                                    HapticManager.shared.impact(.light)
                                    saveMessage = nil
                                    withAnimation(.appStandard) { composerExpanded = true }
                                } label: {
                                    HStack(spacing: 12) {
                                        AppIcon("plus", size: 14)
                                            .foregroundStyle(Color.mgSecondary)
                                        Text("Remember something…")
                                            .font(.appBody(15))
                                            .foregroundStyle(Color.mgSecondary)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.vertical, 14)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.appScale(0.99))
                            }
                        }
                        .padding(.top, 12)
                        .padding(.bottom, composerExpanded ? 36 : 24)

                        HStack {
                            MilgrainSectionHeader(title: "Saved Memories")
                            Spacer()
                            if !items.isEmpty {
                                Text(items.count == 1 ? "1 memory" : "\(items.count) memories")
                                    .font(.appBody(13))
                                    .foregroundStyle(Color.mgSecondary)
                                    .contentTransition(.numericText())
                                    .animation(.appStandard, value: items.count)
                            }
                        }
                        .padding(.bottom, 12)

                        if !isLoading && !items.isEmpty {
                            MemorySearchField(text: $search)
                                .padding(.bottom, 20)
                        }

                        if isLoading {
                            ForEach(0..<4, id: \.self) { _ in
                                OxySkeletonCard(height: 44, cornerRadius: 0)
                                MilgrainDivider()
                            }
                        } else if items.isEmpty {
                            Text("Nothing remembered yet. Add something above, or just talk — it picks things up as you go.")
                                .font(.appBody(14))
                                .foregroundStyle(Color.mgSecondary)
                                .padding(.vertical, 20)
                        } else if groupedItems.isEmpty {
                            Text("No memories match \"\(search)\".")
                                .font(.appBody(14))
                                .foregroundStyle(Color.mgSecondary)
                                .padding(.vertical, 20)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)

                    ForEach(Array(groupedItems.enumerated()), id: \.element.title) { index, group in
                        Text(group.title)
                            .font(.appBody(18, weight: .semibold))
                            .foregroundStyle(Color.mgHeading)
                            .padding(.top, index == 0 ? 16 : 30)
                            .padding(.bottom, 4)
                            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)

                        ForEach(group.items) { item in
                            MemoryRow(item: item, onTap: { editingItem = item })
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
                                    .tint(Color.mgDestructive)
                                }

                            MilgrainDivider()
                                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                        }
                    }

                    if !groupedItems.isEmpty, search.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button {
                            HapticManager.shared.impact(.light)
                            showClearAllConfirm = true
                        } label: {
                            Text("Clear all memories")
                                .font(.system(size: 13, weight: .regular))
                                .foregroundStyle(Color.mgDestructive)
                                .padding(.vertical, 18)
                        }
                        .buttonStyle(.appScale(0.98))
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 0)
                .animation(.appSpring, value: isLoading)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await loadMemory() }
        .refreshable { await loadMemory() }
        .alert("Clear all memories?", isPresented: $showClearAllConfirm) {
            Button("Clear all", role: .destructive) { Task { await clearAll() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes everything remembered about you.")
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
                onSave: { newContent in
                    editingItem = nil
                    Task { await editItem(item, content: newContent) }
                },
                onCancel: { editingItem = nil }
            )
        }
    }

    // Group memories into a few buckets so the screen reads as curated
    // index rather than one long flat list. "Notes" is the catch-all — nothing is lost.
    private var groupedItems: [(title: String, items: [MemoryItem])] {
        let query = search.trimmingCharacters(in: .whitespaces)
        let visible = query.isEmpty
            ? items
            : items.filter { $0.content.localizedCaseInsensitiveContains(query) }
        let order = ["People", "Places", "Work & Study", "Preferences", "Notes"]
        let grouped = Dictionary(grouping: visible, by: { $0.category })
        return order.compactMap { title in
            guard let group = grouped[title], !group.isEmpty else { return nil }
            return (title, group)
        }
    }

    private func loadMemory() async {
        await MainActor.run { isLoading = true; saveMessage = nil }
        do {
            let data = try await APIClient.shared.request(path: "/memory/\(appState.userId)/items")
            let response = try JSONDecoder().decode(MemoryItemsResponse.self, from: data)
            await MainActor.run {
                items = response.items
                isLoading = false
            }
        } catch {
            await MainActor.run { items = []; isLoading = false }
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
                withAnimation(.appStandard) { composerExpanded = false }
            }
            await loadMemory()
        } catch {
            await MainActor.run {
                saveMessage = "Could not save that."
                isSaving = false
            }
        }
    }

    private func deleteItem(_ item: MemoryItem) async {
        HapticManager.shared.impact(.light)
        // Optimistic removal so the row disappears instantly.
        await MainActor.run { items.removeAll { $0.id == item.id } }
        do {
            _ = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)/items/\(item.id)",
                method: "DELETE"
            )
        } catch {
            await loadMemory() // restore on failure
        }
    }

    private func editItem(_ item: MemoryItem, content: String) async {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != item.content else { return }
        HapticManager.shared.impact(.light)
        // Optimistic update so the row reflects the edit instantly.
        await MainActor.run {
            if let index = items.firstIndex(where: { $0.id == item.id }) {
                items[index] = MemoryItem(id: item.id, content: trimmed, source: item.source, createdAt: item.createdAt)
            }
        }
        do {
            _ = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)/items/\(item.id)",
                method: "PUT",
                body: ["content": trimmed]
            )
        } catch {
            await loadMemory() // restore on failure
        }
    }

    private func clearAll() async {
        await MainActor.run { items = [] }
        do {
            _ = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)",
                method: "DELETE",
                body: ["scope": "all"]
            )
        } catch {
            await loadMemory()
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
                        .font(.appBody(15))
                        .foregroundStyle(Color.mgHeading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    // Quiet provenance cue — "Saved" (typed by hand) vs "Learned"
                    // (picked up from conversation) — never shouted.
                    Text(item.sourceLabel)
                        .font(.appBody(11))
                        .foregroundStyle(Color.mgSecondary)
                }
                Spacer(minLength: 8)
                AppIcon("chevron-right", size: 13)
                    .foregroundStyle(Color.mgSecondary.opacity(0.5))
                    .padding(.top, 2)
                    .padding(.trailing, 24)
            }
            .padding(.vertical, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.appScale(0.99))
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
                .foregroundStyle(Color.mgSecondary)
            TextField("Search memories…", text: $text)
                .font(.appBody(14))
                .foregroundStyle(Color.mgHeading)
                .tint(Color.mgSecondary)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .focused($isFocused)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    AppIcon("xmark-circle", size: 15)
                        .foregroundStyle(Color.mgSecondary)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.appScale)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Color.appSurface)
        .clipShape(RoundedRectangle(cornerRadius: AppRadius.card, style: .continuous))
    }
}

/// Edit sheet opened by tapping a memory row — a simple multi-line editor
/// pre-filled with the current content, plus Save/Cancel.
private struct MemoryEditSheet: View {
    let item: MemoryItem
    let onSave: (String) -> Void
    let onCancel: () -> Void
    @State private var content: String

    init(item: MemoryItem, onSave: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.item = item
        self.onSave = onSave
        self.onCancel = onCancel
        _content = State(initialValue: item.content)
    }

    private var canSave: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 18) {
                    AppLineField(
                        placeholder: "Remember that…",
                        text: $content,
                        axis: .vertical,
                        lineLimit: 3...10
                    )
                    Spacer()
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .foregroundStyle(Color.mgSecondary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(content) }
                        .foregroundStyle(canSave ? Color.mgHeading : Color.mgSecondary)
                        .disabled(!canSave)
                }
            }
            .navigationTitle("Edit Memory")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct MemoryDropBox: View {
    @Binding var draft: String
    let isSaving: Bool
    let message: String?
    let onSave: () -> Void
    var onCollapse: (() -> Void)?

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                // Sans, matching every other heading in the settings family — the lone
                // Didot here was the one place the mg dialect borrowed the display serif.
                Text("Add it once. It's kept for later.")
                    .font(.appBody(17, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
                Spacer(minLength: 8)
                if let onCollapse {
                    Button(action: onCollapse) {
                        AppIcon("chevron-up", size: 14)
                            .foregroundStyle(Color.mgSecondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.appScale)
                    .accessibilityLabel("Collapse")
                }
            }

            AppLineField(
                placeholder: "Remember that…",
                text: $draft,
                axis: .vertical,
                lineLimit: 1...4
            )

            HStack {
                if let message {
                    Text(message)
                        .font(.appBody(12, weight: .medium))
                        .foregroundStyle(message == "Saved." ? Color.mgHeading : Color.mgDestructive)
                }
                Spacer()
                Button(action: onSave) {
                    HStack(spacing: 8) {
                        if isSaving {
                            ProgressView()
                                .scaleEffect(0.6)
                                .tint(Color.mgSecondary)
                        }
                        Text(isSaving ? "Saving" : "Save")
                            .font(.appBody(12, weight: .semibold))
                            .tracking(0.4)
                    }
                    .foregroundStyle(canSave ? Color.mgHeading : Color.mgSecondary)
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

    // "Saved" = added by hand; "Learned" = picked up from conversation.
    var sourceLabel: String {
        switch source {
        case "manual", "manual_profile": return "Saved"
        default: return "Learned"
        }
    }

    // Lightweight client-side bucket for the grouped Memory layout. First match wins,
    // so the order matters (a "partner" who "lives in X" reads as People, not Places).
    var category: String {
        if content.count > 180 { return "Notes" }
        // Guard against garbage/degenerate strings ("huh", "" ) getting confidently
        // mis-filed into a keyword bucket. Upstream extraction quality (making sure
        // low-signal content isn't saved as a memory at all) is a separate backend
        // follow-up — this is just the client-side display guard.
        let meaningfulChars = content.filter { $0.isLetter }.count
        if meaningfulChars < 3 { return "Notes" }
        let t = " \(content.lowercased()) "
        func has(_ keys: [String]) -> Bool { keys.contains { t.contains($0) } }
        if has(["partner", "wife", "husband", "girlfriend", "boyfriend", "friend", "mum", "mom", "dad", "mother", "father", "brother", "sister", "boss", "loved one", "pookie", "name is", "named", "son", "daughter"]) { return "People" }
        if has(["school", "college", "university", "student", "study", "studie", "work", "job", "employer", "a-level", "degree"]) { return "Work & Study" }
        if has(["lives", "live ", "lived", "home", "address", "based in", "moved to", "commute"]) { return "Places" }
        if has(["like", "love", "hate", "prefer", "favourite", "favorite", "watch", "eat", "drink", "listen", "read", "fan of"]) { return "Preferences" }
        return "Notes"
    }
}

struct MemoryItemsResponse: Codable {
    let items: [MemoryItem]
}

#Preview {
    MemoryView()
        .environment(AppState())
}
