# Device UI tests

XCUITest automation for the HoundStack iOS app. Runs **inside** the simulator,
so it needs no macOS Accessibility permission and cannot be revoked mid-run.

## Why this exists

The 2026-08-20 QA pass drove the simulator from the host with AppleScript, which
needs Accessibility. Mid-pass macOS revoked the grant, and re-granting does not
reach a process that is already running — Terminal would have had to be
relaunched, killing the session doing the testing. Three device checks were left
unfinished with no way back to them. Those three are the tests in here.

`ios-webkit-debug-proxy` was tried first and does not work against a simulator:
its `--simulator-webinspector` socket (`com.apple.webinspectord_sim`) is
launch-on-demand and only exists while Safari's Develop menu is attached, which
needs the GUI that was unavailable. Noted so nobody spends the same hour.

## Why a separate project

`ios/App/App.xcodeproj` belongs to Capacitor — `npx cap add ios` regenerates it
and upgrades touch it, so a target added there is a target that can be clobbered
by a tool that knows nothing about it. This project is standalone and drives the
app by **bundle id**, so it never references the app target and keeps working
even if the app project is regenerated from scratch.

## Running

Sign in **once** on the simulator as the demo owner. Sign-in is deliberately not
automated — that would put a real password in the repo — and the session
survives app kills, so every run after the first is unattended.

```bash
# 1. Build and install the app itself (from the repo root)
npm run cap:sync
cd ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=<SIM>' \
  -derivedDataPath /tmp/hs-dd CODE_SIGNING_ALLOWED=NO build
xcrun simctl install <SIM> /tmp/hs-dd/Build/Products/Debug-iphonesimulator/App.app

# 2. Build the tests once
xcodebuild build-for-testing -project ios/UITests/UITests.xcodeproj \
  -scheme HoundStackUITests -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=<SIM>' \
  -derivedDataPath /tmp/hs-uitests CODE_SIGNING_ALLOWED=NO

# 3. Run everything except the two that need their own invocation
xcodebuild test-without-building -project ios/UITests/UITests.xcodeproj \
  -scheme HoundStackUITests -destination 'platform=iOS Simulator,name=<SIM>' \
  -derivedDataPath /tmp/hs-uitests -resultBundlePath /tmp/hs.xcresult \
  -skip-testing:HoundStackUITests/HoundStackUITests/testTappingAPushNotificationLandsOnItsDeepLink \
  -skip-testing:HoundStackUITests/TourWalk \
  CODE_SIGNING_ALLOWED=NO

# 4. The push test needs a notification delivered while it waits
ios/UITests/send-push-and-test.sh <SIM>

# 5. The tour walk needs the tour to be unseen
ios/UITests/run-tour-test.sh <SIM> <email> <password>
```

### Why two tests get their own script

Both need something arranged around them that `xcodebuild` cannot hold still.

**The push test** watches for a banner that lives about five seconds, and
`xcodebuild` takes far longer than that to start. The test backgrounds the app
and watches for up to 90s; the script sends a push every 8s until it finishes.

**The tour walk** needs a FIRST RUN, and there is only ever one. `reset-tour.sh`
makes the tour available once; whichever test launches the app first consumes
it. Every other test dismisses it deliberately — see below — so running the
whole suite after a reset passes the others and *skips* TourWalk. A skip reads
almost exactly like a pass in a log, which is the whole reason the script
exists.

### The tour blocks the palette, and the error says neither word

Most tests here navigate by the command palette. The first-run tour is a
full-screen modal over it, so while it is up `tap` silently misses and `type`
fails with:

```
Failed to synthesize event: Neither element nor any descendant has keyboard focus
```

which names nothing to do with a tour. `AppDriver.dismissTourIfPresent` handles
it, and two details of how are load-bearing:

* It **polls**. The tour renders only once `useMyRole` has resolved and the auth
  user has come back, a second or two after first paint — a single check right
  after launch finds nothing and the tour appears afterwards anyway.
* It is called **after** `isSignedIn`, never from `launch`. In front of the
  sign-in probe its polling made that probe time out, which turned two tests
  from failing into *skipped*.

The push test gets its own script because a banner lives about five seconds and
`xcodebuild` takes far longer than that to start. The test backgrounds the app
and watches for up to 90s; the script sends a push every 8s until it finishes.

## Getting the screenshots out

Every test attaches screenshots with `lifetime = .keepAlways`, so they survive a
pass. Pull them from the result bundle:

