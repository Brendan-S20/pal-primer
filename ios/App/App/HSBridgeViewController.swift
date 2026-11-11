// The app's one view controller: Capacitor's own, plus the two things this
// app needs from it that a stock CAPBridgeViewController does not do.
//
// Main.storyboard names this class instead of CAPBridgeViewController, with
// customModuleProvider="target" (the module is HoundStack, from PRODUCT_NAME,
// not App, the target's name). NOT an `@objc(HSBridgeViewController)` rename:
// that was tried, and the app launched to a black screen with "Unknown class
// HSBridgeViewController in Interface Builder file". The superclass lives in
// Capacitor's binary framework, so the Objective-C runtime only learns this
// class once Swift has initialised its metadata, and a lookup by the bare
// Objective-C name happens before anything has. A storyboard that names the
// module looks it up through Swift, which initialises it. A storyboard that
// cannot find its class falls back to a plain UIViewController: no web view,
// no error anywhere a user would see.

import UIKit
import WebKit
import Capacitor

class HSBridgeViewController: CAPBridgeViewController {

    // ── The two questions the page asked the app before its first paint ──────
    //
    // Capacitor's native-bridge.js, injected at document start, calls
    // window.prompt() twice on every iOS launch to ask whether
    // CapacitorCookies and CapacitorHttp are enabled. prompt() is a
    // SYNCHRONOUS round trip: the web content process stops until the app's
    // WKUIDelegate answers. Measured on the CI Mac (#570, iOS 27.1, iPhone Duo
    // simulator): one launch in a few sent that prompt and the app never
    // handled it, with WebKit's "JS prompt before the first paint" log line
    // absent and the app's main thread idle. A `sample` of the content process
    // showed it parked in WebChromeClient::runJavaScriptPrompt ->
    // IPC::Connection::sendSyncMessage, inside native-bridge.js, for minutes:
    // a blank screen, no crash, no error.
    //
    // Both answers are fixed by capacitor.config at build time, so this
    // script, added ahead of Capacitor's own, answers exactly those two
    // payloads in the page and passes every other prompt() through unchanged.
    // The page no longer needs anything from the app before it can paint.
    private var bridgeConfigAnswers = ""

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let cookies = instanceConfiguration.getPluginConfig("CapacitorCookies").getBoolean("enabled", false)
        let http = instanceConfiguration.getPluginConfig("CapacitorHttp").getBoolean("enabled", false)
        bridgeConfigAnswers = Self.bridgeConfigAnswerScript(cookies: cookies, http: http)
        return super.webViewConfiguration(for: instanceConfiguration)
    }

    // The configuration here already carries the content controller Capacitor
    // will add native-bridge.js to, and nothing is in it yet: user scripts run
    // in the order they were added, so this one runs first.
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        configuration.userContentController.addUserScript(
            WKUserScript(source: bridgeConfigAnswers, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: Self.tapToPayEntitledScript(Self.tapToPayEntitled()),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return super.webView(with: frame, configuration: configuration)
    }

    // ── Whether THIS binary was signed with Tap to Pay on iPhone ────────────
    //
    // Apple granted com.apple.developer.proximity-reader.payment.acceptance
    // for DEVELOPMENT only (case 23404969). Debug signs with App.entitlements,
    // which carries it; Release signs with App.Release.entitlements, which does
    // not, because a distribution profile cannot include it and Xcode Cloud's
    // export failed on it. The build setting HS_TAP_TO_PAY_ENTITLED says which
    // (YES in Debug, NO in Release), Info.plist carries it as
    // HSTapToPayEntitled, and the page reads window.__HS_TAP_TO_PAY_ENTITLED__
    // (src/lib/tap-to-pay-entitlement.ts) so a Release build never draws a
    // button whose first call would fail. See
    // docs/tap-to-pay-release-entitlements.md.
    static func tapToPayEntitled() -> Bool {
        let raw = Bundle.main.object(forInfoDictionaryKey: "HSTapToPayEntitled") as? String
        return raw?.uppercased() == "YES"
    }

    static func tapToPayEntitledScript(_ entitled: Bool) -> String {
        "window.__HS_TAP_TO_PAY_ENTITLED__ = \(entitled);"
    }

    static func bridgeConfigAnswerScript(cookies: Bool, http: Bool) -> String {
        """
        (function () {
          var answers = { "CapacitorCookies.isEnabled": "\(cookies)", "CapacitorHttp": "\(http)" };
          var nativePrompt = window.prompt;
          window.prompt = function (message) {
            try {
              var payload = JSON.parse(message);
              if (payload && Object.prototype.hasOwnProperty.call(answers, payload.type)) {
                return answers[payload.type];
              }
            } catch (e) {}
            return nativePrompt.apply(window, arguments);
          };
        })();
        """
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // Plugins that live INSIDE the app target are not found by
        // Capacitor's package scan (that only reads the Swift packages
        // CapApp-SPM lists), so they are registered here, which is the
        // approach Capacitor documents for a local iOS plugin.
        bridge?.registerPluginInstance(RouteActivityPlugin())
        // Apple's Tap to Pay on iPhone merchant education (ProximityReaderDiscovery).
        bridge?.registerPluginInstance(TapToPayEducationPlugin())

        // The iOS edge swipe back. WKWebView turns it off by default; on, a
        // swipe from the leading edge walks the web view's back list, and in
        // this single-page app that list is the router's pushState history,
        // so the gesture fires popstate and goes back one screen exactly as
        // the browser's Back would. Without it the only way back on a phone
        // is whatever button the page draws.
        webView?.allowsBackForwardNavigationGestures = true

        #if DEBUG
        RouteActivityDemo.checkBridgeIfAsked(webView)
        #endif
    }
}
