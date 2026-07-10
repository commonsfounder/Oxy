import SwiftUI

struct PaymentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color.appBackground.ignoresSafeArea()
                VStack(spacing: 0) {
                    ScreenHeaderView(title: "Payments", onBack: { dismiss() })
                    Spacer()
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

#Preview {
    PaymentsView()
        .environment(AppState())
}
