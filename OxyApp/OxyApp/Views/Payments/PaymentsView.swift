import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.revealClose) private var revealClose
    private func dismiss() { if let revealClose { revealClose() } else { systemDismiss() } }

    @State private var balance: Double?
    @State private var card: LinkedCard?
    @State private var agentCard: AgentCardSummary?
    @State private var showAgentCardSheet = false
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var agentCardLoaded = false
    @State private var errorMessage: String?
    @State private var confirmRemove = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Payment methods", onBack: revealClose == nil ? { dismiss() } : nil)

                    if isLoading {
                        VStack(spacing: 12) {
                            OxySkeletonCard(height: 92)
                            OxySkeletonCard(height: 92)
                        }
                        .padding(.horizontal, AppSpacing.margin)
                        .padding(.top, 16)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 28) {
                                if let errorMessage {
                                    ErrorBanner(message: errorMessage, onRetry: { Task { await loadPayments() } })
                                        .disabled(isRefreshing)
                                }
                                if agentCardLoaded || agentCard != nil { agentCardSection }
                                if card != nil || balance != nil { otherSection }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await loadPayments()
                #if DEBUG
                if PreviewData.isIsolated, ProcessInfo.processInfo.environment["OXY_DEBUG_PAYMENT_FORM"] == "1" {
                    try? await Task.sleep(for: .milliseconds(400))
                    showAgentCardSheet = true
                }
                #endif
            }
            .refreshable { await loadPayments() }
            .confirmationDialog("Remove this card?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await removeAgentCard() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Adam won't be able to check out until you add another.")
            }
            .sheet(isPresented: $showAgentCardSheet) {
                AgentCardEntrySheet { saved in
                    agentCard = saved
                    agentCardLoaded = true
                }
            }
        }
    }

    // MARK: - Sections

    private var agentCardSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let agentCard {
                if !agentCardLoaded {
                    Text("Last loaded card").font(.appBody(14)).foregroundStyle(Color.appMuted)
                }
                VStack(alignment: .leading, spacing: 28) {
                    let layout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                    layout {
                        Text("Card for checkout")
                            .font(.appBody(14, weight: .medium))
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                        Text(agentCard.brand.capitalized)
                            .font(.appBody(17, weight: .semibold))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Ending in").font(.appBody(14)).foregroundStyle(Color.appMuted)
                        Text(agentCard.last4)
                            .font(.title.monospaced().weight(.medium))
                            .accessibilityLabel("Card ending in \(agentCard.last4)")
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(agentCard.name).font(.appBody(16, weight: .medium))
                        Text(agentCardSubtitle).font(.appBody(14))
                            .foregroundStyle(Color.appMuted)
                    }
                }
                .foregroundStyle(Color.appInk)
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.appSurface2, in: RoundedRectangle(cornerRadius: 16))
                cardButton
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("No checkout card")
                        .font(.appBody(20, weight: .semibold))
                        .foregroundStyle(Color.appInk)
                    Text("Add a card for checkouts you approve.")
                        .font(.appBody(15))
                        .foregroundStyle(Color.appMuted)
                    cardButton
                }
                .padding(.vertical, 8)
            }
            SettingsStatement(text: "Adam asks before every payment.", solid: false, icon: "shield-check")
        }
    }

    private var cardButton: some View {
        Button {
            HapticManager.shared.impact(.light)
            if agentCard == nil { showAgentCardSheet = true } else { confirmRemove = true }
        } label: {
            Text(agentCard == nil ? "Add a card" : "Remove card")
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(agentCard == nil ? Color.appOnAction : Color.appDestructive)
                .padding(.horizontal, agentCard == nil ? 16 : 8)
                .frame(minHeight: 44)
                .background { if agentCard == nil { Capsule().fill(Color.appAction) } }
        }
        .buttonStyle(.appScale(0.96))
        .disabled(!agentCardLoaded || isRefreshing)
        .accessibilityLabel(agentCard == nil ? "Add a checkout card" : "Remove checkout card")
    }

    private var otherSection: some View {
        SettingsGroup(title: "Other") {
            SettingsList {
                if card != nil {
                    SettingsRow(title: cardTitle, subtitle: "Linked card")
                }
                if card != nil, balance != nil { SettingsRule() }
                if balance != nil {
                    SettingsRow(title: formattedBalance, subtitle: "Balance")
                }
            }
        }
    }

    private var agentCardSubtitle: String {
        guard let agentCard else {
            return "For checkouts you approve"
        }
        return "Expires \(String(format: "%02d", agentCard.expMonth))/\(String(agentCard.expYear % 100))"
    }

    private var formattedBalance: String {
        balance.map { String(format: "%.2f", $0) } ?? "Unavailable"
    }

    private var cardTitle: String {
        guard let card else { return "No card linked" }
        return "\(card.brand.capitalized) •••• \(card.last4)"
    }

    // MARK: - Networking

    private func loadPayments() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        async let cardResult = fetch(CardResponse.self, path: "/connectors/stripe/card")
        async let balanceResult = fetch(BalanceResponse.self, path: "/concierge/balance")
        async let agentCardResult = fetch(AgentCardResponse.self, path: "/connectors/agent-card")
        let results = await (cardResult, balanceResult, agentCardResult)
        await MainActor.run {
            var failures: [String] = []
            switch results.0 {
            case .success(let response): card = response.card
            case .failure: failures.append("linked card")
            }
            switch results.1 {
            case .success(let response): balance = response.balance
            case .failure: failures.append("balance")
            }
            switch results.2 {
            case .success(let response):
                agentCard = response.card
                agentCardLoaded = true
            case .failure:
                agentCardLoaded = false
                failures.append("checkout card")
            }
            errorMessage = failures.isEmpty ? nil : failures.count == 3
                ? "Couldn't load payment methods."
                : "Couldn't load your " + failures.joined(separator: " and ") + "."
            isLoading = false
            isRefreshing = false
        }
    }

    private func fetch<Response: Decodable>(_ type: Response.Type, path: String) async -> Result<Response, Error> {
        do {
            let data = try await APIClient.shared.request(path: path)
            return .success(try JSONDecoder().decode(type, from: data))
        } catch {
            return .failure(error)
        }
    }

    private func removeAgentCard() async {
        do {
            _ = try await APIClient.shared.request(path: "/connectors/agent-card", method: "DELETE")
            await MainActor.run { agentCard = nil }
        } catch {
            await MainActor.run { errorMessage = "Couldn't remove the card. Try again." }
        }
    }


}

