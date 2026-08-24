// Opening a dialog must not open a native picker.
//
// Radix autofocuses the first focusable child of a dialog. On iOS, focusing a
// `<select>` makes WKWebView present the full-height system picker — so "New
// invoice", whose first field is the client select, opened with a 520pt list
// already covering it. Reproduced on an iPhone SE and an iPhone 16 Pro, from
// two entry points, every attempt.
//
// The picker is a SYSTEM surface: it belongs to SpringBoard-side UI, not the
// WebView, so this looks for it where it actually lives rather than in the
// app's own tree.
import XCTest

final class DialogFocus: XCTestCase {

    func testNewInvoiceDoesNotOpenTheNativePickerOnItsOwn() throws {
        let app = AppDriver.launch()
        AppDriver.dismissTourIfPresent(app)
        guard AppDriver.isSignedIn(app) else { throw XCTSkip("not signed in") }

        // Reached through the tab bar's More sheet, NOT the command palette.
        // The palette needs a keyboard, and typing into it is the single most
        // fragile step in this harness — the first draft of this test died in
        // `type` with "Neither element nor any descendant has keyboard focus"
        // on a device where the product was fine. A test whose navigation is
        // less reliable than the thing it measures reports noise.
        // Through the ➕ sheet's "New invoice" row, which routes to
        // /invoices?new=1 and opens the dialog on arrival. That is the real
        // entry point AND it is one tap, so nothing fragile sits between the
        // launch and the thing being measured.
        //
        // Not the More sheet: Invoices sits below its fold and needs scrolling
        // first, which is how the previous draft of this test skipped on both
        // phones while exiting 0.
        guard let create = AppDriver.find(app, containing: "Create") else {
            throw XCTSkip("no ➕ tab on this device — the tab bar is phone-only")
        }
        create.tap()
        sleep(2)
        // SUBSTRING, not exact. The sheet's rows carry a title AND a
        // description, and WebKit concatenates both into one accessibility
        // label — "New invoice" exactly matches nothing. An exact match here
        // skipped on both phones while exiting 0.
        guard let row = AppDriver.find(app, containing: "New invoice") else {
            throw XCTSkip("no New invoice row in the create sheet")
        }
        if row.isHittable { row.tap() } else {
            row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        sleep(5)
        AppDriver.screenshot("dialog-focus-opened", self)

        // The dialog itself must be readable — its description is the thing the
        // picker used to cut in half.
        XCTAssertNotNil(
            AppDriver.find(app, containing: "Bill a client directly"),
            "the New invoice dialog's description is not visible — something is covering it"
        )

        // A presented picker puts a Done/Cancel toolbar and a wheel on screen.
        // `pickerWheels` is the unambiguous one.
        XCTAssertEqual(
            app.pickerWheels.count, 0,
            "a native picker opened by itself when the dialog opened — \(app.pickerWheels.count) wheel(s)"
        )

        // LEAVE NOTHING BEHIND. ios/UITests/README.md documents this trap and
        // this test walked straight into it: an open dialog is a full-screen
        // overlay, so the next test in the same invocation cannot reach the app
        // underneath it. testBillingGateHidesEveryPurchaseControl failed for
        // three runs with "never found Current plan" — on a build where it
        // passed perfectly when run alone — because this test had left the New
        // invoice dialog on screen.
        //
        // Closing it is also the last assertion worth making here: a dialog
        // that cannot be dismissed is its own defect.
        if !AppDriver.tapExactIfPresent(app, "Close") {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)).tap()
        }
        usleep(1_500_000)
        XCTAssertNil(
            AppDriver.find(app, containing: "Bill a client directly"),
            "the New invoice dialog would not close"
        )
    }
}
