import SwiftUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState
    @State private var summary = MemorySummary()
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 20) {
                        // Header icon
                        ZStack {
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [Color.oxyStone.opacity(0.2), Color.oxyStone.opacity(0.05)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .frame(width: 72, height: 72)

                            Image(systemName: "brain.head.profile")
                                .font(.system(size: 32))
                                .foregroundStyle(Color.oxyStone)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)

                        // Info card
                        VStack(alignment: .leading, spacing: 14) {
                            HStack(spacing: 10) {
                                Image(systemName: "brain.head.profile")
                                    .font(.system(size: 18))
                                    .foregroundStyle(Color.oxyStone)
                                Text("Background Memory")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Color.oxyText)
                            }

                            Text("Oxy keeps memory quietly in the background. You do not need to manage a big profile here.")
                                .font(.system(size: 14))
                                .foregroundStyle(Color.oxyText)
                                .lineSpacing(4)

                            Text("If you want something removed, just say things like **\"forget that\"**, **\"delete that from memory\"**, or **\"wipe what you know about X\"** in chat.")
                                .font(.system(size: 13))
                                .foregroundStyle(Color.oxySub)
                                .lineSpacing(4)
                        }
                        .padding(16)
                        .background(Color.oxySurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16)
                                .stroke(Color.oxyLine2, lineWidth: 1)
                        )

                        // Stats
                        if isLoading {
                            HStack {
                                Spacer()
                                ProgressView()
                                    .tint(Color.oxyStone)
                                Spacer()
                            }
                            .padding(.vertical, 20)
                        } else {
                            LazyVGrid(columns: [
                                GridItem(.flexible()),
                                GridItem(.flexible()),
                                GridItem(.flexible())
                            ], spacing: 12) {
                                StatCard(title: "Stored", value: "\(summary.total)", icon: "tray.full.fill")
                                StatCard(title: "Learned", value: "\(summary.learned)", icon: "lightbulb.fill")
                                StatCard(title: "Profile", value: summary.profile ? "Stored" : "None", icon: "person.fill")
                            }

                            // Last updated
                            if let lastUpdated = summary.lastUpdated {
                                HStack(spacing: 6) {
                                    Image(systemName: "clock")
                                        .font(.system(size: 11))
                                    Text("Last updated \(formattedDate(lastUpdated))")
                                        .font(.system(size: 12))
                                }
                                .foregroundStyle(Color.oxyDim)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                            } else {
                                Text("No memory stored yet.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.oxyDim)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 4)
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .task {
                await loadMemory()
            }
            .refreshable {
                await loadMemory()
            }
        }
    }

    private func loadMemory() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/memory/\(appState.userId)"
            )
            let response = try JSONDecoder().decode(MemoryResponse.self, from: data)
            if let s = response.summary {
                summary = s
            }
            isLoading = false
        } catch {
            isLoading = false
        }
    }

    private func formattedDate(_ dateStr: String) -> String {
        let iso = ISO8601DateFormatter()
        guard let date = iso.date(from: dateStr) else { return dateStr }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm · d MMM"
        return fmt.string(from: date)
    }
}

// MARK: - Stat Card

private struct StatCard: View {
    let title: String
    let value: String
    let icon: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(Color.oxyStone)

            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(Color.oxyText)

            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.oxySub)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }
}

// MARK: - Models

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
