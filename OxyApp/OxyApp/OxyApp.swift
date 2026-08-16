import SwiftUI
import UIKit

@main
struct OxyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    init() {
        UISlider.appearance().maximumTrackTintColor = UIColor(white: 1, alpha: 0.16)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .tint(Color.appAccent)
                .preferredColorScheme(.light)
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var appState
    @State private var didRestoreSession = false

    var body: some View {
        Group {
            if !didRestoreSession {
                Color.appBackground.ignoresSafeArea()
            } else if appState.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut(duration: 0.35), value: appState.isAuthenticated)
        .task {
            appState.restoreSession()
            #if DEBUG
            if !appState.isAuthenticated,
               ProcessInfo.processInfo.environment["OXY_DEBUG_AUTOLOGIN"] == "1" {
                appState.userId = "demo@oxy.app"
                appState.token = "debug-local"
                appState.isDemoSession = true
                appState.isAuthenticated = true
            }
            #endif
            didRestoreSession = true
        }
    }
}