// MARK: - Agent card entry

// Plain-text card entry posted straight to the authed backend route — no payment-SDK
// dependency. The number/CVC never persist on device; the response is the masked summary.
private struct AgentCardEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    let onSaved: (AgentCardSummary) -> Void

    @State private var name = ""
    @State private var number = ""
    @State private var expiry = ""   // MM/YY
    @State private var cvc = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if appState.isDemoSession { Text("Sample").font(.caption).foregroundStyle(Color.appMuted) }
                    TextField("Name on card", text: $name, prompt: Text("Name on card").foregroundStyle(Color.appMuted))
                        .textContentType(.name)
                    TextField("Card number", text: $number, prompt: Text("Card number").foregroundStyle(Color.appMuted))
                        .keyboardType(.numberPad)
                        .textContentType(.creditCardNumber)
                        .onChange(of: number) { _, new in
                            number = Self.formatCardNumber(new)
                        }
                    TextField("Expiry (MM/YY)", text: $expiry, prompt: Text("Expiry (MM/YY)").foregroundStyle(Color.appMuted))
                        .keyboardType(.numberPad)
                        .onChange(of: expiry) { _, new in
                            expiry = Self.formatExpiry(new)
                        }
                    SecureField("Security code", text: $cvc, prompt: Text("Security code").foregroundStyle(Color.appMuted))
                        .keyboardType(.numberPad)
                        .onChange(of: cvc) { _, new in
                            cvc = String(new.filter(\.isNumber).prefix(4))
                        }
                } footer: {
                    Text("Encrypted. Used only after you approve the total.").foregroundStyle(Color.appMuted)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(Color.appDestructive) }
                }
            }
            .navigationTitle("Card for checkout")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!isFormPlausible)
                    }
                }
            }
        }
    }

    private var isFormPlausible: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && number.filter(\.isNumber).count >= 12
            && expiry.count == 5
            && cvc.count >= 3
    }

    private func save() async {
        let parts = expiry.split(separator: "/")
        guard parts.count == 2, let month = Int(parts[0]), let year = Int(parts[1]) else {
            errorMessage = "Expiry must be MM/YY."
            return
        }
        isSaving = true
        errorMessage = nil
        do {
            let data = try await APIClient.shared.request(
                path: "/connectors/agent-card",
                method: "POST",
                body: [
                    "name": name.trimmingCharacters(in: .whitespaces),
                    "number": number.filter(\.isNumber),
                    "expMonth": month,
                    "expYear": year,
                    "cvc": cvc
                ]
            )
            let response = try JSONDecoder().decode(AgentCardSaveResponse.self, from: data)
            if let saved = response.card {
                onSaved(saved)
                dismiss()
            } else {
                errorMessage = "The card couldn't be saved."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }

    private static func formatCardNumber(_ raw: String) -> String {
        let digits = String(raw.filter(\.isNumber).prefix(19))
        return digits.enumerated().map { i, c in
            i > 0 && i % 4 == 0 ? " \(c)" : String(c)
        }.joined()
    }

    private static func formatExpiry(_ raw: String) -> String {
        let digits = String(raw.filter(\.isNumber).prefix(4))
        if digits.count <= 2 { return digits }
        return "\(digits.prefix(2))/\(digits.dropFirst(2))"
    }
}

// MARK: - Models

struct LinkedCard: Codable, Equatable {
    let customerId: String
    let paymentMethodId: String
    let brand: String
    let last4: String
}

private struct CardResponse: Codable {
    let card: LinkedCard?
}

struct AgentCardSummary: Codable, Equatable {
    let brand: String
    let last4: String
    let expMonth: Int
    let expYear: Int
    let name: String
}

private struct AgentCardResponse: Codable {
    let card: AgentCardSummary?
}

private struct AgentCardSaveResponse: Codable {
    let saved: Bool
    let card: AgentCardSummary?
}

private struct BalanceResponse: Codable {
    let balance: Double?
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
