import SwiftUI

struct ModelRoutingView: View {
    @State private var snapshot: ModelRoutingSnapshot?
    @State private var selectedProvider = "openai"
    @State private var selectedModel = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        SettingsPage(title: "Advanced") {
            if let errorMessage {
                ErrorBanner(message: errorMessage, onRetry: { Task { await load() } })
            }
            if let snapshot {
                currentModel(snapshot)
                changeModel(snapshot)
                availableModels(snapshot.providers)
            } else if isLoading {
                OxySkeletonCard(height: 120, cornerRadius: 16)
            }
            Text("Version adam-0001-alpha")
                .font(.appBody(11))
                .foregroundStyle(Color.appMuted.opacity(0.7))
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
        }
        .task { await load() }
    }

    private func currentModel(_ snapshot: ModelRoutingSnapshot) -> some View {
        SettingsGroup(title: "Current model") {
            SettingsList {
                SettingsRow(
                    title: providerName(snapshot.active.provider),
                    subtitle: snapshot.selected.configured ? nil : "Not set up yet",
                    lead: .dot(solid: snapshot.selected.configured)
                )
            }
        }
    }

    private func changeModel(_ snapshot: ModelRoutingSnapshot) -> some View {
        SettingsGroup(title: "Change model") {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Provider", selection: $selectedProvider) {
                    ForEach(snapshot.providers) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .pickerStyle(.menu)
                .tint(Color.appAccent)
                Button {
                    HapticManager.shared.impact(.light)
                    Task { await save() }
                } label: {
                    Text(isSaving ? "Saving…" : "Use \(providerName(selectedProvider))")
                        .font(.appBody(15, weight: .medium))
                        .foregroundStyle(Color.appOnAction)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Color.appAction))
                }
                .buttonStyle(.appScale(0.97))
                .disabled(isSaving)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .settingsSurface()
        }
    }

    private func availableModels(_ providers: [ModelProvider]) -> some View {
        SettingsGroup(title: "Available models") {
            SettingsList {
                ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { SettingsRule() }
                    SettingsRow(
                        title: provider.name,
                        subtitle: provider.configured ? "Ready" : "Not set up",
                        lead: .dot(solid: provider.configured)
                    ) {
                        if provider.id == selectedProvider {
                            Text("In use")
                                .font(.appBody(13, weight: .medium))
                                .foregroundStyle(Color.appAccent)
                        }
                    }
                }
            }
        }
    }

    private func selectedDefaultModel(_ snapshot: ModelRoutingSnapshot) -> String {
        snapshot.providers.first(where: { $0.id == selectedProvider })?.defaultModel ?? "Model name"
    }

    private func providerName(_ id: String) -> String {
        snapshot?.providers.first(where: { $0.id == id })?.name ?? id.capitalized
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let loaded = try await ModelRoutingService.fetch()
            snapshot = loaded
            selectedProvider = loaded.selected.provider
            selectedModel = loaded.selected.model
        } catch {
            errorMessage = "Couldn't load your choices."
        }
        isLoading = false
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        do {
            snapshot = try await ModelRoutingService.save(
                provider: selectedProvider,
                model: ""
            )
        } catch {
            errorMessage = "Couldn't save that choice."
        }
        isSaving = false
    }
}
