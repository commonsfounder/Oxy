import SwiftUI
import WebKit

/// Signs in to a site inside the app, then hands Adam the signed-in session. The password is typed on the
/// site itself and never reaches Adam; only the session cookies do. The page runs in a throwaway browser
/// that is discarded afterwards, so nothing is left behind on the phone.
struct SiteSignInSheet: View {
    @Environment(\.dismiss) private var dismiss
    let site: String
    let onSignedIn: () -> Void

    @State private var box = SiteWebBox()
    @State private var isSaving = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                SiteWebView(site: SiteSignInSheet.cleanSite(site), box: box)
                if let message {
                    Text(message)
                        .font(.appBody(13))
                        .foregroundStyle(Color.appMuted)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .navigationTitle(SiteSignInSheet.cleanSite(site))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("I'm signed in") { Task { await share() } } }
                }
            }
        }
    }

    /// The site as a bare domain, whatever form it arrived in.
    static func cleanSite(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for prefix in ["https://", "http://"] where text.hasPrefix(prefix) { text.removeFirst(prefix.count) }
        text = String(text.split(separator: "/").first ?? "")
        if text.hasPrefix("www.") { text.removeFirst(4) }
        return text
    }

    private func share() async {
        isSaving = true
        message = nil
        defer { isSaving = false }
        let domain = SiteSignInSheet.cleanSite(site)
        let cookies = await box.cookies().filter {
            let host = $0.domain.hasPrefix(".") ? String($0.domain.dropFirst()) : $0.domain
            return host == domain || host.hasSuffix("." + domain)
        }
        guard !cookies.isEmpty else {
            message = "Sign in on the page first, then tap I'm signed in."
            return
        }
        let payload: [[String: Any]] = cookies.map { cookie in
            [
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path.isEmpty ? "/" : cookie.path,
                "expires": cookie.expiresDate.map { Int($0.timeIntervalSince1970) } ?? -1,
                "httpOnly": cookie.isHTTPOnly,
                "secure": cookie.isSecure,
                "sameSite": cookie.sameSitePolicy == .sameSiteStrict ? "Strict" : "Lax"
            ]
        }
        do {
            _ = try await APIClient.shared.request(path: "/vault/browser-session", method: "POST", body: ["site": domain, "cookies": payload])
            await box.clear()
            dismiss()
            onSignedIn()
        } catch {
            message = "Couldn't hand that over to Adam. Try again."
        }
    }
}

/// Keeps a handle on the page's browser so the sign-in can be read once it's done.
@MainActor
final class SiteWebBox {
    fileprivate var webView: WKWebView?

    func cookies() async -> [HTTPCookie] {
        guard let store = webView?.configuration.websiteDataStore.httpCookieStore else { return [] }
        return await withCheckedContinuation { continuation in store.getAllCookies { continuation.resume(returning: $0) } }
    }

    func clear() async {
        guard let store = webView?.configuration.websiteDataStore else { return }
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        await store.removeData(ofTypes: types, modifiedSince: .distantPast)
    }
}

private struct SiteWebView: UIViewRepresentable {
    let site: String
    let box: SiteWebBox

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        let view = WKWebView(frame: .zero, configuration: config)
        // Some sites refuse to sign in from an embedded browser, so this announces itself as mobile Safari.
        view.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        box.webView = view
        if let url = URL(string: "https://\(site)") { view.load(URLRequest(url: url)) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate {
        /// A sign-in that opens a popup stays in the same page.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            webView.load(navigationAction.request)
            return nil
        }
    }
}
