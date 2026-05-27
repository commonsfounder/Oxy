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
                    VStack(alignment: .leading, spacing: 18) {
                        MemoryHero(summary: summary, isLoading: isLoading)

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Memory Areas")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.oxySub)
                                .textCase(.uppercase)
                                .tracking(0.5)

                            VStack(spacing: 10) {
                                MemoryAreaRow(
                                    icon: "person.crop.circle.fill",
                                    title: "You",
                                    detail: summary.profile ? "Personal profile is active" : "No profile memory yet",
                                    isActive: summary.profile
                                )
                                MemoryAreaRow(
                                    icon: "lightbulb.fill",
                                    title: "Learned facts",
                                    detail: "\(summary.learned) saved from chat",
                                    isActive: summary.learned > 0
                                )
                                MemoryAreaRow(
                                    icon: "location.fill",
                                    title: "Places and routines",
                                    detail: "Tell Oxy your home, work, gym, stations, and usual preferences",
                                    isActive: summary.total > 0
                                )
                            }
                        }

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Controls")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.oxySub)
                                .textCase(.uppercase)
                                .tracking(0.5)

                            MemoryCommandCard(
                                icon: "plus.circle.fill",
                                title: "Teach naturally",
                                detail: "Say \"remember my usual station is Birmingham International\"."
                            )
                            MemoryCommandCard(
                                icon: "pencil.circle.fill",
                                title: "Correct it fast",
                                detail: "Say \"not that one, remember the McDonald's by me is the nearby one\"."
                            )
                            MemoryCommandCard(
                                icon: "trash.circle.fill",
                                title: "Forget anything",
                                detail: "Say \"forget that\", \"delete my gym\", or \"wipe what you know about X\"."
                            )
                        }

                        if let lastUpdated = summary.lastUpdated {
                            Text("Last updated \(formattedDate(lastUpdated))")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.oxyDim)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 4)
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
            let data = try await APIClient.shared.request(path: "/memory/\(appState.userId)")
            let response = try JSONDecoder().decode(MemoryResponse.self, from: data)
            if let s = response.summary {
                summary = s
            }
        } catch {
            summary = MemorySummary()
        }
        isLoading = false
    }

    private func formattedDate(_ dateStr: String) -> String {
        let iso = ISO8601DateFormatter()
        guard let date = iso.date(from: dateStr) else { return dateStr }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm - d MMM"
        return fmt.string(from: date)
    }
}

private struct MemoryHero: View {
    let summary: MemorySummary
    let isLoading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(Color.oxyStone.opacity(0.14))
                        .frame(width: 52, height: 52)
                    Image(systemName: "sparkles")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Color.oxyStone)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("Oxy remembers quietly")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Color.oxyText)
                    Text("Useful facts live in the background, and chat is the control surface.")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.oxySub)
                        .lineSpacing(3)
                }
            }

            HStack(spacing: 10) {
                MemoryPill(title: "Saved", value: isLoading ? "..." : "\(summary.total)")
                MemoryPill(title: "Learned", value: isLoading ? "..." : "\(summary.learned)")
                MemoryPill(title: "Profile", value: summary.profile ? "On" : "Off")
            }
        }
        .padding(18)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(
            RoundedRectangle(cornerRadius: 22)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }
}

private struct MemoryPill: View {
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
        .background(Color.oxySurface1)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct MemoryAreaRow: View {
    let icon: String
    let title: String
    let detail: String
    let isActive: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isActive ? Color.oxyStone : Color.oxyDim)
                .frame(width: 30, height: 30)
                .background((isActive ? Color.oxyStone : Color.oxySurface3).opacity(isActive ? 0.14 : 1))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.oxyText)
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .lineSpacing(2)
            }

            Spacer()
        }
        .padding(14)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.oxyLine2, lineWidth: 1)
        )
    }
}

private struct MemoryCommandCard: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.oxyStone)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.oxyText)
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.oxySub)
                    .lineSpacing(3)
            }
            Spacer()
        }
        .padding(14)
        .background(Color.oxySurface2)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
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
