// The app's one window, owned by a scene rather than by the app delegate.
//
// Issue #570: iOS 27.1 stopped every launch with SIGTRAP in
// _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption, three of
// three on the device the audit used. The app had UIMainStoryboardFile in
// Info.plist and no UIApplicationSceneManifest, which is the pre-iOS 13
// "app delegate owns the window" shape that Capacitor's own template still
// ships. iOS 27 treats that shape as a fatal runtime issue for a binary built
// against its SDK, so the fix is to adopt the scene lifecycle: Info.plist
// declares the manifest, AppDelegate names this class for every session, and
// this class builds the window that the storyboard used to.
//
// What moves here with it, because UIKit stops calling the app delegate for
// it once a scene exists:
//   - URL opens (custom scheme, lock-screen card links, OAuth hand-back), on a
//     cold launch from connectionOptions and on a warm one from
//     scene(_:openURLContexts:)
//   - Universal Links, the same two ways
//   - the Debug-only sample Live Activity, from sceneDidBecomeActive
//
// What does NOT move: the APNs device token still arrives at AppDelegate (the
// scene lifecycle does not change that), and a push TAP is delivered to
// UNUserNotificationCenter's delegate, which Capacitor's bridge installs when
// HSBridgeViewController loads its view, the same object as before.

import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // The same storyboard as before, so HSBridgeViewController is still
        // found through its module (Main.storyboard says why that matters).
        // Built here rather than through UISceneStoryboardFile because the
        // launch URL below has to reach a bridge that already exists.
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        // SplashScreen sizes itself from the app delegate's window first.
        (UIApplication.shared.delegate as? AppDelegate)?.window = window
        window.makeKeyAndVisible()

        // Load the view now: CAPBridgeViewController creates the bridge and
        // every plugin in loadView, and the App plugin only hears a URL it is
        // already listening for. It keeps that event until JS attaches a
        // listener (src/lib/native.ts, initAppLinks), so a cold-start link
        // still routes exactly once.
        window.rootViewController?.loadViewIfNeeded()

        for context in connectionOptions.urlContexts {
            open(url: context.url, options: context.options)
        }
        for activity in connectionOptions.userActivities {
            continueActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(url: context.url, options: context.options)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        #if DEBUG
        // A sample route on the lock screen, for a simulator with nobody
        // signed in. Launch argument only, Debug only: RouteActivityDemo.swift.
        RouteActivityDemo.startIfAsked()
        #endif
    }

    // MARK: - Links

    private func open(url: URL, options: UIScene.OpenURLOptions) {
        let app = UIApplication.shared
        #if canImport(ActivityKit)
        // Navigate on the route's lock-screen card. iOS hands the card's
        // Google Maps link to this app rather than opening it, so pass it
        // on (RouteLinks.directionsHandOff says why, and what it accepts).
        // Not forwarded to Capacitor: the web view has nothing to do with it.
        if #available(iOS 16.1, *), let maps = RouteLinks.directionsHandOff(url) {
            DispatchQueue.main.async { app.open(maps) }
            return
        }
        #endif
        // The App plugin raises appUrlOpen from this, and getLaunchUrl()
        // reads the URL it records.
        _ = ApplicationDelegateProxy.shared.application(app, open: url, options: Self.appOptions(options))
    }

    private func continueActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

    // The scene hands over its options as a struct; Capacitor's proxy and the
    // App plugin read the app-delegate dictionary, so rebuild that.
    private static func appOptions(_ options: UIScene.OpenURLOptions) -> [UIApplication.OpenURLOptionsKey: Any] {
        var out: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: options.openInPlace]
        if let source = options.sourceApplication {
            out[.sourceApplication] = source
        }
        if let annotation = options.annotation {
            out[.annotation] = annotation
        }
        return out
    }
}
