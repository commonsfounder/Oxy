import SwiftUI

/// A user-saved list of routines (name + prompt), reachable from More → Routines.
/// Mirrors MemoryView's List/swipe-to-delete conventions: a real SwiftUI `List`
/// (not a hand-rolled ScrollView — that rendered a visible red sliver behind rows),
/// with a collapsed-line composer that expands on tap.
struct RoutinesListView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var routines: [Routine] = []
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var composerExpanded = false
    @State private var draftName = ""
    @State private var draftPrompt = ""
    @State private var saveMessage: String?
    @State private var pendingDeleteRoutine: Routine?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Routines", onBack: { dismiss() })

                    List {
                        Group {
                            VStack(alignment: .leading, spacing: 20) {
                                if composerExpanded {
                                    MilgrainSectionHeader(title: "New Routine")
                                    composer
                                } else {
                                    Button {
                                        HapticManager.shared.impact(.light)
                                        saveMessage = nil
                                        withAnimation(.appStandard) { composerExpanded = true }
                                    } label: {
                                        HStack(spacing: 12) {
                                            AppIcon("plus", size: 14)
                                                .foregroundStyle(Color.mgSecondary)
                                            Text("Add a routine…")
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

                            MilgrainSectionHeader(title: "Saved Routines")
                                .padding(.bottom, 12)

                            if isLoading {
                                ForEach(0..<3, id: \.self) { _ in
                                    OxySkeletonCard(height: 44, cornerRadius: 0)
                                    MilgrainDivider()
                                }
                            } else if routines.isEmpty {
                                Text("No routines saved yet. Add a name and a prompt above and it'll be ready to run again later.")
                                    .font(.appBody(14))
                                    .foregroundStyle(Color.mgSecondary)
                                    .padding(.vertical, 20)
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)

                        ForEach(routines) { routine in
                            RoutineRow(routine: routine)
                                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 0))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        pendingDeleteRoutine = routine
                                    } label: {
                                        Label { Text("Delete") } icon: { AppIcon("trash", size: 16) }
                                    }
                                    .tint(Color.mgDestructive)
                                }

                            MilgrainDivider()
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
            .task { await loadRoutines() }
            .refreshable { await loadRoutines() }
            .alert(
                "Delete this routine?",
                isPresented: Binding(get: { pendingDeleteRoutine != nil }, set: { if !$0 { pendingDeleteRoutine = nil } }),
                presenting: pendingDeleteRoutine
            ) { routine in
                Button("Delete", role: .destructive) { Task { await delete(routine) } }
                Button("Cancel", role: .cancel) {}
            } message: { routine in
                Text(routine.name)
            }
        }
    }

    private var canSave: Bool {
        !draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSaving
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 14) {
            AppLineField(placeholder: "Name", text: $draftName)
            AppLineField(placeholder: "Prompt", text: $draftPrompt, axis: .vertical, lineLimit: 2...5)

            HStack {
                if let saveMessage {
                    Text(saveMessage)
                        .font(.appBody(12, weight: .medium))
                        .foregroundStyle(Color.mgDestructive)
                }
                Spacer()
                Button {
                    HapticManager.shared.impact(.light)
                    withAnimation(.appStandard) { composerExpanded = false }
                    draftName = ""
                    draftPrompt = ""
                } label: {
                    Text("Cancel")
                        .font(.appBody(12, weight: .semibold))
                        .foregroundStyle(Color.mgSecondary)
                }
                .buttonStyle(.appScale)

                Button {
                    Task { await saveRoutine() }
                } label: {
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

    private func loadRoutines() async {
        await MainActor.run { isLoading = true }
        do {
            let fetched = try await RoutinesService.fetchRoutines()
            await MainActor.run {
                routines = fetched
                isLoading = false
            }
        } catch {
            await MainActor.run {
                routines = []
                isLoading = false
            }
        }
    }

    private func saveRoutine() async {
        let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !prompt.isEmpty, !isSaving else { return }
        await MainActor.run { isSaving = true; saveMessage = nil }
        do {
            _ = try await RoutinesService.createRoutine(name: name, prompt: prompt)
            await MainActor.run {
                HapticManager.shared.success()
                draftName = ""
                draftPrompt = ""
                isSaving = false
                withAnimation(.appStandard) { composerExpanded = false }
            }
            await loadRoutines()
        } catch {
            await MainActor.run {
                saveMessage = "Could not save that."
                isSaving = false
            }
        }
    }

    private func delete(_ routine: Routine) async {
        HapticManager.shared.impact(.light)
        await MainActor.run { withAnimation(.appStandard) { routines.removeAll { $0.id == routine.id } } }
        do {
            try await RoutinesService.deleteRoutine(id: routine.id)
        } catch {
            await loadRoutines() // restore on failure
        }
    }
}

private struct RoutineRow: View {
    let routine: Routine

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(routine.name)
                .font(.appBody(15))
                .foregroundStyle(Color.mgHeading)
                .lineLimit(1)
            Text(routine.prompt)
                .font(.appBody(12))
                .foregroundStyle(Color.mgSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#Preview {
    RoutinesListView()
}
