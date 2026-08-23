# Building HoundStack for iPhone and iPad

Last updated 2026-08-20.

**What this document is for:** getting from a fresh clone to the app running on
your own iPhone or iPad, and knowing exactly which parts have been verified and
which have not.

---

## What was verified where

This matters more than usual here, because the container this project was
prepared in runs Linux and **cannot compile an iOS binary at all**. Xcode is
macOS-only. So the split is:

| | verified | how |
|---|---|---|
| `ios/` project generates | ✅ | `npx cap add ios`, 9 plugins registered |
| Web bundle builds for native | ✅ | `npm run build:native`, prerenders `index.html` |
| Bundle syncs into the app | ✅ | `npx cap sync ios`, 328 files into `App/App/public` |
| WebView loads the bundle, not a remote host | ✅ | `capacitor.config.json` `server` is `{}` |
| Typecheck / tests / web build | ✅ | 3041 passed, tsc clean, build clean |
| **Compiles in Xcode** | ✅ | 2026-08-20, Xcode 26.6 — `xcodebuild -scheme App -sdk iphonesimulator` |
| **Runs on a SIMULATOR** | ✅ | installs, launches, signs in, talks to production |
| **Runs on a DEVICE** | ❌ | needs a device + a signing team |
| **Camera capture, haptics, real airplane mode on hardware** | ❌ | needs a device |

Everything still marked ❌ is yours. The rest of this document is how to do it.

**A simulator pass has since happened, and it found things.** See
`docs/ios-qa-results.md`: what passed with evidence, seven failures (six now
fixed and re-verified, one diagnosed and deliberately left), and what a
simulator genuinely cannot answer. Read it before working through the device
checklist below — several boxes in it can now be ticked from that run, and the
ones that cannot are called out there by name.

---

## One-time setup

1. **A Mac with Xcode.** Xcode 15 or newer. Install the command line tools too:
   `xcode-select --install`.
2. **An Apple Developer account** ($99/year) if you want to run on a physical
   device for more than 7 days, or submit to the App Store. A free Apple ID can
   sideload to your own device with a 7-day certificate, which is enough to
   check that the app works.
3. **No CocoaPods needed.** Capacitor 8 generates a Swift Package Manager
   project. If you have followed older Capacitor guides expecting
   `pod install`, that step does not exist here.

## The loop

```bash
git clone <this repo> && cd pal-primer
npm ci
npm run cap:ios          # builds the web bundle, syncs it, opens Xcode
```

`cap:ios` is `build:native` → `cap sync ios` → `cap open ios`. If you only want
to refresh the bundle without opening Xcode, `npm run cap:sync`.

Then in Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. Set **Team** to your Apple Developer team. Xcode will provision
   `consulting.thenorth.houndstack` automatically.
3. Pick your device from the run destination menu and press ⌘R.

**Every time you change web code, run `npm run cap:sync` again.** The binary
serves a *copy* of the bundle from inside the app; editing `src/` and pressing
⌘R in Xcode will run the old copy. This is the single most common way to spend
an hour debugging a fix that is already correct.

### Live reload while developing

To point the WebView at a dev server on your LAN instead of the bundled copy:

```bash
CAP_SERVER_URL=http://192.168.1.10:8080 npx cap run ios
```

`capacitor.config.ts` derives `cleartext` from that URL, so permitting http for
a LAN dev server does not relax the shipped binary's transport policy. **Never
commit a `server.url`.** It was once hard-coded to a Lovable preview domain,
which meant a store build would have shipped pointing at a preview host and
could not start without network at all.

---

## What the app talks to

The bundled web app has no server of its own, so server functions are sent to
an absolute origin baked in at build time:

- default: `https://app.houndstack.com`
- override: `NATIVE_API_ORIGIN=https://staging.example.com npm run cap:sync`

Auth, Supabase and Stripe all behave exactly as they do on the web.

---

## Push notifications: code complete, capability not enabled

Both ends exist and are wired:

