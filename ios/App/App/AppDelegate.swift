import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        #if DEBUG
        // A sample route on the lock screen, for a simulator with nobody
        // signed in. Launch argument only, Debug only: RouteActivityDemo.swift.
        RouteActivityDemo.startIfAsked()
        #endif
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        #if canImport(ActivityKit)
        // Navigate on the route's lock-screen card. iOS hands the card's
        // Google Maps link to this app rather than opening it, so pass it
        // on (RouteLinks.directionsHandOff says why, and what it accepts).
        // Not forwarded to Capacitor: the web view has nothing to do with it.
        if #available(iOS 16.1, *), let maps = RouteLinks.directionsHandOff(url) {
            DispatchQueue.main.async { app.open(maps) }
            return true
        }
        #endif
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
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
