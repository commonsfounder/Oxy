import SwiftUI

struct HistoryView: View {
    @Environment(AppState.self) private var appState
    @State private var actions: [ActionLogEntry] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Color.oxyBg.ignoresSafeArea()

                if isLoading {
                    ProgressView()
                        .tint(Color.oxyStone)
                } else if actions.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock")
                            .font(.system(size: 40))
                            .foregroundStyle(Color.oxyDim)
                        Text("No actions yet")
                            .font(.system(size: 15))
                            .foregroundStyle(Color.oxySub)
                        Text("Actions Oxy takes on your behalf\nwill appear here.")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.oxyDim)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(actions) { action in
                                ActionRow(action: action)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 10)

                                if action.id != actions.last?.id {
                                    Divider()
                                        .overlay(Color.oxyLine)
                                        .padding(.leading, 60)
                                }
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.oxySurface1, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .task {
                await loadActions()
            }
            .refreshable {
                await loadActions()
            }
        }
    }

    private func loadActions() async {
        do {
            let data = try await APIClient.shared.request(
                path: "/action-log/\(appState.userId)"
            )
            let response = try JSONDecoder().decode(ActionLogResponse.self, from: data)
            actions = response.actions
            isLoading = false
        } catch {
            isLoading = false
        }
    }
}

// MARK: - Action Row

private struct ActionRow: View {
    let action: ActionLogEntry

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(statusColor.opacity(0.15))
                    .frame(width: 36, height: 36)

                Image(systemName: iconForStatus)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(statusColor)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(action.formattedAction)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.oxyText)

                Text(action.formattedTime)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.oxyDim)
            }

            Spacer()

            Text(action.status.capitalized)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(statusColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(statusColor.opacity(0.12))
                .clipShape(Capsule())
        }
    }

    private var statusColor: Color {
        switch action.status {
        case "success", "executed": return Color.oxyGreen
        case "error", "failed": return Color.oxyRed
        default: return Color.oxySub
        }
    }

    private var iconForStatus: String {
        switch action.status {
        case "success", "executed": return "checkmark"
        case "error", "failed": return "xmark"
        default: return "ellipsis"
        }
    }
}

// MARK: - Models

struct ActionLogEntry: Codable, Identifiable {
    let id: String?
    let action: ActionValue
    let status: String
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case action
        case status
        case createdAt = "created_at"
    }

    var stableId: String { id ?? UUID().uuidString }

    var formattedAction: String {
        switch action {
        case .string(let s):
            if let data = s.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let type = obj["type"] as? String {
                return type == "shortcut"
                    ? (obj["name"] as? String ?? "Shortcut")
                    : humanize(type)
            }
            return humanize(s)
        case .object(let obj):
            if obj.type == "shortcut" { return obj.name ?? "Shortcut" }
            return humanize(obj.type ?? "unknown")
        }
    }

    var formattedTime: String {
        guard let date = Date.oxyParse(createdAt) else {
            return ""
        }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm · d MMM"
        return fmt.string(from: date)
    }

    private func humanize(_ s: String) -> String {
        s.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

enum ActionValue: Codable {
    case string(String)
    case object(ActionObject)

    struct ActionObject: Codable {
        let type: String?
        let name: String?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let obj = try? container.decode(ActionObject.self) {
            self = .object(obj)
        } else {
            self = .string("unknown")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .object(let obj): try container.encode(obj)
        }
    }
}

struct ActionLogResponse: Codable {
    let actions: [ActionLogEntry]
}

#Preview {
    HistoryView()
        .environment(AppState())
}
