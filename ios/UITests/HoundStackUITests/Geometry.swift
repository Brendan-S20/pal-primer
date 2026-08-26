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

    /// Landscape puts the Dynamic Island on a SIDE, and nothing here insets for it.
    ///
    /// ── WHY THIS TEST EXISTS AND WHY IT NEEDS A REAL PHONE ────────────────
    ///
    /// `nativeTopBarStyle` and `nativeSidebarStyle` (src/lib/native-build.ts)
    /// set paddingTop and paddingBottom. Neither sets left or right. In
    /// portrait that is correct — the horizontal insets are 0. Rotate an
    /// Island phone and safe-area-inset-left (or right, depending on which way
    /// you turned it) becomes roughly 59pt, and anything at x=0 is behind the
    /// cutout.
    ///
    /// The iOS sweep on 2026-08-25 measured this and could not SEE it: the
    /// simulator does not draw the Island in landscape, so the pixels look
    /// fine while the geometry says otherwise. That is the whole reason this
    /// one is device-only.
    ///
    /// ── WHAT IT ASSERTS, AND WHAT IT ONLY REPORTS ─────────────────────────
    ///
    /// It compares the leading control's x in portrait against landscape on
    /// the SAME device in the SAME run. A device with a horizontal inset must
    /// move that control right when rotated; one without will not move it, and
    /// that is not a failure, so the strict assertion is gated on the device
    /// actually having an inset to apply. The numbers are printed either way
    /// and a screenshot is attached, because "no inset here" and "inset not
    /// applied" are the two answers and they must not look alike.
    func testLandscapeLeavesRoomForTheIsland() throws {
        let app = AppDriver.launch()
        AppDriver.dismissTourIfPresent(app)
        guard AppDriver.isSignedIn(app) else {
            throw XCTSkip("not signed in — sign in as the demo owner once on this device")
        }

        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 1.5)
        guard let portraitTrigger = AppDriver.find(app, containing: "Search or jump") else {
            throw XCTSkip("no palette trigger on this surface")
        }
        let portraitX = portraitTrigger.frame.minX
        let portraitWidth = app.windows.firstMatch.frame.width

        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2.5)

        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "landscape-left"
        shot.lifetime = .keepAlways
        add(shot)

        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "landscape-tree"
        tree.lifetime = .keepAlways
        add(tree)

        guard let landscapeTrigger = AppDriver.find(app, containing: "Search or jump") else {
            XCUIDevice.shared.orientation = .portrait
            throw XCTSkip("palette trigger not found in landscape")
        }
        let landscapeX = landscapeTrigger.frame.minX
        let window = app.windows.firstMatch.frame

        print("ISLAND-LANDSCAPE portraitWidth=\(portraitWidth) window=\(window) "
              + "portraitX=\(portraitX) landscapeX=\(landscapeX)")

        // Did the device rotate at all? If the window is not wider than tall,
        // nothing was measured and saying so beats asserting on portrait
        // numbers a second time.
        guard window.width > window.height else {
            XCUIDevice.shared.orientation = .portrait
            throw XCTSkip("device did not rotate; window is \(window)")
        }

        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 1.0)

        // ── ASSERT ON THE LEADING-MOST CONTROL, NOT ON THE PALETTE ─────────
        //
        // The first version of this compared the palette trigger's x between
        // orientations. It failed, but for a poor reason: that control sits at
        // 68pt and CLEARS a 59pt cutout by nine points. It failed only because
        // it did not move, which is evidence of no inset but not evidence of
        // anything being covered.
        //
        // The real question is whether ANY control is inside the cutout, so
        // that is what this measures. On this phone the answer was the sidebar
        // toggle at x=16, y=5 — the top-leading control, squarely under the
        // Island — plus 27 others.
        let inset = statusBarHeight()
        let leaves = app.descendants(matching: .any).allElementsBoundByAccessibilityElement
            .filter { el in
                let f = el.frame
                guard f.width > 1, f.height > 1 else { return false }
                // Containers legitimately span the full width; the header is
                // designed to paint under the status bar. Only leaf controls
                // are being asked to keep out of the cutout.
                guard f.width < window.width * 0.9 else { return false }
                switch el.elementType {
                case .button, .link, .staticText, .textField, .secureTextField,
                     .image, .switch, .searchField:
                    return true
                default:
                    return false
                }
            }

        guard let leftmost = leaves.map({ $0.frame.minX }).min() else {
            throw XCTSkip("no leaf controls found in landscape")
        }
        let insideCutout = leaves.filter { $0.frame.minX < inset }
        print("ISLAND-LANDSCAPE leaves=\(leaves.count) leftmost=\(leftmost) "
              + "inside=\(insideCutout.count) inset=\(inset)")
        // Name them. "40 controls are inside the cutout" sent me to fix the
        // sidebar twice; the elements themselves said map pins, and the two
        // disagreed because a debugDescription snapshot is taken at a different
        // instant than this query. Print the offenders so the next reader
        // argues with data instead of with me.
        for el in insideCutout.sorted(by: { $0.frame.minX < $1.frame.minX }).prefix(8) {
            let f = el.frame
            print(String(format: "  OFFENDER x=%.1f y=%.1f %.0fx%.0f type=%d label=%@",
                         f.minX, f.minY, f.width, f.height,
                         el.elementType.rawValue, el.label.isEmpty ? "(none)" : el.label))
        }

        // Only meaningful on a device that HAS a horizontal inset to apply. A
        // 20pt status bar means an SE-class phone with no cutout, where every
        // number above is correct and there is nothing to assert.
        guard inset >= 50 else {
            throw XCTSkip("this device's status bar is \(inset)pt — no Island, nothing to inset for")
        }

        XCTAssertGreaterThanOrEqual(
            leftmost, inset,
            "\(insideCutout.count) controls sit inside this device's \(inset)pt landscape "
                + "cutout, the leading one at x=\(leftmost) — the palette trigger clears it at "
                + "68pt but the sidebar toggle does not. nativeTopBarStyle and "
                + "nativeSidebarStyle (src/lib/native-build.ts) set only paddingTop and "
                + "paddingBottom; neither sets left or right, so rotating an Island phone "
                + "puts the top-leading controls under the cutout."
        )
    }
}
