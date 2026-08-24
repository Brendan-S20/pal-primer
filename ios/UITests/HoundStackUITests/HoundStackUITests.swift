// The device checks that need a real tap.
//
// Everything here was verified once by hand on 2026-08-20 and then became
// unreachable when the host's Accessibility grant was revoked mid-pass. These
// are the same checks, driven from inside the simulator so they can be re-run
// on any build by anyone, with no permission to grant and nothing to click.
//
// They assume the app is INSTALLED and SIGNED IN as the demo owner. Sign-in is
// deliberately not automated: it would put a real password in the repo, and the
// session survives app kills, so a human signs in once per simulator and every
// run after that is unattended. `README.md` says so next to the run command.

import XCTest

final class HoundStackUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Guard for every test below: if the app is signed out, the assertions
    /// about billing screens would "pass" against a sign-in form that simply
    /// does not contain the words we are asserting are absent. This is the same
    /// trap the Chromium sweeps document at length — "nothing is wrong" is true
    /// of a blank page — so prove we are inside the app before measuring it.
    ///
    /// It POLLS rather than reading the screen once, because a cold launch
    /// legitimately shows the sign-in form for a moment: the app boots at
    /// `capacitor://localhost/`, routes/index.tsx sends `/` to `/auth`
    /// unconditionally, and only then does the landing effect move a
    /// signed-in user onward. Asserting immediately catches that transient and
    /// reports a signed-in app as signed out — which is exactly what the first
    /// run of this harness did.
    private func requireSignedIn(_ app: XCUIApplication) {
        XCTAssertTrue(
            AppDriver.isSignedIn(app),
            "the app is signed out — sign in as the demo owner once on this simulator, then re-run"
        )
        // A first run puts the guided tour over the palette these tests
        // navigate by. Here rather than in `launch` so the poll cannot delay
        // the sign-in probe above. See AppDriver.dismissTourIfPresent.
        AppDriver.dismissTourIfPresent(app)
    }

    // MARK: - 1. The App Review gate

    /// A store build must offer no way to BUY or CHANGE a HoundStack plan, and
    /// must still show the plan you are on. The gate is `saasPurchaseAllowed`
    /// in src/lib/app-store-billing.ts; this is the only place it is exercised
    /// on a real iOS build rather than a stubbed platform.
    func testBillingGateHidesEveryPurchaseControl() throws {
        let app = AppDriver.launch()
        requireSignedIn(app)

        // Reach Settings › Billing through the command palette, which is the
        // shortest reliable path and needs no knowledge of the tab bar layout.
        AppDriver.openPalette(app)
        AppDriver.type(app, "billing")
        AppDriver.dismissKeyboard(app)
        AppDriver.tapInSection(app, section: "Settings", item: "Billing")

        // Proof of render BEFORE asserting absence — from the TOP of the page,
        // because arriving by palette can leave it scrolled and the card this
        // waits for sits above the fold.
        AppDriver.scrollToTop(app)
        AppDriver.waitFor(app, containing: "Current plan")
        AppDriver.screenshot("billing-gate-top", self)

        // The note must be PRESENT and must not name a destination.
        //
        // This assertion used to require the literal "managed on the web", and
        // that became the exact opposite of the rule on 2026-08-23: naming
        // where to go is the steer 3.1.1 cares about, so the copy changed to
        // "managed outside the mobile app" and this line was missed.
        //
        // What that cost is worth stating. `continueAfterFailure` is false, so
        // the test died HERE and never reached the five absence assertions
        // below — the device-level guard on the whole gate was a no-op wearing
        // a red X. Found by a QA runner on 2026-08-23, not by the suite.
        XCTAssertNotNil(
            AppDriver.find(app, containing: "outside the mobile app"),
            "the note telling the owner billing happens elsewhere is missing"
        )
        for steer in ["managed on the web", "houndstack.com", "on the web"] {
            XCTAssertNil(
                AppDriver.find(app, containing: steer),
                "the billing note names a destination (\(steer)) — that is the steer, not the purchase"
            )
        }

        for forbidden in [
            "Cancel subscription",
            "Resume subscription",
            "Payment methods",
            "Choose plan",
            "Switch to this plan",
        ] {
            XCTAssertTrue(
                AppDriver.isAbsent(app, forbidden),
                "“\(forbidden)” is reachable inside a store build"
            )
        }

        // The page continues below the fold; page through it so the absence
        // assertions above cover the whole route, not just the first screen.
        for i in 0..<4 {
            guard AppDriver.pageDown(app) else { break }
            AppDriver.screenshot("billing-gate-page-\(i + 2)", self)
            for forbidden in ["Cancel subscription", "Resume subscription", "Payment methods"] {
                XCTAssertTrue(
                    AppDriver.isAbsent(app, forbidden),
                    "“\(forbidden)” appeared further down the billing page"
                )
            }
        }
    }

    // MARK: - 2. Customer money must keep working

    /// The opposite of the gate above: a homeowner paying for pet-waste removal
    /// is a real-world service, outside IAP, and the operational point of the
    /// app. The card surfaces must be present.
    func testClientBillingKeepsItsPaymentSurfaces() throws {
        let app = AppDriver.launch()
        requireSignedIn(app)

        AppDriver.jumpTo(app, "Riverside")
        AppDriver.waitFor(app, containing: "Riverside HOA")
        try XCTSkipUnless(
            AppDriver.openClientBillingTab(app),
            "could not reach the client Billing tab — the demo client has no “No payment method on file” warning to click through"
        )
        AppDriver.screenshot("client-billing-payment-methods", self)

        XCTAssertNotNil(
            AppDriver.find(app, containing: "Add card"),
            "the saved-card surface is gone — customer payment must not be gated"
        )
    }

    /// The invoice amounts were clipped to a bare "$" on a 402pt screen because
    /// a six-column table inside `w-full` can never exceed its container, so
    /// `overflow-x-auto` never engaged. Below `md` the native build renders the
    /// shared InvoiceCard instead. A whole amount has to be legible.
    func testInvoiceAmountsAreLegibleOnAPhone() throws {
        let app = AppDriver.launch()
        requireSignedIn(app)

        AppDriver.jumpTo(app, "Riverside")
        AppDriver.waitFor(app, containing: "Riverside HOA")
        try XCTSkipUnless(
            AppDriver.openClientBillingTab(app),
            "could not reach the client Billing tab — the demo client has no “No payment method on file” warning to click through"
        )

        // Walk down to the invoices section.
        var sawInvoices = false
        for _ in 0..<6 {
            if AppDriver.find(app, containing: "Invoices") != nil { sawInvoices = true; break }
            guard AppDriver.pageDown(app) else { break }
        }
        XCTAssertTrue(sawInvoices, "never reached the Invoices section")
        AppDriver.screenshot("client-invoices-phone", self)

        // A complete amount — dollars AND cents. A bare "$" or "$1," is the
        // fault this test exists for.
        //
        // Read from ONE snapshot of the tree rather than by enumerating
        // elements. `allElementsBoundByIndex` re-queries per index, and this
        // page is still settling, so the run before this one died with
        // "No matches found for Element at index 64" — a stale handle reported
        // as a product failure. A single debugDescription cannot go stale.
        //
        // The pattern is a raw string, because getting a literal "$" through an
        // NSPredicate format needs enough escaping that the first attempt
        // matched nothing and blamed the app for it.
        let tree = app.debugDescription
        let amount = try XCTUnwrap(try? NSRegularExpression(pattern: #"\$[0-9,]+\.[0-9]{2}"#))
        let hasWholeAmount =
            amount.firstMatch(in: tree, range: NSRange(tree.startIndex..., in: tree)) != nil
        XCTAssertTrue(hasWholeAmount, "no invoice amount renders in full — the column is clipped again")
    }

    // MARK: - 3. Push tap → deep link

    /// `simctl push` delivers the payload; only a real tap on the banner
    /// exercises `pushNotificationActionPerformed`, which is the branch
    /// src/lib/native.ts guards with a same-origin check.
    ///
    /// The push itself is sent by the shell before this runs (see README), so
    /// this test's job is the tap and the destination. It skips rather than
    /// fails when no banner is present, because "no notification arrived" is a
    /// harness problem, not a product one, and a red test would misattribute it.
    func testTappingAPushNotificationLandsOnItsDeepLink() throws {
        // Start from a known place: signed in, then backgrounded, so the
        // notification arrives as a banner over the Home screen rather than as
        // a foreground presentation (which fires no
        // `pushNotificationActionPerformed` at all).
        let app = AppDriver.launch()
        requireSignedIn(app)
        XCUIDevice.shared.press(.home)
        sleep(3)

        // The shell sends the push on a loop while this waits — see
        // ios/UITests/send-push-and-test.sh. A banner only lives ~5s, and
        // `xcodebuild` takes far longer than that to start, so the push cannot
        // simply be sent beforehand.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        // The banner is a `BannerNotification`, NOT an `otherElement`, which is
        // why querying `springboard.otherElements["NotificationShortLookView"]`
        // found nothing while banners were plainly appearing on the recording.
        // Its tappable content is a real button, so ask for that by identifier
        // and fall back to any descendant carrying the banner's identifier.
        let contentButton = springboard.buttons["ShortLook.Platter.Content.Seamless"]
        let anyBanner = springboard
            .descendants(matching: .any)
            .matching(identifier: "NotificationShortLookView")
            .firstMatch

        let deadline = Date().addingTimeInterval(90)
        var target: XCUIElement?
        var dumped = false
        while Date() < deadline {
            if contentButton.exists { target = contentButton; break }
            if anyBanner.exists { target = anyBanner; break }
            // One snapshot of SpringBoard a little after the pushes start, so a
            // miss can be diagnosed from the result bundle instead of guessing
            // at identifiers again.
            if !dumped, Date().timeIntervalSince(deadline) > -50 {
                dumped = true
                let a = XCTAttachment(string: springboard.debugDescription)
                a.name = "springboard-tree"; a.lifetime = .keepAlways; add(a)
            }
            usleep(400_000)
        }
        let found = try XCTUnwrap(
            target,
            "no notification banner appeared within 90s — run this through send-push-and-test.sh"
        )
        AppDriver.screenshot("push-banner", self)
        found.tap()

        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: AppDriver.launchTimeout),
            "tapping the notification did not bring the app forward"
        )
        // Let the router act on the deep link.
        sleep(8)
        AppDriver.screenshot("push-landed", self)

        XCTAssertNotNil(
            AppDriver.find(app, containing: "My day"),
            "the notification carried /my-day but the app did not land there"
        )
    }
}
