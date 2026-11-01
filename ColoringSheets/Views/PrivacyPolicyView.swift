import SwiftUI
import WebKit

/// Present from the invoking screen so closing the policy preserves its state.
struct PrivacyPolicyLink: View {
    var title = "Privacy policy"
    @State private var isPresented = false

    var body: some View {
        Button(title) { isPresented = true }
            .accessibilityIdentifier("privacyPolicy")
            .sheet(isPresented: $isPresented) { PrivacyPolicyView() }
    }
}

private struct PrivacyPolicyView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var browser = PrivacyPolicyBrowser()

    var body: some View {
        NavigationStack {
            ZStack {
                PrivacyWebView(browser: browser)
                    .opacity(browser.failed ? 0 : 1)
                    .accessibilityHidden(browser.failed)
                if browser.failed {
                    ContentUnavailableView {
                        Label("Unable to load page", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text("Check your connection and try again.")
                    } actions: {
                        Button("Retry") { browser.loadPolicy() }
                            .accessibilityIdentifier("retryPrivacyPolicy")
                    }
                } else if browser.isLoading {
                    ProgressView("Loading privacy policy…")
                        .padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("privacyPolicyLoading")
                }
            }
            .navigationTitle("Privacy policy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { browser.webView.goBack() } label: {
                        Label("Back", systemImage: "chevron.left")
                    }
                    .disabled(!browser.canGoBack)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("closePrivacyPolicy")
                }
            }
            .alert("Link unavailable here", isPresented: $browser.showsUnsupportedLink) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("This viewer opens web pages inside Wonder Lines. To email us, use Email support in Settings.")
            }
        }
    }
}

@MainActor
private final class PrivacyPolicyBrowser: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published var isLoading = true
    @Published var failed = false
    @Published var canGoBack = false
    @Published var showsUnsupportedLink = false

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        // Link previews offer system actions that can leave the app.
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = true
        webView.accessibilityIdentifier = "privacyPolicyWebView"
        webView.load(URLRequest(url: PrivacyConsent.policyURL, timeoutInterval: 30))
    }

    func loadPolicy() {
        failed = false
        isLoading = true
        webView.load(URLRequest(url: PrivacyConsent.policyURL, timeoutInterval: 30))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.request.url?.scheme?.lowercased() == "https" else {
            decisionHandler(.cancel)
            showsUnsupportedLink = true
            return
        }
        // Keep target="_blank" links in this same view as well.
        if navigationAction.targetFrame == nil {
            decisionHandler(.cancel)
            webView.load(navigationAction.request)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           !navigationResponse.canShowMIMEType || (navigationResponse.response as? HTTPURLResponse).map({ $0.statusCode >= 400 }) == true {
            decisionHandler(.cancel)
            finishLoading(failed: true)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        failed = false
        isLoading = true
        canGoBack = webView.canGoBack
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishLoading(failed: false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finishLoading(failed: true)
    }

    private func handle(_ error: Error) {
        let error = error as NSError
        guard error.domain != NSURLErrorDomain || error.code != NSURLErrorCancelled else { return }
        finishLoading(failed: true)
    }

    private func finishLoading(failed: Bool) {
        self.failed = failed
        isLoading = false
        canGoBack = webView.canGoBack
    }
}

private struct PrivacyWebView: UIViewRepresentable {
    let browser: PrivacyPolicyBrowser

    func makeUIView(context: Context) -> WKWebView {
        browser.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: ()) {
        uiView.stopLoading()
        uiView.navigationDelegate = nil
    }
}
