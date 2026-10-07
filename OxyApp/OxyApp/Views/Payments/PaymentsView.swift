import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.revealClose) private var revealClose
    private func dismiss() { if let revealClose { revealClose() } else { systemDismiss() } }

    @State private var balance: Double?
    @State private var card: LinkedCard?
    @State private var agentCard: AgentCardSummary?
    @State private var showAgentCardSheet = false
    @State private var isLoading = true
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
                                }
                                agentCardSection
                                if card != nil || balance != nil { otherSection }
                            }
                            .padding(.horizontal, AppSpacing.margin)
                            .padding(.vertical, 16)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .toolbar(.hidden, for: .navigationBar)
            .task { await loadPayments() }
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
                }
            }
        }
    }

    // MARK: - Sections

    private var agentCardSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsGroup(title: "Card for checkout") {
                SettingsList {
                    SettingsRow(title: agentCardTitle, subtitle: agentCardSubtitle) {
                        cardButton
                    }
                }
            }
            SettingsStatement(text: "Adam asks before every payment.", solid: false)
                .padding(.horizontal, 4)
        }
    }

    private var cardButton: some View {
        Button {
            HapticManager.shared.impact(.light)
            if agentCard == nil { showAgentCardSheet = true } else { confirmRemove = true }
        } label: {
            Text(agentCard == nil ? "Add" : "Remove")
                .font(.appBody(14, weight: .medium))
                .foregroundStyle(agentCard == nil ? Color.appOnAction : Color.appInk)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(Capsule().fill(agentCard == nil ? Color.appAction : Color.appInk.opacity(0.10)))
        }
        .buttonStyle(.appScale(0.96))
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

    private var agentCardTitle: String {
        guard let agentCard else { return "No checkout card" }
        return "\(agentCard.brand.capitalized) •••• \(agentCard.last4)"
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

    private var cardSubtitle: String {
        card == nil ? "No card linked" : "Linked"
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
                    Text("Encrypted. Used only after you approve the total.")
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
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
