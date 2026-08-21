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

    /// The top inset on the Dynamic Island phones this is aimed at.
    private let statusBarInset: CGFloat = 59

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

        // `banner` is the <header>'s ARIA role, so this is the app's top bar
        // whatever it currently contains.
        guard let bar = AppDriver.find(app, containing: "banner") else {
            // Some builds surface the header only by its contents.
            throw XCTSkip("could not identify the header element")
        }

        XCTAssertEqual(
            bar.frame.minY, 0, accuracy: 2,
            "the top bar starts at \(bar.frame.minY)pt instead of 0 — the document is "
                + "inset (check ios.contentInset in capacitor.config.ts), so there is a band "
                + "of dead space above the bar and nothing fixed can reach the top of the screen"
        )

        // It has to be tall enough to hold the status bar AND its own row,
        // which is what proves it extends under rather than stops short.
        XCTAssertGreaterThan(
            bar.frame.height, statusBarInset + 40,
            "the top bar is only \(bar.frame.height)pt tall — too short to contain the "
                + "\(statusBarInset)pt status bar inset as well as its own controls"
        )

        // And its controls must sit clear of the clock and the Dynamic Island.
        guard let trigger = AppDriver.find(app, containing: "Search or jump") else {
            throw XCTSkip("no palette trigger on this surface")
        }
        XCTAssertGreaterThanOrEqual(
            trigger.frame.minY, 44,
            "the top bar's controls are drawn in the status bar strip (minY \(trigger.frame.minY))"
        )
        XCTAssertLessThan(
            trigger.frame.minY, statusBarInset + 40,
            "the top bar's controls start at \(trigger.frame.minY)pt — far enough down that "
                + "the inset has probably been applied twice"
        )
    }
}
