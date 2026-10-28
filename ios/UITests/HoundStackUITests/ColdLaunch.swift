// A cold launch reaches the sign-in form, five times in a row.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// Issue #570. On iOS 27.1 every launch stopped with SIGTRAP in
// _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption, before a
// single frame of the web view was drawn. The app had no scene manifest, and
// iOS 27 treats that as fatal. Nothing in this target could have seen it:
// every other test here starts from a session that is already on the device,
// and a crash at launch reads as "Failed to launch", which this suite had
// learned to blame on a wedged simulator.
//
// This is the one test in the target that needs NO session, which is what
// lets CI run it (.github/workflows/ios-launch.yml). A fresh simulator has
// nobody signed in, so the app's first screen is /auth, and the email field is
// the proof that the native shell, the scene, the bridge and the web bundle
// all came up.
//
// ── AND THE LINKS, BECAUSE THEY MOVED ─────────────────────────────────────
//
// With a scene, UIKit stops calling AppDelegate for URL opens. A link that
// arrives at launch comes in the scene's connection options and one that
// arrives later through scene(_:openURLContexts:), both in SceneDelegate. Both
// paths are driven below. Signed out, the web app keeps the person on /auth
// whatever the link says, so what this proves is that the native side takes a
// link without falling over and hands control back. That the link then ROUTES
// needs a session: testTappingAPushNotificationLandsOnItsDeepLink and a signed
// in run are where that is measured.

import XCTest

/// Gets a freshly booted simulator past its slow first launches, and fails
/// only if the page never paints at all.
///
/// Measured on the Mac CI runner (iOS 27.1, iPhone Duo): the first launches
/// after a boot served the same index.html and took 4 to 7.5 seconds from
/// response to commit, then over a minute to finish loading. Later launches
/// took 5 ms and painted in about 5 seconds. The native side was identical
/// in both (scene connected, window, visible web view, page served), so a
/// fixed timeout on those first launches measured the host rather than the
/// app. scripts/ios-launch-smoke.sh runs this class on its own, before
/// ColdLaunch.
final class ColdLaunchWarmUp: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testTheFirstLaunchesAfterABootPaintEventually() {
        let app = AppDriver.app()
        for attempt in 1...2 {
            app.terminate()
            app.launch()
            XCTAssertTrue(
                app.textFields.firstMatch.waitForExistence(timeout: 300),
                "warm-up launch \(attempt): no sign-in field in 300s, so the page never painted"
            )
            AppDriver.screenshot("warm-up-\(attempt)", self)
        }
    }
}

final class ColdLaunch: XCTestCase {

    /// The lock-screen card's own shape (src/lib/live-activity-links.ts).
    private let link = URL(string: "consulting.thenorth.houndstack://open/my-day")!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testColdLaunchReachesSignInFiveTimes() {
        let app = AppDriver.app()
        for attempt in 1...5 {
            app.terminate()
            app.launch()
            XCTAssertTrue(
                app.wait(for: .runningForeground, timeout: AppDriver.launchTimeout),
                "launch \(attempt) of 5 never reached the foreground"
            )
            assertOnSignIn(app, "launch \(attempt) of 5")
            AppDriver.screenshot("cold-launch-\(attempt)", self)
        }
    }

    func testALinkThatLaunchesTheAppLandsOnSignIn() {
        let app = AppDriver.app()
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 20))

        // Cold: the URL is in the scene's connection options.
        openLink()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: AppDriver.launchTimeout),
            "a link did not bring the app up from cold"
        )
        assertOnSignIn(app, "after a cold link")
        AppDriver.screenshot("cold-link", self)
    }

    func testALinkWhileRunningKeepsTheAppUp() {
        let app = AppDriver.launch()
        assertOnSignIn(app, "before the link")

        // Warm: scene(_:openURLContexts:).
        openLink()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 30),
            "the app left the foreground after a link while running"
        )
        assertOnSignIn(app, "after a warm link")
        AppDriver.screenshot("warm-link", self)
    }

    // MARK: -

    private func openLink() {
        if #available(iOS 16.4, *) {
            XCUIDevice.shared.system.open(link)
        } else {
            XCTFail("XCUIDevice.system.open needs iOS 16.4; run on a newer simulator")
        }
        // Some iOS versions ask before handing a custom scheme to an app.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 3) {
            open.tap()
        }
    }

    /// The email step of /auth (src/routes/auth.tsx): its field and its
    /// Continue button. The field alone could be any form; with Continue it
    /// is this one.
    private func assertOnSignIn(_ app: XCUIApplication, _ when: String) {
        let field = app.textFields.firstMatch
        XCTAssertTrue(
            field.waitForExistence(timeout: AppDriver.elementTimeout),
            "\(when): no email field, so the sign-in form never rendered"
        )
        XCTAssertNotNil(
            AppDriver.find(app, containing: "Continue"),
            "\(when): a text field but no Continue button, so this is not /auth"
        )
    }
}
