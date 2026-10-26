import SwiftUI

private struct RevealCloseKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Set while a screen is open from the menu button; calling it pulls the screen back into the button.
    var revealClose: (() -> Void)? {
        get { self[RevealCloseKey.self] }
        set { self[RevealCloseKey.self] = newValue }
    }
}