```bash
xcrun xcresulttool export attachments \
  --path /tmp/hs.xcresult --output-path /tmp/shots \
  --test-id "HoundStackUITests/testBillingGateHidesEveryPurchaseControl()"
```

`manifest.json` in the output maps the UUID filenames back to the attachment
names. Note the test id has **no** target prefix — `HoundStackUITests/<test>()`,
not `HoundStackUITests/HoundStackUITests/<test>()`, which is what
`-only-testing` wants. `xcrun xcresulttool get test-results tests --path …`
prints the ids if in doubt.

## Writing new tests

Selectors are the hard part, because everything on screen is DOM inside a
WKWebView surfaced through WebKit's accessibility bridge. Four things cost real
time to discover, all of them handled in `AppDriver.swift`:

1. **Element types do not map from HTML.** A clickable `<div>` arrives as
   `.other`, not `.button`. `AppDriver.find` searches across types.
2. **Frames are in the WebView's own coordinate space.** A palette row reports
   440pt wide on a 402pt screen, so coordinate taps derived from a frame land
   nowhere near the element. Prefer `AppDriver.jumpTo` (which activates the
   palette's selected row with Return) and window-normalised swipes.
3. **Short labels are ambiguous.** Typing "billing" leaves a *Billing* section
   header and a *Billing* row under *Settings* on screen; a substring match taps
   the header. Use `tapExact` or `tapInSection`.
4. **The keyboard covers the bottom half.** The palette opens focused, so
   results below the fold are in the tree, "tappable", and actually behind a
   keycap. `dismissKeyboard` first — and CHECK WHAT IT RETURNS. It reports
   whether the keyboard actually went, because "Done" is not always a button
   labelled Done: above a web input it is a checkmark glyph, and whether it is
   hittable depends on where the keyboard is in its animation. Tapping a result
   with the keyboard still up presses a letter instead.
5. **One stuck overlay fails every test after it.** The failure above left the
   palette open across the whole app, and the NEXT surface then spent 30s
   unable to find a top bar the palette was covering — 40s of silence pointing
   at somewhere entirely innocent. `AppDriver.closePaletteIfOpen` at the top of
   each iteration keeps one real failure from becoming four confusing ones.
   When a run has several failures, distrust all but the first.

When a selector misses, dump the tree rather than guessing:

```swift
let a = XCTAttachment(string: app.debugDescription)
a.name = "tree"; a.lifetime = .keepAlways; add(a)
```

then export it as above. SpringBoard has its own tree —
`XCUIApplication(bundleIdentifier: "com.apple.springboard").debugDescription` —
which is how the notification banner's real identity was found
(`BannerNotification` / `ShortLook.Platter.Content.Seamless`, **not** an
`otherElement`, which is why the first version watched for a banner that was on
screen the whole time).

## What these cover

| test | checks |
|---|---|
| `testBillingGateHidesEveryPurchaseControl` | App Review gate: read-only plan and the "managed on the web" note are present; Cancel/Resume subscription, the card form, the add-ons and every plan-picker control are absent, across the whole scrolled route |
| `testClientBillingKeepsItsPaymentSurfaces` | the opposite half — a tenant taking a customer's money still has Payment methods and Add card |
| `testInvoiceAmountsAreLegibleOnAPhone` | invoice amounts render in full at phone width, rather than clipping to a bare `$` |
| `testTappingAPushNotificationLandsOnItsDeepLink` | tapping a delivered notification routes to the payload's `url` instead of the app's default screen |
| `Geometry/testTheTopBarStartsAtTheTopOfTheScreen` | the document, and the top bar with it, begin at y=0 — the guard on `ios.contentInset`, which was inseting the whole page by the safe area and costing 62pt at the top of every screen |
| `TourWalk/testTourWalksThroughTheAppAndStaysDismissed` | the guided tour actually navigates to each area it describes, and stays gone after a relaunch |

## A screenshot cannot tell you where the WebView is

`Geometry` exists because two very different faults look identical in a PNG: a
WebView that does not reach the top of the screen, and a WebView that does while
the document inside it starts low. White above a white header is white either
way. The accessibility tree reports frames in screen points and separates them —
it put `<body>` at y=62 inside a WebView measured `{{0,0},{402,874}}`, which
named `ios.contentInset` as the cause and the CSS as innocent. Reach for
`app.debugDescription` before reaching for another screenshot.

Still needing a **physical device**, not reachable here: camera capture landing
on a visit, haptics, real airplane mode, and Slide Over. See
`docs/ios-qa-results.md`.
