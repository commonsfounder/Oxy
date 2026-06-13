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
            Color.black.ignoresSafeArea()

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
                                        .font(.nmlMono(12))
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
                                Text("Nothing remembered yet. Add something above, or just talk to Oxy and it'll learn as you go.")
                                    .font(.system(size: 14, weight: .light))
                                    .foregroundStyle(Color.nmlMuted)
                                    .padding(.vertical, 20)
                            } else {
                                ForEach(items) { item in
                                    MemoryRow(item: item) {
                                        Task { await deleteItem(item) }
                                    }
                                    NamelessDivider()
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
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 40)
                    .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isLoading)
                    .animation(.easeInOut(duration: 0.2), value: items)
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
            Text("This permanently deletes everything Oxy remembers about you.")
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
            VStack(alignment: .leading, spacing: 4) {
                Text(item.content)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.nmlInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text(item.sourceLabel)
                    .font(.nmlMono(10))
                    .foregroundStyle(Color.nmlMuted)
            }
            Spacer(minLength: 8)
            Button(action: onDelete) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.nmlMuted)
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
            Text("Add it once. Oxy keeps it for later.")
                .font(.system(size: 19, weight: .light))
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
                        .font(.nmlMono(11, weight: .medium))
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
                        Text(isSaving ? "SAVING" : "SAVE")
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(1.6)
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
}

struct MemoryItemsResponse: Codable {
    let items: [MemoryItem]
}

#Preview {
    MemoryView()
        .environment(AppState())
}
