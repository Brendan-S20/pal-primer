// The app's chrome has to start at the top of the SCREEN, not below it.
//
// ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────
//
// `ios.contentInset` in capacitor.config.ts was "always", which applies the
// safe area to WKWebView's scroll view — the document itself. The
// accessibility tree put <body> at y=62 inside a WebView measured at
// {{0,0},{402,874}}, and three things followed:
//
//   * env(safe-area-inset-top) still resolves to 62 inside that inset
//     document, so the header's own padding was a SECOND inset. 62pt of dead
//     white space above the top bar on every single screen.
//   * `position: fixed; inset: 0` could not reach the top of the screen, so
//     the guided tour's dim overlay stopped at 62pt and left a bright white
//     strip across the top of an otherwise dimmed app.
//   * The header is designed to extend UNDER the status bar and paint its own
//     background there. It never could.
//
// None of that is visible in a screenshot without measuring: a white strip
// above a white header looks like a white header. It took the accessibility
// tree to tell "the WebView does not reach the top" apart from "the WebView
// reaches the top and the page inside it starts low", which look identical in
// a PNG and have completely different fixes.
//
// The fix is `contentInset: "never"`, handing the safe area back to CSS, where
// this codebase already handles it. This test is the guard, because that is a
// one-word config change that nothing else here would notice.

import XCTest

final class Geometry: XCTestCase {

    /// The real status bar height on THIS device, from SpringBoard.
    ///
    /// ── WHY THIS IS NOT A CONSTANT ────────────────────────────────────────
    ///
    /// It was `59`, the Dynamic Island inset, because that is the phone this
    /// test was written on. Run on three devices it failed on two of them, for
    /// behaviour that was correct:
    ///
    ///     iPhone SE   bar 76pt tall, controls at y=25   (20pt status bar)
    ///     iPad        bar 88pt tall, controls at y=37   (24pt status bar)
    ///     iPhone 16   bar 115pt tall, controls at y=67  (59pt status bar)
    ///
    /// A test that hardcodes one device's furniture reports the other two as
    /// broken, which is worse than not testing them — it teaches people that
    /// red means "wrong device" and they stop reading.
    private func statusBarHeight() -> CGFloat {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let bar = springboard.statusBars.firstMatch
        let h = bar.exists ? bar.frame.height : 0
        // A plausible range. Anything outside it means SpringBoard did not
        // answer, and the relational assertions below still hold.
        return (h >= 12 && h <= 80) ? h : 0
    }

    func testTheTopBarStartsAtTheTopOfTheScreen() throws {
        let app = AppDriver.launch()
        AppDriver.dismissTourIfPresent(app)
        guard AppDriver.isSignedIn(app) else {
            throw XCTSkip("not signed in — sign in as the demo owner once on this simulator")
        }

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20), "no WebView")
        XCTAssertEqual(
            web.frame.minY, 0, accuracy: 1,
            "the WebView itself is not at the top of the screen"
        )

        guard let bar = AppDriver.find(app, containing: "banner") else {
            throw XCTSkip("could not identify the header element")
        }

        // ── THE REGRESSION GUARD ───────────────────────────────────────────
        //
        // `ios.contentInset: "always"` put the document at y=62 inside a
        // WebView at y=0.
        //
        // PROVEN ON A PHONE, NOT ON A TABLET. Putting `"always"` back fails
        // this line on an iPhone 16 Pro with exactly 62.0pt. The same mutation
        // on an iPad PASSED — the tablet's inset behaves differently under that
        // setting and the reason is not established here. So this is a phone
        // guard in practice, and the iPad symptom of the same fault is covered
        // separately and precisely by SidebarInset, which was mutation-tested
        // on the tablet (18.0pt wordmark, 8.0pt bottom gap).
        //
        // Written down because "the guard passes on three devices" would
        // otherwise read as "the guard works on three devices", and one of
        // those three is only being smoke-tested.
        XCTAssertEqual(
            bar.frame.minY, 0, accuracy: 2,
            "the top bar starts at \(bar.frame.minY)pt instead of 0 — the document is "
                + "inset (check ios.contentInset in capacitor.config.ts), so there is a band "
                + "of dead space above the bar and nothing fixed can reach the top of the screen"
        )

        guard let trigger = AppDriver.find(app, containing: "Search or jump") else {
            throw XCTSkip("no palette trigger on this surface")
        }

        // The bar must be TALLER than its own contents: that difference is the
        // safe-area padding, whatever this device's inset happens to be.
        XCTAssertGreaterThan(
            bar.frame.height, trigger.frame.height,
            "the top bar (\(bar.frame.height)pt) is no taller than the control inside it "
                + "(\(trigger.frame.height)pt), so it is not padding for the status bar at all"
        )

        // And the contents must be pushed clear of it.
        let inset = statusBarHeight()
        if inset > 0 {
            XCTAssertGreaterThanOrEqual(
                trigger.frame.minY, inset,
                "the top bar's controls start at \(trigger.frame.minY)pt, inside this device's "
                    + "\(inset)pt status bar — the clock is drawn over them"
            )
            XCTAssertLessThan(
                trigger.frame.minY, inset + 40,
                "the top bar's controls start at \(trigger.frame.minY)pt against a \(inset)pt "
                    + "status bar — far enough down that the inset has probably been applied twice"
            )
        } else {
            // SpringBoard did not answer. Say so rather than passing silently:
            // the two assertions above are the precise ones.
            XCTAssertGreaterThan(
                trigger.frame.minY, 0,
                "could not read the status bar height, and the bar's controls are at y=0"
            )
            print("NOTE: status bar height unavailable; skipped the exact inset assertions")
        }
    }
}
