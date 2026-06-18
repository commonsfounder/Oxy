import SwiftUI

struct ItineraryView: View {
    @Environment(AppState.self) private var appState
    let trip: TravelSession

    @State private var currentTrip: TravelSession
    @State private var isGenerating = false
    @State private var isModifying = false
    @State private var modifyInstruction = ""
    @State private var showModifySheet = false
    @State private var error: String?

    init(trip: TravelSession) {
        self.trip = trip
        _currentTrip = State(initialValue: trip)
    }

    private var itinerary: TripItinerary? { currentTrip.itinerary }
    private var days: [ItineraryDay] { itinerary?.days ?? [] }

    var body: some View {
        ZStack {
            Color.nmlObsidian.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    tripHeader
                    if let itinerary, !days.isEmpty {
                        itineraryContent(itinerary)
                    } else {
                        emptyState
                    }
                }
                .padding(.bottom, 32)
            }
        }
        .navigationTitle(currentTrip.title ?? currentTrip.requirements?.destination ?? "Trip")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.nmlObsidian, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    showModifySheet = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .foregroundStyle(Color.nmlTitanium)
                }
                .disabled(days.isEmpty || isModifying)
            }
        }
        .sheet(isPresented: $showModifySheet) { modifySheet }
        .overlay(alignment: .bottom) {
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Color.nmlMuted)
                    .padding(12)
                    .background(Color.nmlSurface)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: error)
    }

    // MARK: - Sections

    private var tripHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let req = currentTrip.requirements {
                HStack(spacing: 16) {
                    if let dest = req.destination { infoChip("DEST", dest) }
                    if let date = req.date { infoChip("FROM", date) }
                    if let dur = req.duration { infoChip("NIGHTS", dur) }
                }
                HStack(spacing: 16) {
                    if let budget = req.budget { infoChip("BUDGET", budget) }
                    if let style = req.travelStyle { infoChip("PACE", style.uppercased()) }
                    if let party = req.partySize { infoChip("GUESTS", party) }
                }
            }

            if let budget = itinerary?.estimatedBudget, let total = budget.total {
                HStack(spacing: 4) {
                    Text("EST. TOTAL")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Color.nmlMuted)
                    Text("~£\(Int(total))")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Color.nmlInk)
                    if let note = budget.note {
                        Text("(\(note))")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Color.nmlMuted)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nmlSurface)
        .border(Color.nmlHairline, width: 0.5)
        .padding(.bottom, 1)
    }

    private func itineraryContent(_ itinerary: TripItinerary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(days) { day in
                TripDayCard(day: day)
            }
            if let tips = itinerary.generalTips, !tips.isEmpty {
                tipsSection(tips)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Text("No itinerary yet")
                .font(.system(.callout, weight: .medium))
                .foregroundStyle(Color.nmlInk)
            Text("Generate a day-by-day plan based on your trip requirements.")
                .font(.system(.footnote))
                .foregroundStyle(Color.nmlMuted)
                .multilineTextAlignment(.center)
            Button(action: generateItinerary) {
                if isGenerating {
                    HStack(spacing: 8) {
                        ProgressView()
                            .tint(Color.nmlInk)
                            .scaleEffect(0.8)
                        Text("Generating...")
                            .font(.system(.footnote, weight: .medium))
                            .foregroundStyle(Color.nmlInk)
                    }
                } else {
                    Text("Generate Itinerary")
                        .font(.system(.footnote, weight: .medium))
                        .foregroundStyle(Color.nmlInk)
                }
            }
            .disabled(isGenerating)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Color.nmlSurface)
            .border(Color.nmlHairline, width: 0.5)
        }
        .padding(32)
        .frame(maxWidth: .infinity)
    }

    private func tipsSection(_ tips: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GENERAL TIPS")
                .font(.system(.caption2, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(Color.nmlMuted)
            ForEach(tips, id: \.self) { tip in
                HStack(alignment: .top, spacing: 8) {
                    Text("·")
                        .foregroundStyle(Color.nmlMuted)
                    Text(tip)
                        .font(.system(.footnote))
                        .foregroundStyle(Color.nmlInk)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nmlSurface)
        .border(Color.nmlHairline, width: 0.5)
    }

    private var modifySheet: some View {
        NavigationStack {
            ZStack {
                Color.nmlObsidian.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 20) {
                    Text("Modify Itinerary")
                        .font(.system(.title3, weight: .medium))
                        .foregroundStyle(Color.nmlInk)
                        .padding(.horizontal, 20)

                    Text("Describe what you'd like to change. The AI will modify your existing plan.")
                        .font(.system(.footnote))
                        .foregroundStyle(Color.nmlMuted)
                        .padding(.horizontal, 20)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Examples")
                            .font(.system(.caption2, design: .monospaced))
                            .tracking(1.2)
                            .foregroundStyle(Color.nmlMuted)
                        ForEach(["Make it cheaper", "Add more nightlife", "Replace museums with outdoor activities", "Make it more romantic", "Reduce walking"], id: \.self) { example in
                            Button {
                                modifyInstruction = example
                            } label: {
                                Text(example)
                                    .font(.system(.footnote))
                                    .foregroundStyle(Color.nmlMuted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(Color.nmlSurface)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)

                    TextField("Your modification request...", text: $modifyInstruction, axis: .vertical)
                        .font(.system(.callout))
                        .foregroundStyle(Color.nmlInk)
                        .padding(12)
                        .background(Color.nmlSurface)
                        .border(Color.nmlHairline, width: 0.5)
                        .padding(.horizontal, 20)
                        .lineLimit(3...6)

                    Spacer()
                }
                .padding(.top, 24)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { showModifySheet = false }
                        .foregroundStyle(Color.nmlMuted)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Apply") {
                        showModifySheet = false
                        applyModification()
                    }
                    .disabled(modifyInstruction.trimmingCharacters(in: .whitespaces).isEmpty || isModifying)
                    .foregroundStyle(Color.nmlInk)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Color.nmlObsidian)
    }

    // MARK: - Actions

    private func generateItinerary() {
        let userId = appState.userId
        guard !userId.isEmpty else { return }
        isGenerating = true
        error = nil
        Task {
            do {
                let response = try await TravelService.shared.generateItinerary(userId: userId, tripId: currentTrip.id)
                currentTrip.itinerary = response.itinerary
            } catch {
                self.error = "Failed to generate itinerary. Try again."
            }
            isGenerating = false
        }
    }

    private func applyModification() {
        let userId = appState.userId
        guard !userId.isEmpty, !modifyInstruction.isEmpty else { return }
        isModifying = true
        error = nil
        Task {
            do {
                let response = try await TravelService.shared.modifyItinerary(userId: userId, tripId: currentTrip.id, instruction: modifyInstruction)
                currentTrip.itinerary = response.itinerary
                modifyInstruction = ""
            } catch {
                self.error = "Modification failed. Try again."
            }
            isModifying = false
        }
    }

    // MARK: - Helpers

    private func infoChip(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 9, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(Color.nmlMuted)
            Text(value)
                .font(.system(.caption2, weight: .medium))
                .foregroundStyle(Color.nmlInk)
        }
    }
}