- **Device side** — `src/routes/_authenticated/route.tsx` registers for push on
  launch, hands the APNs token to `subscribeStaffNativePush`, and routes a
  notification tap to the deep link in the payload (`initPushDeepLinks`, which
  rejects any URL whose origin is not the app's own).
- **Server side** — `src/lib/push.server.ts` signs an ES256 JWT and posts to
  APNs over HTTP/2.

**Three things are not done, and none of them can be done from a repo:**

1. **Enable the Push Notifications capability in Xcode** (Signing &
   Capabilities → + Capability → Push Notifications). This writes an
   `App.entitlements` with `aps-environment`. There is no entitlements file in
   the project today, which is why this is listed rather than assumed.
2. **Create an APNs auth key** (`.p8`) in the Apple Developer portal.
3. **Set the server env vars**: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_AUTH_KEY`
   (raw .p8 contents), `APNS_TOPIC` (`consulting.thenorth.houndstack`), and
   `APNS_ENVIRONMENT` (`sandbox` while testing on a development build,
   `production` for TestFlight and the App Store).

Until those are done, `sendApns` returns `{ sent: 0, failed: 0 }`. It does not
throw and it does not report success — deliberately, so an unconfigured push
stack cannot look like a working one in the logs.

---

## Xcode Cloud

`ios/App/ci_scripts/ci_post_clone.sh` exists because a cloud build fails
without it, at the first step, like this:

```
the package at '/Volumes/workspace/repository/node_modules/@capacitor/
splash-screen' cannot be accessed (... doesn't exist in file system)
... and nine more
xcodebuild: error: Could not resolve package dependencies
Command exited with non-zero exit-code: 74
```

Nothing is wrong with the project. Capacitor references every plugin as a
LOCAL Swift package — `ios/App/CapApp-SPM/Package.swift` is a list of
`path: "../../../node_modules/@capacitor/…"` — and a fresh clone has no
node_modules. Xcode Cloud does not run `npm ci`, so it resolves packages
against paths that do not exist yet. `ci_post_clone.sh` is the only hook that
runs early enough to create them.

**It also builds and syncs the web bundle, and that half matters more.**
`ios/App/App/public` is gitignored, so a cloud checkout has no web assets at
all. Without the build+sync the archive still SUCCEEDS and ships a native shell
wrapped around nothing — a worse failure than the one above, because it does
not announce itself. The script hard-fails if `index.html` is missing
afterwards rather than letting that through.

**No secrets are needed.** The Supabase URL and anon key are hardcoded in
`src/integrations/supabase/client.ts`, and `NATIVE_API_ORIGIN` defaults to
production in `vite.config.ts`. Nothing has to be configured in Xcode Cloud for
the build to be correct.

**Two copies, on purpose.** Apple documents two locations for `ci_scripts`: the
repository root, and the directory containing the Xcode project. This project
is at `ios/App`, so which one applies is not settleable by reading — and
guessing wrong costs a full cloud build to discover, because the symptom is
identical to having no script at all. The implementation is next to the
project; `ci_scripts/ci_post_clone.sh` at the root is a four-line forwarder.
Xcode Cloud picks one location, so only one ever runs.

Verified locally by running the script from an unrelated working directory and
then executing the command Xcode Cloud itself runs:

```
xcodebuild -resolvePackageDependencies -project App.xcodeproj -scheme App
  → Resolved source packages: CapacitorCamera, CapacitorPushNotifications, …
```

**Not verified:** the `brew install node@22` branch. Node is already present on
this machine, so that path is reasoned rather than executed. It is pinned to
the major `.github/workflows/ci.yml` uses so the cloud and the gate agree.

## Automated device tests

`ios/UITests/` is a standalone XCUITest project that drives the app by bundle
id, so `npx cap add ios` regenerating `ios/App` cannot clobber it. It runs
inside the simulator and needs no macOS Accessibility grant. Read
`ios/UITests/README.md` before adding to it — selectors over a WebView are the
hard part and the traps are written down there.

```bash
# everything except the two that need arranging around them
xcodebuild test-without-building -project ios/UITests/UITests.xcodeproj \
  -scheme HoundStackUITests -destination "platform=iOS Simulator,id=<UDID>" \
  -derivedDataPath /tmp/hs-uitests \
  -skip-testing:HoundStackUITests/HoundStackUITests/testTappingAPushNotificationLandsOnItsDeepLink \
  -skip-testing:HoundStackUITests/TourWalk CODE_SIGNING_ALLOWED=NO

