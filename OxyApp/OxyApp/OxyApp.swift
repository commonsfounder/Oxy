import SwiftUI
import UIKit

@main
struct OxyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    // Every app* token is hardcoded to its dark value (the light-mode pivot was
    // reverted), so system chrome must be pinned dark too: letting the scheme follow
    // iOS light mode renders a light liquid-glass tab bar/keyboard over the pure-black
    // canvas — glyphs become invisible and the bar reads as an empty pill.

    init() {
        // Slider's unfilled track is near-invisible on pure black by default; give it a
        // faint titanium so the full range of the Initiative control reads. ponytail:
        // global appearance — there's exactly one slider and one aesthetic.
        UISlider.appearance().maximumTrackTintColor = UIColor(white: 1, alpha: 0.16)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .preferredColorScheme(.dark)
                .tint(Color.appAccent)
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
            didRestoreSession = true
        }
    }
}
