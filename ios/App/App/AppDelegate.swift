import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    // ── The window belongs to a scene (#570) ────────────────────────────────
    //
    // iOS 27 stops a launch with SIGTRAP in
    // _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption when the
    // app has not adopted scenes. Info.plist declares the manifest; this names
    // the delegate in code as well, so the class is found through Swift rather
    // than by a string lookup (the same trap Main.storyboard records).
    //
    // With a scene connected, UIKit no longer calls this delegate for URL
    // opens, Universal Links or becoming active. Those live in
    // SceneDelegate.swift. `window` stays because SplashScreen looks here
    // first; SceneDelegate sets it.
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // ── Push: hand the APNs token to @capacitor/push-notifications ──────────
    //
    // iOS delivers the device token to the APP DELEGATE and nowhere else. The
    // plugin does not swizzle these methods; it listens on NotificationCenter
    // for the two names below (PushNotificationsPlugin.load()). Without these
    // two methods `PushNotifications.register()` resolves, the OS mints a
    // token, and the token is dropped on the floor here — so the JS
    // `registration` listener never fires, nothing is stored in
    // push_subscriptions, and the server has no device to send to. No error
    // anywhere, which is why this sat unnoticed behind a missing entitlement.
    //
    // Exactly the snippet in node_modules/@capacitor/push-notifications/README.md.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
