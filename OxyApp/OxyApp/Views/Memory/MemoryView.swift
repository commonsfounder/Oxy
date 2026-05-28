import SwiftUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState
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
            }
        }
    }

    private var memoryContent: some View {
        ZStack {
            Color.oxyBg.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    MemoryDropBox(
                        draft: $draft,
                        isSaving: isSaving,
                        message: saveMessage,
                        onSave: { Task { await saveMemory() } }
                    )
                    .scrollTransition(axis: .vertical) { content, phase in
                        content
                            .opacity(phase.isIdentity ? 1 : 0)
                            .offset(y: phase.isIdentity ? 0 : 24)
                    }

                    if isLoading {
                        HStack(spacing: 10) {
                            OxySkeletonCard(height: 68, cornerRadius: 14)
                            OxySkeletonCard(height: 68, cornerRadius: 14)
                            OxySkeletonCard(height: 68, cornerRadius: 14)
                        }
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    } else {
                        HStack(spacing: 10) {
                            MemoryStat(title: "Saved", value: "\(summary.total)")
                            MemoryStat(title: "Learned", value: "\(summary.learned)")
                            MemoryStat(title: "Profile", value: summary.profile ? "On" : "Off")
                        }
                        .scrollTransition(axis: .vertical) { content, phase in
                            content
                                .opacity(phase.isIdentity ? 1 : 0)
                                .offset(y: phase.isIdentity ? 0 : 22)
                        }
                    }

                    if let lastUpdated = summary.lastUpdated {
                        Text("Updated \(formattedDate(lastUpdated))")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.oxyDim)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 6)
                            .scrollTransition(axis: .vertical) { content, phase in
                                content
                                    .opacity(phase.isIdentity ? 1 : 0)
                                    .offset(y: phase.isIdentity ? 0 : 16)
                            }
                    }
                }
                .padding(16)
                .animation(.spring(response: 0.4, dampingFraction: 0.8), value: isLoading)
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.large)
        .toolbarBackground(Color.oxySurface1, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await loadMemory() }
        .refreshable { await loadMemory() }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color.oxyStone.opacity(0.14))
                        .frame(width: 46, height: 46)
                    Image(systemName: "lock.open.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.oxyStone)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text("Drop a memory")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(Color.oxyText)
                    Text("Add it once. Oxy keeps it for later.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.oxySub)
                }
                Spacer()
            }

            TextField("Remember that...", text: $draft, axis: .vertical)
                .font(.system(size: 15))
                .foregroundStyle(Color.oxyText)
                .lineLimit(2...4)
                .padding(12)
                .background(Color.oxySurface1)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color.oxyLine2, lineWidth: 1)
                )

            HStack {
                if let message {
                    Text(message)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(message == "Saved." ? Color.oxyGreen : Color.oxyRed)
                }
                Spacer()
                Button(action: onSave) {
                    HStack(spacing: 6) {
                        if isSaving {
                            ProgressView()
                                .scaleEffect(0.7)
                                .tint(Color.oxyOnAccent)
                        } else {
                            Image(systemName: "arrow.down.to.line.compact")
                                .font(.system(size: 12, weight: .bold))
                        }
                        Text(isSaving ? "Saving" : "Drop in")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(Color.oxyOnAccent)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .background(Color.oxyStone)
                    .clipShape(Capsule())
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .padding(16)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }
}

private struct MemoryStat: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(Color.oxyText)
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.oxySub)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
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