ios/UITests/send-push-and-test.sh <UDID>                    # push deep link
ios/UITests/run-tour-test.sh <UDID> <email> <password>      # first-run tour
```

Sign in once on the simulator as the demo owner first; sign-in is deliberately
not automated, and the session survives app kills.

**The simulator wedges after roughly twenty app launches.** Every test then
fails with `Failed to launch …: Timed out attempting to launch app`, which is
CoreSimulator and not the app — at its worst even `xcrun simctl io … screenshot`
stops responding. `xcrun simctl shutdown <UDID> && xcrun simctl boot <UDID>`
clears it. Re-apply the status-bar override afterwards if the screenshots are
going into a report.

**A launch takes 40-60s to paint after a fresh boot, not 20.** The screen is
`rgb(0,0,0)` the whole time. It is worth knowing exactly what that is, because
it looks alarming and is not: WebKit logs `didCommitLoadForFrame` and
`didFinishLoadForFrame` with no crash, and a screenshot at ~60s reads white. The
page is loading; the simulator is just slow after a boot.

Do not conclude anything from a screenshot taken too early. Three launches
sampled at 22s each read pure black here and were misread as a broken app; the
same build was rendering perfectly a few seconds later, and the suite then went
green on the first attempt. Warm it up and SAMPLE LATE:

```bash
xcrun simctl launch <UDID> consulting.thenorth.houndstack && sleep 60
xcrun simctl io <UDID> screenshot /tmp/warm.png   # should not be black
```

Worth doing because otherwise the first test in the run absorbs the delay, and
"the app was still painting" and "the app is broken" produce the same red.

## Device QA that cannot be done any other way

The static tests and the Chromium sweeps cover a lot, but not these. Each one
needs a real iPhone or iPad, and the simulator is explicitly not enough for the
ones marked 📵.

```
[ ] Camera: complete a visit with a photo. Confirm the NATIVE camera opens,
      not a web file picker, and the photo lands on the visit.
[ ] Camera: log a DNA sample with a photo.
[ ] Location: open the route map, press locate. Confirm the iOS permission
      sheet appears, and the blue-grey dot with its accuracy ring lands in the
      right place.
[ ] Location denied: decline the prompt, press locate again. Confirm the
      message names Settings › HoundStack › Location and does NOT mention
      https or browser site settings.
[ ] Haptics fire on visit start/complete and nowhere annoying.
[ ] 📵 Airplane mode: offline banner appears, My Day shows the last-synced
      day, cached routes still render, and NO screen goes blank.
[ ] 📵 Airplane mode: start and complete a visit. Confirm the toast says it is
      queued, the button releases, and the work replays when signal returns.
[ ] 📵 Background the app in a dead zone, return to signal, reopen. Confirm
      the app knows it was offline (this is the case @capacitor/network was
      wired for; navigator.onLine alone reports stale `true` here).
[ ] Push: receive a notification, tap it, confirm it lands on My Day or the
      right thread rather than the app's default screen.
[ ] iPad: run in Split View and Slide Over at half and third widths. The
      layouts are tested at 768px in Chromium but not in real multitasking.
[ ] iPad: rotate. All four orientations are permitted on iPad, two plus
      landscape on iPhone.
[ ] Safe areas: confirm nothing sits under the notch, the Dynamic Island, or
      the home indicator, in both orientations.
[ ] Status bar: dark icons on the cream background, at launch and after boot.
[ ] Billing: sign in as an owner and open Settings › Billing. Confirm there is
      NO way to buy or change a plan, no card-on-file form, and no platform
      add-ons — only the current plan and the "managed on the web" note.
[ ] Billing: confirm a STAFF invoice payment still works (that one is a
      real-world service and must keep working). See
      docs/app-store-submission.md for why the two differ.
```

---

## Known gaps, stated rather than discovered later

- **`@capacitor/preferences` is installed and unused.** No native local state
  needs it yet: auth tokens live where Supabase puts them and the offline queue
  is IndexedDB, which is the right store for it. Left installed rather than
  wired, deliberately — it is not a place to put anything sensitive.
- **`@capacitor/splash-screen` is now called.** It used to hide on its own
  timer, and the 2026-08-20 QA pass measured what that cost: the splash lifted
  1.5s in and revealed a BLANK WHITE screen for 5.3 seconds before the app
  painted. `src/routes/__root.tsx` now calls `SplashScreen.hide()` after the
  first paint, and `launchShowDuration` is a 20-second backstop rather than the
  mechanism. This was the "if launch ever needs to wait for a real readiness
  signal" case this note used to anticipate.
- **Neither of the above is covered by `check:dead-machinery`**, which scans
  `src/` exports rather than npm dependencies. An installed-but-uncalled plugin
  is invisible to it.
- **Android has not been generated.** `capacitor.config.ts` carries Android
  settings and the store-policy gate already covers it (see
  `src/lib/app-store-billing.ts`), but `npx cap add android` has not been run.
