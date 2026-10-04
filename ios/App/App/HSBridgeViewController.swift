// The app's one view controller: Capacitor's own, plus the two things this
// app needs from it that a stock CAPBridgeViewController does not do.
//
// Main.storyboard names this class instead of CAPBridgeViewController. The
// @objc name pins the class name the storyboard looks up, so it does not
// depend on the target's module name (PRODUCT_NAME is HoundStack, the target
// is App, and a storyboard that guesses the wrong one fails silently to a
// plain UIViewController with no web view at all).

import UIKit
import Capacitor

@objc(HSBridgeViewController)
class HSBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // Plugins that live INSIDE the app target are not found by
        // Capacitor's package scan (that only reads the Swift packages
        // CapApp-SPM lists), so they are registered here, which is the
        // approach Capacitor documents for a local iOS plugin.
        bridge?.registerPluginInstance(RouteActivityPlugin())

        // The iOS edge swipe back. WKWebView turns it off by default; on, a
        // swipe from the leading edge walks the web view's back list, and in
        // this single-page app that list is the router's pushState history,
        // so the gesture fires popstate and goes back one screen exactly as
        // the browser's Back would. Without it the only way back on a phone
        // is whatever button the page draws.
        webView?.allowsBackForwardNavigationGestures = true
    }
}
