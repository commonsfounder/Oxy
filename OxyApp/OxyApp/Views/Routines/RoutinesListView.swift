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
    @State private var draftRepeat: RepeatOption = .off
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
                                                .font(.appBody(AppText.body))
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
                                Text("No routines yet.")
                                    .font(.appBody(AppText.body))
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

            Picker("Repeat", selection: $draftRepeat) {
                ForEach(RepeatOption.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)

            HStack {
                if let saveMessage {
                    Text(saveMessage)
                        .font(.appBody(AppText.caption, weight: .medium))
                        .foregroundStyle(Color.mgDestructive)
                }
                Spacer()
                Button {
                    HapticManager.shared.impact(.light)
                    withAnimation(.appStandard) { composerExpanded = false }
                    draftName = ""
                    draftPrompt = ""
                    draftRepeat = .off
                } label: {
                    Text("Cancel")
                        .font(.appBody(AppText.caption, weight: .semibold))
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
                            .font(.appBody(AppText.caption, weight: .semibold))
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
            _ = try await RoutinesService.createRoutine(name: name, prompt: prompt, intervalMinutes: draftRepeat.minutes)
            await MainActor.run {
                HapticManager.shared.success()
                draftName = ""
                draftPrompt = ""
                draftRepeat = .off
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

/// Server floor is 60 (see ROUTINE_MIN_INTERVAL_MINUTES in api/index.js) — options here stay
/// at or above it so every choice the picker offers is always accepted.
private enum RepeatOption: CaseIterable, Identifiable {
    case off, daily, weekly

    var id: Self { self }

    var label: String {
        switch self {
        case .off: return "Once"
        case .daily: return "Daily"
        case .weekly: return "Weekly"
        }
    }

    var minutes: Int? {
        switch self {
        case .off: return nil
        case .daily: return 24 * 60
        case .weekly: return 7 * 24 * 60
        }
    }
}

private struct RoutineRow: View {
    let routine: Routine

    private var cadenceLabel: String? {
        guard let minutes = routine.intervalMinutes else { return nil }
        if minutes % (7 * 24 * 60) == 0 { return "Weekly" }
        if minutes % (24 * 60) == 0 { return "Daily" }
        return "Every \(minutes)m"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(routine.name)
                    .font(.appBody(AppText.body))
                    .foregroundStyle(routine.isEnabled ? Color.mgHeading : Color.mgSecondary)
                    .lineLimit(1)
                // An imported routine that isn't running must never read as if it is — the
                // original is still live wherever it came from.
                if !routine.isEnabled {
                    Text(routine.isImported ? "Off · imported" : "Off")
                        .font(.appBody(AppText.micro, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Color.mgSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.mgSecondary.opacity(0.12), in: Capsule())
                } else if routine.isFailing {
                    Text("Failing")
                        .font(.appBody(AppText.micro, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Color.mgDestructive)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.mgDestructive.opacity(0.12), in: Capsule())
                } else if let cadenceLabel {
                    Text(cadenceLabel)
                        .font(.appBody(AppText.micro, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Color.mgSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.mgSecondary.opacity(0.12), in: Capsule())
                }
            }
            Text(routine.prompt)
                .font(.appBody(AppText.caption))
                .foregroundStyle(Color.mgSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if routine.isFailing, let lastRunError = routine.lastRunError, !lastRunError.isEmpty {
                Text(lastRunError)
                    .font(.appBody(AppText.micro))
                    .foregroundStyle(Color.mgDestructive)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#Preview {
    RoutinesListView()
}
