// The desktop sidebar has to respect the safe area too.
//
// `ios.contentInset: "never"` moved the document to y=0 so the top bar could
// extend under the status bar. The sidebar is `fixed inset-y-0` and went with
// it, unpadded: the wordmark sat under the clock and the account row sat in the
// home-indicator strip, on every iPad screen, in both orientations.
//
// The sidebar is `md:flex`, so it does not exist on a phone — which is why the
// original fix was verified on the one device class that cannot show the bug.
// This test only means anything on a tablet and says so rather than passing
// vacuously on a phone.
import XCTest

final class SidebarInset: XCTestCase {

    private let topInset: CGFloat = 24    // iPad status bar; phones are larger
    private let bottomInset: CGFloat = 20 // iPad home indicator strip

    func testTheSidebarClearsTheStatusBarAndHomeIndicator() throws {
        let app = AppDriver.launch()
        AppDriver.dismissTourIfPresent(app)
        guard AppDriver.isSignedIn(app) else { throw XCTSkip("not signed in") }

        guard AppDriver.find(app, containing: "HoundStack")?.frame.height ?? 0 > 0 else {
            throw XCTSkip("no sidebar on this device — it is md:flex, so a phone has none")
        }

        // BOTH ORIENTATIONS. A tablet is a different layout in each, and the
        // insets are not the same: the home indicator is on the short edge, so
        // the bottom clearance a portrait run proves says nothing about
        // landscape. The original fault was present in both.
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            usleep(1_500_000)
            let label = orientation == .portrait ? "portrait" : "landscape"

            guard let wordmark = AppDriver.find(app, containing: "HoundStack") else {
                XCTFail("\(label): the sidebar wordmark vanished")
                continue
            }
            let screen = app.frame

            XCTAssertGreaterThanOrEqual(
                wordmark.frame.minY, topInset,
                "\(label): the sidebar wordmark starts at \(wordmark.frame.minY)pt, inside the "
                    + "status bar strip — the clock is drawn across it"
            )

            // The lowest thing in the sidebar: the account row at the bottom.
            if let account = AppDriver.find(app, containing: "Olivia Owner") {
                let bottomGap = screen.maxY - account.frame.maxY
                XCTAssertGreaterThanOrEqual(
                    bottomGap, bottomInset,
                    "\(label): the sidebar's account row ends \(bottomGap)pt from the screen "
                        + "edge — part of a 44pt target is inside the home-indicator gesture strip"
                )
            }
            AppDriver.screenshot("sidebar-inset-\(label)", self)
        }
        XCUIDevice.shared.orientation = .portrait
    }
}
