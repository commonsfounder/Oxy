import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var balance: Double = 0
    @State private var card: LinkedCard?
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
        let (fetchedCard, fetchedBalance) = await (cardResult, balanceResult)
        await MainActor.run {
            card = fetchedCard
            balance = fetchedBalance ?? balance
            isLoading = false
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

private struct BalanceResponse: Codable {
    let balance: Double
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
