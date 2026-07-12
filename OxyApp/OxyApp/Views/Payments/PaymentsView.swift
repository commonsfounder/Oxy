import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var balance: Double = 0
    @State private var card: LinkedCard?
    @State private var agentCard: AgentCardSummary?
    @State private var showAgentCardSheet = false
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Payments", onBack: { dismiss() })

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
                                    ErrorBanner(message: errorMessage)
                                }
                                balanceSection
                                cardSection
                                agentCardSection
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await loadPayments() }
            .refreshable { await loadPayments() }
            .sheet(isPresented: $showAgentCardSheet) {
                AgentCardEntrySheet { saved in
                    agentCard = saved
                }
            }
        }
    }

    // MARK: - Sections

    private var balanceSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Concierge balance").padding(.bottom, 12)
            Text(formattedBalance)
                .font(.rowTitle)
                .foregroundStyle(Color.appInk)
        }
    }

    private var cardSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Linked card").padding(.bottom, 12)
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(cardTitle)
                        .font(.rowTitle)
                        .foregroundStyle(Color.appInk)
                    Text(cardSubtitle)
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                }
                Spacer(minLength: 8)
            }
            .padding(.vertical, 14)
            .frame(minHeight: 44)
        }
    }

    // Card the agent fills into merchant checkouts after an explicit "yes" to a
    // ready-to-pay summary. Stored encrypted server-side; only brand/last4 come back.
    private var agentCardSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            AppSectionHeader(title: "Checkout card").padding(.bottom, 12)
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(agentCardTitle)
                        .font(.rowTitle)
                        .foregroundStyle(Color.appInk)
                    Text(agentCardSubtitle)
                        .font(.rowSecondary)
                        .foregroundStyle(Color.appMuted)
                }
                Spacer(minLength: 8)
                if agentCard == nil {
                    Button("Add") { showAgentCardSheet = true }
                        .font(.rowSecondary)
                } else {
                    Button("Remove", role: .destructive) {
                        Task { await removeAgentCard() }
                    }
                    .font(.rowSecondary)
                }
            }
            .padding(.vertical, 14)
            .frame(minHeight: 44)
        }
    }

    private var agentCardTitle: String {
        guard let agentCard else { return "No checkout card" }
        return "\(agentCard.brand.capitalized) •••• \(agentCard.last4)"
    }

    private var agentCardSubtitle: String {
        guard let agentCard else {
            return "Add a card so the agent can complete purchases you approve"
        }
        return "Expires \(String(format: "%02d", agentCard.expMonth))/\(String(agentCard.expYear % 100)) — used only after you confirm an order"
    }

    private var formattedBalance: String {
        String(format: "%.2f", balance)
    }

    private var cardTitle: String {
        guard let card else { return "No card linked" }
        return "\(card.brand.capitalized) •••• \(card.last4)"
    }

    private var cardSubtitle: String {
        card == nil ? "Link a card so the agent can charge you directly" : "Linked"
    }

    // MARK: - Networking

    private func loadPayments() async {
        async let cardResult = fetchCard()
        async let balanceResult = fetchBalance()
        async let agentCardResult = fetchAgentCard()
        let (fetchedCard, fetchedBalance, fetchedAgentCard) = await (cardResult, balanceResult, agentCardResult)
        await MainActor.run {
            card = fetchedCard
            balance = fetchedBalance ?? balance
            agentCard = fetchedAgentCard
            isLoading = false
        }
    }

    private func fetchAgentCard() async -> AgentCardSummary? {
        do {
            let data = try await APIClient.shared.request(path: "/connectors/agent-card")
            let response = try JSONDecoder().decode(AgentCardResponse.self, from: data)
            return response.card
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return nil
        }
    }

    private func removeAgentCard() async {
        do {
            _ = try await APIClient.shared.request(path: "/connectors/agent-card", method: "DELETE")
            await MainActor.run { agentCard = nil }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private func fetchCard() async -> LinkedCard? {
        do {
            let data = try await APIClient.shared.request(path: "/connectors/stripe/card")
            let response = try JSONDecoder().decode(CardResponse.self, from: data)
            await MainActor.run { errorMessage = nil }
            return response.card
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return nil
        }
    }

    private func fetchBalance() async -> Double? {
        do {
            let data = try await APIClient.shared.request(path: "/concierge/balance")
            let response = try JSONDecoder().decode(BalanceResponse.self, from: data)
            return response.balance
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return nil
        }
    }
}

// MARK: - Agent card entry

// Plain-text card entry posted straight to the authed backend route — no payment-SDK
// dependency. The number/CVC never persist on device; the response is the masked summary.
private struct AgentCardEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
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
                    TextField("Name on card", text: $name)
                        .textContentType(.name)
                    TextField("Card number", text: $number)
                        .keyboardType(.numberPad)
                        .textContentType(.creditCardNumber)
                        .onChange(of: number) { _, new in
                            number = Self.formatCardNumber(new)
                        }
                    TextField("Expiry (MM/YY)", text: $expiry)
                        .keyboardType(.numberPad)
                        .onChange(of: expiry) { _, new in
                            expiry = Self.formatExpiry(new)
                        }
                    TextField("Security code", text: $cvc)
                        .keyboardType(.numberPad)
                        .onChange(of: cvc) { _, new in
                            cvc = String(new.filter(\.isNumber).prefix(4))
                        }
                } footer: {
                    Text("Stored encrypted. Only used to complete a purchase after you've approved its total in chat.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Checkout card")
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
    let balance: Double
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
