// The first-run guided tour, walked end to end on a phone.
//
// Two things this is really testing, both of them things the tour got wrong.
//
// 1. IT HAS TO TAKE YOU THERE. Every step anchored to `[data-tour=…]`, which
//    only ever existed on AppSidebar items — and the sidebar is hidden below
//    `md`. So on a phone the anchor was never found, every step fell back to a
//    centred card over a dimmed screen, and eight cards later nobody had been
//    shown where anything lives. The tab bar now carries the same anchors, and
//    each step navigates to the area it describes.
//
// 2. DISMISSING IT HAS TO STICK. "Seen" lived only in
//    `user_metadata.tour_seen_at`, read over the network, and the read failed
//    OPEN: offline `data.user` is undefined, so the tour started. iOS QA
//    2026-08-21 watched it do that on every offline launch. The last test here
//    is the regression guard — finish the tour, relaunch, it must be gone.
//
// Needs the tour to be UNSEEN to start. See ios/UITests/reset-tour.sh.

import XCTest

final class TourWalk: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testTourWalksThroughTheAppAndStaysDismissed() throws {
        var app = AppDriver.launch()
        guard AppDriver.isSignedIn(app) else {
            throw XCTSkip("not signed in — sign in as the demo owner once on this simulator")
        }

        guard AppDriver.waitForExists(app, containing: "Welcome to", timeout: 25) else {
            throw XCTSkip("the tour did not start — run ios/UITests/reset-tour.sh first")
        }
        AppDriver.screenshot("tour-01-welcome", self)
        XCTAssertNotNil(
            AppDriver.find(app, containing: "Skip tour"),
            "no way out of the tour on its first step"
        )

        AppDriver.tapExact(app, "Start the tour")

        // Walk the rest. The step count is role-dependent (steps are filtered
        // by `canAccess`), so follow the buttons rather than assuming eight.
        var visited: [String] = []
        for step in 2...12 {
            usleep(1_800_000)
            AppDriver.screenshot("tour-\(String(format: "%02d", step))", self)

            // Whatever this step is about should be named on the card.
            for title in ["Dashboard", "Clients", "Zones", "Routes", "My Day", "Invoices", "Settings"] {
                if AppDriver.find(app, containing: title) != nil, !visited.contains(title) {
                    visited.append(title)
                    break
                }
            }

            // The card itself must still be there. This is the blank-screen
            // guard: when step 8 navigated in a circle the app rendered nothing
            // at all, and every "is anything wrong" assertion below passes
            // happily on a blank page. Failing HERE names the step that did it.
            XCTAssertNotNil(
                AppDriver.find(app, containing: "Skip tour"),
                "the tour card vanished at step \(step) without anyone dismissing it"
            )

            if AppDriver.tapExactIfPresent(app, "Done") { break }
            guard AppDriver.tapExactIfPresent(app, "Next") else {
                // Was a silent `break`, which turned "the tour is stuck" into
                // "the tour ended" and let the run reach the final assertion
                // with no idea why.
                XCTFail("step \(step) offered neither Next nor Done — the tour is stuck")
                break
            }
        }

        // It should have walked several distinct areas, not sat on one screen.
        XCTAssertGreaterThanOrEqual(
            visited.count, 4,
            "the tour only ever named \(visited) — it is not walking the app"
        )

        // Gone once finished.
        usleep(1_500_000)
        AppDriver.screenshot("tour-99-finished", self)
        XCTAssertNil(
            AppDriver.find(app, containing: "Skip tour"),
            "the tour is still up after Done"
        )

        // THE REGRESSION GUARD: it must not come back on the next launch.
        app.terminate()
        app = AppDriver.launch()
        _ = AppDriver.isSignedIn(app)
        usleep(4_000_000)
        AppDriver.screenshot("tour-100-after-relaunch", self)
        XCTAssertNil(
            AppDriver.find(app, containing: "Welcome to"),
            "the tour came back after being completed — the dismissal did not stick"
        )
    }
}
