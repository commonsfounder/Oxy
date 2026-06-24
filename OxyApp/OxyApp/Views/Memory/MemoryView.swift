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
                    // Edge-swipe to dismiss, matching Connectors/Settings, so the
                    // modally-presented Memory screen is never a dead end.
                    .gesture(
                        DragGesture(minimumDistance: 20)
                            .onEnded { value in
                                if value.startLocation.x < 60, value.translation.width > 80 {
                                    dismiss()
                                }
                            }
                    )
            }
        }
    }

    private var memoryContent: some View {
        ZStack {
            Color.mgBg.ignoresSafeArea()

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
                                    onCollapse: { withAnimation(.nmlStandard) { composerExpanded = false } }
                                )
                            } else {
                                // Collapsed: a single quiet line. Tapping it reveals the full composer.
                                Button {
                                    HapticManager.shared.impact(.light)
                                    saveMessage = nil
                                    withAnimation(.nmlStandard) { composerExpanded = true }
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "plus")
                                            .font(.system(size: 13, weight: .medium))
                                            .foregroundStyle(Color.mgSecondary)
                                        Text("Remember something…")
                                            .font(.nmlBody(15, weight: .light))
                                            .foregroundStyle(Color.mgSecondary)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.vertical, 14)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.nmlScale(0.99))
                            }
                        }
                        .padding(.top, 12)
                        .padding(.bottom, composerExpanded ? 36 : 24)

                        HStack {
                            MilgrainSectionHeader(title: "Saved Memories")
                            Spacer()
                            if !items.isEmpty {
                                Text("\(items.count)")
                                    .font(.nmlBody(13))
                                    .foregroundStyle(Color.mgSecondary)
                                    .contentTransition(.numericText())
                                    .animation(.nmlStandard, value: items.count)
                            }
                        }
                        .padding(.bottom, 12)

                        if !isLoading && !items.isEmpty {
                            NamelessLineField(placeholder: "Search memories…", text: $search)
                                .padding(.bottom, 20)
                        }

                        if isLoading {
                            ForEach(0..<4, id: \.self) { _ in
                                OxySkeletonCard(height: 44, cornerRadius: 0)
                                MilgrainDivider()
                            }
                        } else if items.isEmpty {
                            Text("Nothing remembered yet. Add something above, or just talk — it picks things up as you go.")
                                .font(.system(size: 14, weight: .light))
                                .foregroundStyle(Color.mgSecondary)
                                .padding(.vertical, 20)
                        } else if groupedItems.isEmpty {
                            Text("No memories match \"\(search)\".")
                                .font(.system(size: 14, weight: .light))
                                .foregroundStyle(Color.mgSecondary)
                                .padding(.vertical, 20)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)

                    ForEach(Array(groupedItems.enumerated()), id: \.element.title) { index, group in
                        Text(group.title)
                            .font(.nmlBody(18, weight: .semibold))
                            .foregroundStyle(Color.mgHeading)
                            .padding(.top, index == 0 ? 16 : 30)
                            .padding(.bottom, 4)
                            .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)

                        ForEach(group.items) { item in
                            MemoryRow(item: item)
                                .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 0))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        pendingDeleteItem = item
                                    } label: {
                                        Label("Delete", systemImage: "trash.fill")
                                    }
                                    // The app's accent tint (mint/etc.) otherwise bleeds into
                                    // swipe actions, overriding the system's destructive red.
                                    .tint(Color.mgDestructive)
                                }

                            MilgrainDivider()
                                .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
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
                        .buttonStyle(.nmlScale(0.98))
                        .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 0)
                .animation(.nmlSpring, value: isLoading)
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
    }

    // Group memories into a few editorial buckets so the screen reads as a curated
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
                draft = ""
                saveMessage = nil
                isSaving = false
                // Collapse back to the quiet line so the freshly-saved memory leads again.
                withAnimation(.nmlStandard) { composerExpanded = false }
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

    var body: some View {
        Text(item.content)
            .font(.nmlBody(15, weight: .light))
            .foregroundStyle(Color.mgHeading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16)
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
                Text("Add it once. It's kept for later.")
                    .font(.mgDidot(18, weight: .bold))
                    .foregroundStyle(Color.mgHeading)
                Spacer(minLength: 8)
                if let onCollapse {
                    Button(action: onCollapse) {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.mgSecondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.nmlScale)
                    .accessibilityLabel("Collapse")
                }
            }

            NamelessLineField(
                placeholder: "Remember that…",
                text: $draft,
                axis: .vertical,
                lineLimit: 1...4
            )

            HStack {
                if let message {
                    Text(message)
                        .font(.nmlBody(12, weight: .medium))
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
                            .font(.nmlBody(12, weight: .semibold))
                            .tracking(0.4)
                    }
                    .foregroundStyle(canSave ? Color.mgHeading : Color.mgSecondary)
                }
                .buttonStyle(.nmlScale)
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
