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
            ColdLaunch.relaunch(app)
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
            ColdLaunch.relaunch(app)
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
        ColdLaunch.stop(app)

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
        let app = AppDriver.app()
        ColdLaunch.relaunch(app)
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

    /// Terminate, and wait until the simulator agrees the app is gone.
    ///
    /// Measured on the CI Mac (fafea0e, iPhone Duo on iOS 27.1 and iPad on
    /// iOS 27.0): a launch asked for one second after terminate() failed with
    /// "Timed out attempting to launch app", and the system log shows no
    /// HoundStack process at all until after the timeout, 33 s and 74 s
    /// later. The simulator had not spawned it, so no app code had run. A
    /// launch now waits for the old process to be reported gone and gives
    /// CoreSimulator two seconds; a launch that still times out still fails.
    static func stop(_ app: XCUIApplication) {
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30), "the previous launch never exited")
        Thread.sleep(forTimeInterval: 2)
    }

    static func relaunch(_ app: XCUIApplication) {
        stop(app)
        app.launch()
    }

    /// Hands the link to the system, and leaves the verdict to the app.
    ///
    /// Measured on the CI Mac (054a4a28, iPad (A16), iOS 27.2, #726):
    /// `system.open` was called at 21:46:42 and failed at 21:48:37 with
    /// "Timed out while opening the default app for a URL". The simulator
    /// spawned HoundStack at 21:47:46; it took the link in scene-create
    /// (UIOpenURLAction), finished loading the page, and was still running
    /// when the next test ended it. The same iPad then passed five cold
    /// launches. So that one message from XCTest's own call is expected, not
    /// fatal, and only inside this call. Whether the app came up from the
    /// link is decided by the foreground and sign-in checks after it, and a
    /// crash still fails the run through its crash report.
    private func openLink() {
        if #available(iOS 16.4, *) {
            let options = XCTExpectedFailure.Options()
            options.isStrict = false
            options.issueMatcher = { $0.compactDescription.contains("Timed out while opening the default app for a URL") }
            let carryOn = continueAfterFailure
            continueAfterFailure = true
            XCTExpectFailure("the simulator was slow to hand the link to the app (#726)", options: options) {
                XCUIDevice.shared.system.open(link)
            }
            continueAfterFailure = carryOn
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
