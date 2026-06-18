import SwiftUI

struct TripsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var trips: [TravelSession] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var showDeleteConfirm: TravelSession?

    var body: some View {
        ZStack {
            Color.nmlObsidian.ignoresSafeArea()
            if isLoading && trips.isEmpty {
                ProgressView()
                    .tint(Color.nmlTitanium)
            } else if trips.isEmpty {
                emptyState
            } else {
                tripList
            }
        }
        .navigationTitle("Trips")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.nmlObsidian, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    HapticManager.shared.impact(.light)
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.nmlTitanium)
                }
                .accessibilityLabel("Back")
            }
        }
        .task { await loadTrips() }
        .refreshable { await loadTrips() }
        .alert("Delete Trip?", isPresented: Binding(
            get: { showDeleteConfirm != nil },
            set: { if !$0 { showDeleteConfirm = nil } }
        )) {
            Button("Delete", role: .destructive) {
                if let trip = showDeleteConfirm { deleteTrip(trip) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let trip = showDeleteConfirm {
                Text("\(trip.title ?? trip.requirements?.destination ?? "Trip") will be permanently deleted.")
            }
        }
    }

    // MARK: - Views

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "airplane.departure")
                .font(.system(size: 36, weight: .ultraLight))
                .foregroundStyle(Color.nmlMuted)
            Text("No trips yet")
                .font(.system(.callout, weight: .medium))
                .foregroundStyle(Color.nmlInk)
            Text("Start a conversation with the assistant to plan your next trip.")
                .font(.system(.footnote))
                .foregroundStyle(Color.nmlMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var tripList: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Group by status
                let planning  = trips.filter { $0.status == .planning }
                let confirmed = trips.filter { $0.status == .confirmed || $0.status == .inProgress }
                let completed = trips.filter { $0.status == .completed }

                if !confirmed.isEmpty {
                    sectionHeader("UPCOMING")
                    ForEach(confirmed) { trip in tripRow(trip) }
                }
                if !planning.isEmpty {
                    sectionHeader(confirmed.isEmpty ? "PLANNING" : "IN PLANNING")
                    ForEach(planning) { trip in tripRow(trip) }
                }
                if !completed.isEmpty {
                    sectionHeader("PAST")
                    ForEach(completed) { trip in tripRow(trip) }
                }
            }
            .padding(.bottom, 32)
        }
    }

    private func tripRow(_ trip: TravelSession) -> some View {
        NavigationLink(destination: ItineraryView(trip: trip)) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(trip.title ?? trip.requirements?.destination ?? "Untitled Trip")
                        .font(.system(.callout, weight: .medium))
                        .foregroundStyle(Color.nmlInk)
                        .lineLimit(1)

                    HStack(spacing: 10) {
                        if let dest = trip.requirements?.destination {
                            tripMeta(dest)
                        }
                        if let date = trip.requirements?.date {
                            tripMeta(date)
                        }
                        if let dur = trip.requirements?.duration {
                            tripMeta(dur + " nights")
                        }
                    }
                }
                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    statusBadge(trip.status)
                    if trip.itinerary?.days?.isEmpty == false {
                        Text("\(trip.itinerary?.totalDays ?? trip.itinerary?.days?.count ?? 0)d plan")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Color.nmlMuted)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.nmlMuted)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .background(Color.nmlObsidian)
            .contextMenu {
                Button(role: .destructive) {
                    showDeleteConfirm = trip
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Divider().background(Color.nmlHairline)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(.caption2, design: .monospaced))
            .tracking(1.2)
            .foregroundStyle(Color.nmlMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 8)
    }

    private func tripMeta(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption2))
            .foregroundStyle(Color.nmlMuted)
    }

    private func statusBadge(_ status: TripStatus) -> some View {
        Text(status.label)
            .font(.system(size: 9, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(status == .confirmed || status == .inProgress ? Color.nmlLive : Color.nmlMuted)
    }

    // MARK: - Actions

    private func loadTrips() async {
        let userId = appState.userId
        guard !userId.isEmpty else { return }
        isLoading = true
        do {
            trips = try await TravelService.shared.listTrips(userId: userId)
        } catch {
            self.error = "Failed to load trips."
        }
        isLoading = false
    }

    private func deleteTrip(_ trip: TravelSession) {
        let userId = appState.userId
        guard !userId.isEmpty else { return }
        Task {
            do {
                try await TravelService.shared.deleteTrip(userId: userId, tripId: trip.id)
                trips.removeAll { $0.id == trip.id }
            } catch {}
        }
    }
}
