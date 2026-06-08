import SwiftUI

/// Account identity in the Nameless language — pitch black, flat rows split by
/// 0.5px rules. The assistant name is editable inline; the account id is shown
/// read-only in monospace.
struct ProfileView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var settings = OxySettings()

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        HStack {
                            Text("Assistant Name")
                                .font(.system(size: 15, weight: .regular))
                                .foregroundStyle(Color.nmlInk)
                            Spacer(minLength: 16)
                            TextField("Nameless", text: $settings.name)
                                .font(.system(size: 15, weight: .light))
                                .foregroundStyle(Color.nmlInk)
                                .tint(Color.nmlTitanium)
                                .multilineTextAlignment(.trailing)
                                .onChange(of: settings.name) { _, _ in saveSettings() }
                        }
                        .padding(.vertical, 22)

                        NamelessDivider()

                        identityRow(label: "User ID", value: appState.userId)

                        NamelessDivider()

                        identityRow(label: "Status", value: "Active")
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                }
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Text("Back")
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(Color.nmlMuted)
                    }
                }
            }
            .onAppear(perform: loadSettings)
        }
    }

    private func identityRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Color.nmlInk)
            Spacer(minLength: 16)
            Text(value)
                .font(.nmlMono(12))
                .foregroundStyle(Color.nmlMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 22)
    }

    private func loadSettings() {
        if let data = UserDefaults.standard.data(forKey: "oxy_settings"),
           let saved = try? JSONDecoder().decode(OxySettings.self, from: data) {
            settings = saved
        }
    }

    private func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "oxy_settings")
        }
    }
}

#Preview {
    ProfileView()
        .environment(AppState())
}
