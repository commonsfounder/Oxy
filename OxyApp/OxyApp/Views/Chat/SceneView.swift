import SwiftUI
import WebKit

/// A page Adam wrote for the moment (a how-to, a plan, a chart). It arrives already wrapped in a
/// page that blocks the network; this view adds the rest of the boundary: nothing is stored,
/// nothing can navigate away, and the only way out is a button that asks Adam for something.
struct SceneContent: Codable, Equatable {
    let title: String
    let srcdoc: String
    var spec: TaskInterfaceSpec? = nil
}

struct SceneCard: View {
    let scene: SceneContent
    let summary: String?
    var onAsk: ((String) -> Void)? = nil
    @State private var open = false

    var body: some View {
        if let spec = scene.spec, spec.mode == "interface" {
            TaskInterfaceView(spec: spec) { request in
                if let onAsk { onAsk(request) } else { AskAdam.draft(request) }
            }
        } else {
            Button {
                HapticManager.shared.impact(.light)
                open = true
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(scene.title)
                            .font(.appBody(15, weight: .semibold))
                            .foregroundStyle(Color.appInk)
                            .multilineTextAlignment(.leading)
                        if let summary, !summary.isEmpty, summary != scene.title {
                            Text(summary)
                                .font(.appBody(13))
                                .foregroundStyle(Color.appMuted)
                                .multilineTextAlignment(.leading)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 8)
                    Image("ic-arrow-up-right")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 16, height: 16)
                        .foregroundStyle(Color.appInk)
                        .frame(width: 34, height: 34)
                        .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.appCardOutline, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.appScale(0.98))
            .accessibilityLabel(scene.title)
            .accessibilityHint("Opens the page")
            .fullScreenCover(isPresented: $open) {
                SceneSheet(scene: scene) { text in
                    open = false
                    if let onAsk { onAsk(text) } else { AskAdam.draft(text) }
                } onClose: { open = false }
            }
        }
    }
}

/// The page's own canvas colours (the same two as the screen kit), so the strips under the status
/// bar and home indicator match the page instead of the app.
private let sceneCanvas = UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 14 / 255, green: 19 / 255, blue: 27 / 255, alpha: 1)
        : UIColor(red: 246 / 255, green: 249 / 255, blue: 253 / 255, alpha: 1)
}

private struct SceneSheet: View {
    let scene: SceneContent
    let onAsk: (String) -> Void
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            SceneWebView(srcdoc: scene.srcdoc, onAsk: onAsk)
                .ignoresSafeArea()
            Button {
                HapticManager.shared.impact(.light)
                onClose()
            } label: {
                Image("ic-xmark")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 14, height: 14)
                    .foregroundStyle(Color.appInk)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color(uiColor: sceneCanvas)))
                    .overlay(Circle().strokeBorder(Color.appCardOutline, lineWidth: 1))
            }
            .buttonStyle(.appScale)
            .padding(.top, 8)
            .padding(.trailing, 14)
            .accessibilityLabel("Close")
        }
        .background(Color(uiColor: sceneCanvas).ignoresSafeArea())
    }
}

private struct SceneWebView: UIViewRepresentable {
    let srcdoc: String
    let onAsk: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onAsk: onAsk) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "adam")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.underPageBackgroundColor = sceneCanvas
        view.scrollView.contentInsetAdjustmentBehavior = .always
        view.loadHTMLString(srcdoc, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onAsk = onAsk
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "adam")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onAsk: (String) -> Void

        init(onAsk: @escaping (String) -> Void) { self.onAsk = onAsk }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "adam", let text = message.body as? String else { return }
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !clean.isEmpty, clean.count <= 2000 else { return }
            DispatchQueue.main.async { self.onAsk(clean) }
        }

        // The page loads once from a string. Any link, redirect or script navigation is refused.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = action.request.url?.absoluteString
            decisionHandler(url == nil || url == "about:blank" ? .allow : .cancel)
        }
    }
}
