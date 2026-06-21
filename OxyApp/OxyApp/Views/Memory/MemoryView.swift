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
    @State private var memoryAppeared = false
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
            Color.nmlObsidian.ignoresSafeArea()

            VStack(spacing: 0) {
                if !embedded {
                    ScreenHeaderView(title: "Memory", onBack: { dismiss() })
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 36) {
                        // Capture
                        VStack(alignment: .leading, spacing: 20) {
                            NamelessSectionHeader(title: "Remember")
                            MemoryDropBox(
                                draft: $draft,
                                isSaving: isSaving,
                                message: saveMessage,
                                onSave: { Task { await saveMemory() } }
                            )
                        }

                        // The actual memories — view and delete each, like ChatGPT/Claude.
                        VStack(alignment: .leading, spacing: 0) {
                            HStack {
                                NamelessSectionHeader(title: "Saved Memories")
                                Spacer()
                                if !items.isEmpty {
                                    Text("\(items.count)")
                                        .font(.nmlBody(13))
                                        .foregroundStyle(Color.nmlMuted)
                                }
                            }
                            .padding(.bottom, 12)

                            if isLoading {
                                ForEach(0..<4, id: \.self) { _ in
                                    OxySkeletonCard(height: 44, cornerRadius: 0)
                                    NamelessDivider()
                                }
                            } else if items.isEmpty {
                                Text("Nothing remembered yet. Add something above, or just talk — it picks things up as you go.")
                                    .font(.system(size: 14, weight: .light))
                                    .foregroundStyle(Color.nmlMuted)
                                    .padding(.vertical, 20)
                            } else {
                                ForEach(Array(groupedItems.enumerated()), id: \.element.title) { index, group in
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(group.title)
                                            .font(.nmlDisplay(18, weight: .regular))
                                            .foregroundStyle(Color.nmlInk)
                                            .padding(.top, index == 0 ? 16 : 30)
                                            .padding(.bottom, 4)
                                        ForEach(group.items) { item in
                                            MemoryRow(item: item) {
                                                Task { await deleteItem(item) }
                                            }
                                            NamelessDivider()
                                        }
                                    }
                                    .opacity(memoryAppeared ? 1 : 0)
                                    .offset(y: memoryAppeared ? 0 : 12)
                                    .animation(.nmlSpring.delay(0.06 + Double(index) * 0.08), value: memoryAppeared)
                                }

                                Button {
                                    HapticManager.shared.impact(.light)
                                    showClearAllConfirm = true
                                } label: {
                                    Text("Clear all memories")
                                        .font(.system(size: 13, weight: .regular))
                                        .foregroundStyle(Color.nmlDanger)
                                        .padding(.vertical, 18)
                                }
                                .buttonStyle(.nmlScale(0.98))
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 40)
                    .animation(.nmlSpring, value: isLoading)
                    .animation(.nmlFast, value: items)
                }
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
    }

    // Group memories into a few editorial buckets so the screen reads as a curated
    // index rather than one long flat list. "Notes" is the catch-all — nothing is lost.
    private var groupedItems: [(title: String, items: [MemoryItem])] {
        let order = ["People", "Places", "Work & Study", "Tastes", "Notes"]
        let grouped = Dictionary(grouping: items, by: { $0.category })
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
                memoryAppeared = false
                withAnimation(.nmlSpring.delay(0.04)) { memoryAppeared = true }
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
                saveMessage = "Saved."
                isSaving = false
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
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(item.content)
                .font(.nmlBody(15, weight: .light))
                .foregroundStyle(Color.nmlInk)
                .lineLimit(4)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(action: onDelete) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.nmlMuted)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.nmlScale)
        }
        .padding(.vertical, 16)
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
            Text("Add it once. It's kept for later.")
                .font(.nmlBody(18, weight: .regular))
                .foregroundStyle(Color.nmlInk)

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
                        .foregroundStyle(message == "Saved." ? Color.nmlTitanium : Color.nmlDanger)
                }
                Spacer()
                Button(action: onSave) {
                    HStack(spacing: 8) {
                        if isSaving {
                            ProgressView()
                                .scaleEffect(0.6)
                                .tint(Color.nmlMuted)
                        }
                        Text(isSaving ? "Saving" : "Save")
                            .font(.nmlBody(12, weight: .semibold))
                            .tracking(0.4)
                    }
                    .foregroundStyle(canSave ? Color.nmlTitanium : Color.nmlMuted)
                }
                .buttonStyle(.plain)
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
        if has(["like", "love", "hate", "prefer", "favourite", "favorite", "watch", "eat", "drink", "listen", "read", "fan of"]) { return "Tastes" }
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
