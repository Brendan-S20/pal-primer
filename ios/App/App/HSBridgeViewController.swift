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
import Capacitor

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

        #if DEBUG
        RouteActivityDemo.checkBridgeIfAsked(webView)
        #endif
    }
}
