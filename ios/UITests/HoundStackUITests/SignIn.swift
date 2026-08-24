// Signing in through the app's own form.
//
// ── WHY THIS EXISTS NOW WHEN IT DELIBERATELY DID NOT BEFORE ───────────────
//
// Every other test here runs on a session that was already on the device, and
// docs/ios-qa-results.md records the gap that leaves: "signing in through the
// app's own form has never been tested", deliberately, because automating it
// would put a real password in the repository.
//
// The password does not have to be in the repository. It is read from the
// environment, and the test SKIPS when it is absent — so a checkout without
// credentials is not failed for not having them, and nothing is committed:
//
//     HS_EMAIL=… HS_PASSWORD=… xcodebuild test \
//       -only-testing:HoundStackUITests/SignIn …
//
// That closes the gap and does something else worth having: it is how a fresh
// simulator gets a session, which is what every other test in this target
// needs before it can do anything at all.
//
// ── THE FLOW IS TWO STEPS, NOT ONE ────────────────────────────────────────
//
// src/routes/auth.tsx asks for the email first and only reveals the password
// field after "Continue" — the same form serves sign-in and sign-up, and which
// one you are doing is not known until the address is checked. So this cannot
// fill both fields up front, and a test that tried would type a password into
// nothing.

import XCTest

final class SignIn: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testSigningInThroughTheForm() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["HS_EMAIL"], let password = env["HS_PASSWORD"],
              !email.isEmpty, !password.isEmpty
        else {
            throw XCTSkip("set HS_EMAIL and HS_PASSWORD to run this — nothing is stored in the repo")
        }

        let app = AppDriver.launch()

        // Already signed in from a previous run: nothing to prove, and signing
        // out first would make this test destroy the state it exists to create.
        if AppDriver.isSignedIn(app) {
            AppDriver.screenshot("signin-00-already", self)
            return
        }

        // STEP 1 — the address.
        // The placeholder is the most specific handle on it; the first text
        // field is the fallback, because a placeholder is copy and copy changes.
        let byPlaceholder = AppDriver.find(app, containing: "you@yourbusiness.com")
        let field = byPlaceholder ?? app.textFields.firstMatch
        guard field.waitForExistence(timeout: 20) else {
            XCTFail("no email field on /auth — the sign-in form did not render")
            return
        }
        field.tap()
        app.typeText(email)
        AppDriver.screenshot("signin-01-email", self)

        XCTAssertTrue(
            AppDriver.tapExactIfPresent(app, "Continue"),
            "no Continue button — the first step of the form is missing"
        )

        // STEP 2 — the password, which only exists after Continue.
        let pw = app.secureTextFields.firstMatch
        XCTAssertTrue(
            pw.waitForExistence(timeout: 20),
            "the password field never appeared after Continue — either the address was "
                + "rejected or the form did not advance"
        )
        pw.tap()
        app.typeText(password)
        AppDriver.screenshot("signin-02-password", self)

        XCTAssertTrue(
            AppDriver.tapExactIfPresent(app, "Sign in"),
            "no Sign in button on the password step"
        )

        // Landing is asynchronous: /auth bounces through a role lookup before it
        // knows which surface this person belongs on.
        XCTAssertTrue(
            AppDriver.isSignedIn(app),
            "signed in but never landed on a signed-in surface"
        )
        AppDriver.screenshot("signin-03-landed", self)
    }
}
