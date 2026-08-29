import SwiftUI

struct ModelRoutingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: ModelRoutingSnapshot?
    @State private var selectedProvider = "openai"
    @State private var selectedModel = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            GlebChrome.pastelBlob.ignoresSafeArea()
            VStack(spacing: 0) {
                ScreenHeaderView(title: "AI choices", onBack: { dismiss() })
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let snapshot {
                            activeCard(snapshot)
                            routeEditor(snapshot)
                            providerList(snapshot.providers)
                        } else if isLoading {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 50)
                        } else if let errorMessage {
                            errorState(errorMessage)
                        }
                    }
                    .padding(.horizontal, AppSpacing.margin)
                    .padding(.top, 16)
                    .padding(.bottom, 40)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
    }

    private func activeCard(_ snapshot: ModelRoutingSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AppIcon("sparkles", size: 16).foregroundStyle(Color.appAccent)
                Text("Millie's AI")
                    .font(.appDisplay(AppText.title, weight: .semibold))
                    .foregroundStyle(Color.mgHeading)
            }
            Text(providerName(snapshot.active.provider))
                .font(.appBody(AppText.body, weight: .medium))
                .foregroundStyle(Color.mgHeading)
            if !snapshot.selected.configured {
                Text("This choice is not set up yet.")
                    .font(.appBody(AppText.caption))
                    .foregroundStyle(Color.mgSecondary)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MissionGlassPlate())
    }

    private func routeEditor(_ snapshot: ModelRoutingSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            AppSectionTitle("Choose Millie's AI")
            Picker("Provider", selection: $selectedProvider) {
                ForEach(snapshot.providers) { provider in
                    Text(provider.name).tag(provider.id)
                }
            }
            .pickerStyle(.menu)
            .tint(Color.appAccent)
            Button {
                Task { await save() }
            } label: {
                HStack {
                    Text(isSaving ? "Saving…" : "Use \(providerName(selectedProvider))")
                    Spacer()
                    AppIcon("arrow-up-right", size: 13)
                }
                .font(.appBody(AppText.body, weight: .semibold))
                .foregroundStyle(Color.appInk)
                .padding(.vertical, 16)
                .padding(.horizontal, 16)
                .background(Color.appAccent, in: Capsule())
            }
            .buttonStyle(.appScale(0.98))
            .disabled(isSaving)
        }
        .padding(18)
        .background(MissionGlassPlate())
    }

    private func providerList(_ providers: [ModelProvider]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            AppSectionTitle("Available AI")
            ForEach(providers) { provider in
                HStack(spacing: 12) {
                    AppIcon(provider.configured ? "bolt" : "dotted", size: 14)
                        .foregroundStyle(provider.configured ? Color.appAccent : Color.mgSecondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.name).font(.appBody(AppText.body, weight: .semibold))
                        Text(provider.configured ? "Ready" : "Not set up")
                            .font(.appBody(AppText.caption))
                            .foregroundStyle(Color.mgSecondary)
                    }
                    Spacer()
                    if provider.id == selectedProvider {
                        Text("In use")
                            .font(.appBody(AppText.micro, weight: .semibold))
                            .foregroundStyle(Color.appAccent)
                    }
                }
                .padding(.vertical, 12)
            }
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("AI choices unavailable").font(.appDisplay(AppText.title, weight: .semibold))
            Text(message).font(.appBody(AppText.footnote)).foregroundStyle(Color.mgSecondary)
            Button("Try again") { Task { await load() } }
                .font(.appBody(AppText.body, weight: .semibold))
        }
        .foregroundStyle(Color.mgHeading)
        .padding(.top, 40)
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
            errorMessage = "Could not load AI choices."
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
            errorMessage = "Could not save that choice."
        }
        isSaving = false
    }
}
