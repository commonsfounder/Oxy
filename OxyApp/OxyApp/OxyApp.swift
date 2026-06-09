import SwiftUI

@main
struct OxyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    @AppStorage("oxy_appTheme") private var appTheme = "dark"

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(preferredColorScheme)
                .tint(Color.oxyStone)
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch appTheme {
        case "light":
            return .light
        case "system":
            return nil
        default:
            return .dark
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var appState
    @State private var didRestoreSession = false

    var body: some View {
        Group {
            if !didRestoreSession {
                // Hold on a plain black screen until the keychain session check
                // finishes, so a returning user never sees a flash of the login
                // screen on cold launch.
                Color.black.ignoresSafeArea()
            } else if appState.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.35), value: appState.isAuthenticated)
        .task {
            appState.restoreSession()
            didRestoreSession = true
        }
    }
}
