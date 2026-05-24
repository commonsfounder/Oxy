import SwiftUI

@main
struct OxyApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.isAuthenticated {
                ChatView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: appState.isAuthenticated)
        .task {
            appState.restoreSession()
        }
    }
}
