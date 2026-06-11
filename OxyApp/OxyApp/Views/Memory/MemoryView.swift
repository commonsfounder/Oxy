import SwiftUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var summary = MemorySummary()
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var draft = ""
    @State private var saveMessage: String?
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
                // Embedded inside another screen (which owns the header); standalone
                // gets its own minimal header in place of a chunky nav title.
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

                    // Ledger
                    VStack(alignment: .leading, spacing: 4) {
                        NamelessSectionHeader(title: "Ledger")
                            .padding(.bottom, 12)

                        if isLoading {
                            ForEach(0..<3, id: \.self) { _ in
                                OxySkeletonCard(height: 52, cornerRadius: 0)
                                NamelessDivider()
                            }
                        } else {
                            // "Saved" = what you added by hand; "Learned" = what
                            // Nameless picked up on its own. Disjoint, so they add
                            // up to your total memories instead of overlapping.
                            statRow(title: "Saved", value: "\(max(0, summary.total - summary.learned))")
                            NamelessDivider()
                            statRow(title: "Learned", value: "\(summary.learned)")
                            NamelessDivider()
                            statRow(title: "Profile", value: summary.profile ? "Enabled" : "Disabled")

                            if let lastUpdated = summary.lastUpdated {
                                NamelessDivider()
                                statRow(title: "Updated", value: formattedDate(lastUpdated))
                            }
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 40)
                .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isLoading)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await loadMemory() }
        .refreshable { await loadMemory() }
    }

    /// A flat row: clean white title on the left, muted right-aligned detail.
    private func statRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Spacer()
            Text(value)
                .font(.nmlMono(13))
                .foregroundStyle(Color.nmlMuted)
        }
        .padding(.vertical, 16)
    }

    private func loadMemory() async {
        await MainActor.run {
            isLoading = true
            saveMessage = nil
        }
        do {
            let data = try await APIClient.shared.request(path: "/memory/\(appState.userId)")
            let response = try JSONDecoder().decode(MemoryResponse.self, from: data)
            await MainActor.run {
                summary = response.summary ?? MemorySummary()
                isLoading = false
            }
        } catch {
            await MainActor.run {
                summary = MemorySummary()
                isLoading = false
            }
        }
    }

    private func saveMemory() async {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isSaving else { return }
        await MainActor.run {
            isSaving = true
            saveMessage = nil
        }
        do {
            _ = try await APIClient.shared.request(
                path: "/memory",
                method: "POST",
                body: [
                    "userId": appState.userId,
                    "content": content
                ]
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

    private func formattedDate(_ dateStr: String) -> String {
        let iso = ISO8601DateFormatter()
        guard let date = iso.date(from: dateStr) else { return dateStr }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm - d MMM"
        return fmt.string(from: date)
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
            Text("Add it once. Nameless keeps it for later.")
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

struct MemorySummary: Codable {
    var total: Int = 0
    var learned: Int = 0
    var profile: Bool = false
    var lastUpdated: String?
}

struct MemoryResponse: Codable {
    let summary: MemorySummary?
}

#Preview {
    MemoryView()
        .environment(AppState())
}
