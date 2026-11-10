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
- staging: `npm run build:native:staging` with `NATIVE_API_ORIGIN`,
  `NATIVE_SUPABASE_URL` and `NATIVE_SUPABASE_PUBLISHABLE_KEY` set, then
  `npx cap sync ios`. Not `npm run cap:sync`, which rebuilds for production
  first. What the staging host has to be, and why a dev server cannot stand
  in for it, is in `docs/native-qa-staging.md`.

Auth, Supabase and Stripe all behave exactly as they do on the web.

---

## Push notifications

**State on 2026-10-03:** code complete end to end; the APNs key exists and all
five `APNS_*` values are set as Lovable project secrets. What is left is two
owner checks in the Apple portal and on a phone — the checklist at the end of
this section.

### What sends a push

Every in-app notification (the bell, `/notifications`) is also pushed to each
recipient's registered devices — iOS app, Android app, and any browser they
turned push on in — by `notifyUsers` in `src/lib/notify-center.server.ts`.
Mutes in Settings › Notifications apply to both. The tap opens the row's link.

| Event | Who | Opens |
|-------|-----|-------|
| Inbound text needs a reply (`inbound_sms`) | owner, office manager, dispatcher | /messages |
| AI receptionist escalation | owner, office manager, dispatcher | /messages |
| Client says do not enter (gate) | owner, office, dispatcher, tech | /my-day |
| New concern / re-clean / extra cleanup (portal) | owner, office manager | /concerns |
| Add-on requested (portal) | owner, office manager | the client's Services tab |
| Quote accepted or declined | owner, office manager | the quote |
| Client payment failed | owner, office manager | /invoices |
| Refund failed / payout failed / fraud warning on a payment | owner, office manager | /notifications (these rows carry no link) |
| Webhook switched off after failing | owner, office manager | /settings/webhooks |
| Teammate joined | owner, office manager | /settings/users |
| Trial ending | owner | /settings/billing |

In-app only, deliberately: `schedule.horizon` (the nightly "schedule filled
through…" summary — it runs in the small hours) and `payout_paid` (good news,
nothing to do). And `field_collection` (cash/check a tech collected) is written
by a SQL function straight into `app_notifications`, so it does not pass
through `notifyUsers` and is not pushed.

Separately, a completed visit pushes the CUSTOMER (`sendPushToClient` in
`my-day.functions.ts`) — that is web push to the portal, not the iOS app.

### How the pieces connect

- **Entitlement** — `ios/App/App/App.entitlements` carries `aps-environment`
  = `development`, which is what Xcode's Push Notifications capability writes.
  That is correct for TestFlight too: Apple signs the entitlement from the
  provisioning profile, and a distribution profile (every Xcode Cloud archive)
  makes it `production`. Writing `production` in the file would break a Debug
  run from Xcode against a development profile. No `SystemCapabilities` block
  is added to the pbxproj — modern Xcode does not use one, and Sign in with
  Apple is declared the same way, by entitlement only.
- **AppDelegate** — forwards `didRegisterForRemoteNotificationsWithDeviceToken`
  and `didFailToRegister…` to the plugin. Without these two methods iOS mints a
  token and nothing hears it.
- **No background mode.** `UIBackgroundModes` / `remote-notification` is for
  silent (`content-available`) pushes; every push here is a visible alert.
- **Device** — `registerPushNotifications` (`src/lib/native.ts`) runs from the
  signed-in shell, so the permission prompt appears right after the first
  sign-in and never on the sign-in screen. It runs on every launch, which is
  how a rotated token reaches the server. Sign-out deletes this device's token
  from the signed-out user (`releasePushRegistration`), and the next person to
  sign in on a shared iPad takes the token over.
- **A way to ask again** — Settings › Preferences › "Notifications on this
  phone" (`src/components/settings/NativePushCard.tsx`, native only) shows the
  permission state. Not yet asked: a button that brings up the iOS prompt
  through `turnOnPushNotifications`, the same path the shell takes. On: "Send
  me a test notification" (`sendMyselfTestPush`, caller's own devices only,
  once per 30 seconds) and the number of devices it reached, so 0 says the
  token never reached the server. Denied: iOS never asks twice, so a button
  opens `app-settings:`, which Capacitor's WebView hands to
  `UIApplication.open`, and the text says Settings › HoundStack ›
  Notifications.
- **Monitoring** — a start-up step that throws, an APNs `registrationError`, a
  token the server would not save, and (once per launch, as a warning) a
  permission that did not end up granted all reach Sentry, tagged
  `area: native_push` or `native_startup` plus `step`. The permission report
  says `push_prompt: asked` or `not_asked`, which is what tells "said no" from
  "iOS already had an answer".
- **Storage** — `subscribeStaffNativePush` → `savePushSubscription`. It used to
  upsert on `native_token`, a column unique only through a PARTIAL index, which
  Postgres cannot infer from `ON CONFLICT (native_token)` — every registration
  failed. No migration was needed to fix it.
- **Server** — `src/lib/push.server.ts`, token auth with the `.p8` key (not a
  certificate). ES256 via WebCrypto, provider token cached 50 minutes (Apple
  rejects one regenerated more than every 20), host from `APNS_ENVIRONMENT`.
  A 410 or `BadDeviceToken` switches that device's row off
  (`disabled = true`, reason in `last_error`). Missing or unreadable
  credentials are logged once and skipped; nothing throws into the action that
  raised the notification. `APNS_AUTH_KEY` may be pasted with real newlines,
  literal `\n`, or flattened — it is normalised before import.
- **HTTP/2** — APNs refuses HTTP/1.1. The deployed server is a Cloudflare
  Worker, whose fetch reaches Apple over HTTP/2. **Local `npm run dev` runs on
  Node, whose fetch is HTTP/1.1, and cannot deliver to APNs** — test on the
  deployed app.

### Environment, and why a phone may not buzz

`APNS_ENVIRONMENT=production` matches TestFlight and App Store installs, which
are all Xcode Cloud builds. An app run from Xcode on a cable gets a SANDBOX
token; production APNs answers `BadDeviceToken` for it, and the server switches
that row off. That is expected — to test a cable build, temporarily set
`APNS_ENVIRONMENT=sandbox`, and set it back.

### Owner checklist

1. ~~Create an APNs auth key (`.p8`) in Apple Developer › Keys.~~ **Done.**
2. ~~Set `APNS_AUTH_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_TOPIC=consulting.thenorth.houndstack`, `APNS_ENVIRONMENT=production`
   as Lovable project secrets.~~ **Done.**
3. **Confirm Push Notifications is ticked on the App ID.** developer.apple.com ›
   Certificates, Identifiers & Profiles › Identifiers ›
   `consulting.thenorth.houndstack` › Capabilities › Push Notifications ✓ ›
   Save. (Ignore the "Configure" button beside it — that is for certificate
   auth, which this app does not use.) Xcode Cloud's automatic signing
   regenerates the profile with the entitlement on the next build; nothing to
   do in Xcode.
4. **Let Xcode Cloud build from `main` (#322 merged 2026-10-03), install that TestFlight build**
   (the push code is in the binary: an older build has no AppDelegate forward
   and cannot receive anything).
5. **Test on the phone.** Open the app, sign in, tap **Allow** on the
   notification prompt. Then, from another device, cause an event for that
   user — the quickest is texting the business number from a phone that is a
   client (`inbound_sms` → owner, office manager, dispatcher), or a portal
   concern. The phone should buzz; tapping it should open /messages (or
   /concerns). Try once with the app open (banner) and once with it closed.
6. **If nothing arrives,** look at that user's row in `push_subscriptions`
   (Supabase › Table editor, filter `platform = ios`): no row means the token
   never registered (check step 3, and that you allowed notifications in iOS
   Settings › HoundStack); `last_error` holds Apple's reason otherwise —
   `InvalidProviderToken` is a wrong key/key id/team id, `BadDeviceToken` is an
   environment mismatch, `TopicDisallowed` is step 3.

The device QA list below still carries the push item; it is step 5.

---

## The route on the lock screen (Live Activity)

**State on 2026-10-04:** built, and seen on a simulator (iPhone 17 Pro, iOS
26.5) on the lock screen, in the Dynamic Island (compact and expanded) and in
Arabic, started and updated through the same JS bridge My Day uses. Not yet
seen: a remote update from the server reaching a phone, which needs a real
device (below).

What a tech sees: "Stop 5 of 12", a progress bar, the next stop's property
label or street (never the customer's name), its arrival window, and done and
skipped counts, in the language the phone is set to.

### The buttons (2026-10-07)

On iOS 17 and later the lock screen and the expanded Dynamic Island carry two
buttons, in the tech's language: **Navigate**, and **Start** (a stop not yet
started) or **Complete** (a stop under way). On 16.2 to 16.x the card is drawn
exactly as before, without them. A tap anywhere else on the card opens My Day
on the stop, on every version (`widgetURL`).

All three are plain SwiftUI `Link`s. Nothing runs in the extension, nothing
in the path holds a session or calls the HoundStack API, and no App Intent,
target, entitlement or capability was added, so there is no portal step.

- **Navigate** opens the same Google Maps directions link My Day's own
  Navigate button opens, to the property's coordinates (or its address when it
  has none). iOS does not open a Live Activity's link itself: it gives every
  URL tapped on the card to the app that owns it, the Google one included
  (measured on the simulator), so `SceneDelegate` recognises the directions
  link, rebuilds it with `RouteLinks.directionsHandOff`, and opens it from the
  app. HoundStack comes forward for a moment and Google Maps, or Safari when it
  is not installed, takes over. It does not send the customer's "on my way"
  that My Day's Navigate can; that needs the API.
- **Start / Complete** open
  `consulting.thenorth.houndstack://open/my-day?date=…&visit=…&action=start|complete`.
  `initAppLinks` (`src/lib/native.ts`) passes it through
  `src/lib/live-activity-links.ts`, which rebuilds a `/my-day` path from
  validated parts and allowlists `action`. My Day scrolls to the stop and
  focuses that stop's own Start or Complete button
  (`src/components/my-day/use-live-activity-action.ts`). It never presses it:
  a lock screen is touched by accident, Start stamps the visit's time, and
  Complete can need a photo, a checklist or a cash entry.

The content state gained seven optional fields (`visitId`, `destLat`,
`destLng`, `destAddress`, `nextAction`, `navigateLabel`, `actionLabel`). A
state without them, from build 261 or saved in `last_state`, still decodes and
draws no buttons.

```bash
# the demo, with the Complete button instead of Start
xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo -liveActivityDemoAction complete
```

### The pieces

| | where |
|---|---|
| Widget extension (ActivityKit, iOS 16.2+) | `ios/App/RouteActivity/` — target `RouteActivity`, bundle id `consulting.thenorth.houndstack.RouteActivity`, embedded in the app, automatic signing, the app's team |
| The shape both halves share | `ios/App/App/LiveActivity/RouteActivityAttributes.swift`, a member of BOTH targets |
| The Capacitor plugin | `ios/App/App/LiveActivity/RouteActivityPlugin.swift`, a local plugin (no npm package), registered in `ios/App/App/HSBridgeViewController.swift`, which Main.storyboard names instead of `CAPBridgeViewController` |
| JS wrappers | `src/lib/live-activity.ts`, no-ops off iOS |
| The content | `src/lib/live-activity-state.ts`, built in the tech's language, used by the phone and the server |
| My Day | `src/components/my-day/RouteLockScreen.tsx` (`useRouteLiveActivity`): starts on Clock in or the first Start (unless the phone's "Route on the lock screen" preference is off), follows every Complete and Skip (queued ones too), ends when nothing is left, on Clock out, or when hidden. Its control is `RouteLockScreenToggle` in the same file, an icon in My Day's status row, and the preference is also a switch on Preferences (`src/components/settings/RouteOnLockScreenCard.tsx`, `src/lib/live-activity-pref.ts`) |
| Office changes | `src/lib/push-liveactivity.server.ts`, called from the dispatch server functions in `src/lib/visits.functions.ts`; tokens in `live_activity_tokens` |

The app's deployment target stays iOS 15.0. ActivityKit is weak-linked and
every use is behind `#available(iOS 16.2, *)`, so iOS 15 runs the app and
simply has no card.

`App.xcodeproj` is Capacitor's file, and `npx cap add ios` would regenerate
it without the extension target. Nobody runs `cap add` on an existing
project; `cap sync` does not touch targets. If the project is ever
regenerated, the target has to be added back.

### On a simulator, with nobody signed in

Debug builds only (the code is `#if DEBUG` and absent from every archive):

```bash
xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo
xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityDemo -liveActivityDemoLang ar
# the JS bridge: isSupported, start, update called from the page, result in the log
xcrun simctl launch booted consulting.thenorth.houndstack -liveActivityBridgeCheck
```

`xcrun simctl push` cannot deliver a Live Activity update: it accepts only
payloads that become a notification request, and refuses one with no alert.

### Owner checklist

1. **Register the extension's App ID by hand. Done 2026-10-07.** The
   expectation that Xcode Cloud would create
   `consulting.thenorth.houndstack.RouteActivity` itself was wrong. Every build
   from #337 (Xcode Cloud 249) to 259 ARCHIVED fine and then failed all four
   export steps (ad hoc, App Store, development) with `xcodebuild
   -exportArchive ... exit-code: 70`, so nothing reached TestFlight for three
   days and the phone kept running 1.0 (247) from 2026-10-04. Registering the
   ID (developer.apple.com › Identifiers › + › App IDs › App › Explicit
   `consulting.thenorth.houndstack.RouteActivity`, no capabilities) and
   rebuilding is the fix. **Any future extension target needs the same step
   before its first merge**, because the extension was added to the project
   file directly rather than through Xcode's target wizard, which is what
   would have registered it. If an export fails with exit 70 again, the reason
   is in the build's Artifacts › the export logs › `IDEDistribution.standard.log`.
2. **No new APNs key and no new secret.** A Live Activity push uses the same
   `.p8` key and the same five `APNS_*` values; only the topic differs
   (`consulting.thenorth.houndstack.push-type.liveactivity`), and the server
   derives it.
3. **Apply the migration** `20261004120000_the-route-on-the-lock-screen.sql`
   to production after merge, as with every migration.
4. **On the phone (TestFlight build):** sign in as a tech with visits today,
   open My Day, tap Clock in. The route should appear on the lock screen. The
   first time, iOS asks "Allow Live Activities from HoundStack?" on the lock
   screen itself; tap Allow. Complete a stop: the lock screen moves on. Then,
   from the office on another device, reassign that tech's next stop to
   someone else: within a few seconds the lock screen should name the stop
   after it. If it does not, look at that tech's row in
   `live_activity_tokens`: no row means the token never reached the server;
   `last_error` or `end_reason` holds Apple's answer otherwise.

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

### Capacitor 8 and a plugin that is still on 7

`@capacitor-community/apple-sign-in` 7.1.0 is the newest release and there is
no Capacitor 8 one. Its `Package.swift` asks for capacitor-swift-pm
`from: "7.0.0"` (7.0.0..<8.0.0), `ios/App/CapApp-SPM/Package.swift` pins
`exact: "8.4.3"`, and Swift Package Manager gives up before anything compiles:

```
Failed to resolve dependencies Dependencies could not be resolved because
'apple-sign-in' depends on 'capacitor-swift-pm' 7.0.0..<8.0.0 and
'status-bar' depends on 'capacitor-swift-pm' 8.0.0..<9.0.0.
```

`package.json`'s `postinstall` runs `scripts/patch-native-plugins.mjs`, which
rewrites that one range to `from: "8.0.0"` in `node_modules`. The plugin's
Swift needed nothing else — every Capacitor API it calls is still declared,
un-deprecated, in 8.4.3. `npm ci` in `ci_post_clone.sh` runs it, so Xcode Cloud
gets it with no setting; never install with lifecycle scripts switched off.
Android is unaffected: the plugin's Android half is a Java stub that only
builds against `:capacitor-android`, and Apple sign-in is iOS-only in
`src/lib/native-oauth.ts`.

The script is idempotent and **fails the install** if the line it expects is
gone and the file does not already accept 8.x — so a plugin upgrade cannot undo
it silently. It fails only where an iOS build depends on it (a Mac, Xcode Cloud,
GitHub Actions); on any other install, which includes Lovable's web build, it
prints the same error and carries on, because the web bundle never reads the
file. If that happens: check the new `Package.swift` resolves against
CapApp-SPM, then update or delete the entry in the script. When a Capacitor 8
release of the plugin ships, the script reports "already accepts Capacitor 8"
and the entry can go. `tests/a-plugin-still-on-capacitor-7-stopped-every-ios-build.test.ts`
pins all of this against the original 7.1.0 file.

### Bumping Capacitor is three steps, not one

Xcode does not build the Capacitor runtime from `node_modules`. It downloads
`Capacitor.xcframework` from capacitor-swift-pm at the version CapApp-SPM pins.
So a Capacitor bump is:

1. `@capacitor/core`, `cli`, `android` and `ios` to the same release, in
   `package.json`, `package-lock.json` and `bun.lock`.
2. `npx cap sync ios`, which rewrites the `exact:` pin in
   `ios/App/CapApp-SPM/Package.swift`. It needs the web build, not Xcode.
3. The capacitor-swift-pm pin in
   `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`:
   the new version and the commit its tag points at
   (`git ls-remote https://github.com/ionic-team/capacitor-swift-pm.git refs/tags/<version>`).
   Xcode Cloud resolves with automatic resolution off, so a stale pin stops
   the archive with "an out-of-date resolved file was detected" (#723).

Bump only the npm side and the iPhone build keeps the old Swift. Android needs
no pin: `:capacitor-android` is built from `node_modules`.
`tests/the-native-shell-is-on-a-patched-capacitor.test.ts` fails if the three
disagree, or if any of them is in the range GHSA-rvm3-566m-v7fv covers
(#816: `>=8.3.5 <8.4.3`, and `8.5.0`). The `~8.4.3` range is on purpose: `^8.4.3`
would let a fresh resolve land on 8.5.0.

### The workflow's Test action has nothing to test, and never will

```
xcodebuild: error: Failed to build workspace App with scheme App.:
There are no test bundles available to test.
```

This is not a signing failure, not a package failure, and nothing in the repo
can fix it. The Xcode Cloud WORKFLOW has a **Test** action in it. The `App`
scheme has no test targets, so `xcodebuild test` finds no bundle and the whole
build is marked failed even when the archive step is fine.

It arrived by default rather than by choice: the app record was created through
Xcode Cloud's own onboarding, and the workflow it generates has Test in it out
of the box.

**Fix: delete the Test action from the workflow** — App Store Connect > the app
> Xcode Cloud > Manage Workflows > edit > select the Test action > delete, or
the same thing from Xcode's Report navigator. Leave Archive and any
distribution action alone.

**Do not "fix" it by adding a test target to `App.xcodeproj`.** Two independent
reasons, either one sufficient:

* That project belongs to Capacitor. `npx cap add ios` regenerates it, so a
  target added there is a target that disappears without warning. This is the
  same reason `ios/UITests/` is a standalone project in the first place.
* The tests could not run in the cloud even if they were wired in. Every one of
  them needs a signed-in session, and sign-in is deliberately not automated —
  automating it would put a real password in the repo. See
  `ios/UITests/README.md`. An unattended runner has no session and every test
  fails on the first navigation.

The device tests run against a simulator you are sitting in front of. Xcode
Cloud's job here is to archive and distribute, and that is the whole of it.

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

## Scenes, and the launch check (#570)

Built with Xcode 27.1, the app crashed on every launch on iOS 27.1 with
SIGTRAP in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`.
Info.plist named `UIMainStoryboardFile` and had no scene manifest, which is
the shape Capacitor's template still generates. The app now adopts the scene
lifecycle:

- `Info.plist` declares `UIApplicationSceneManifest` (one scene, delegate
  `$(PRODUCT_MODULE_NAME).SceneDelegate`) and no longer names a main
  storyboard. `AppDelegate` also names `SceneDelegate` in
  `configurationForConnecting`, so the class is found through Swift.
- `SceneDelegate.swift` builds the window from `Main.storyboard`, loads the
  bridge, and only then forwards a launch URL, so the App plugin is already
  listening. Warm links come through `scene(_:openURLContexts:)`, Universal
  Links through `scene(_:continue:)`, and the Debug-only Live Activity demo
  starts from `sceneDidBecomeActive`. UIKit no longer calls the app delegate
  for any of those.
- Unchanged: the APNs token still arrives at `AppDelegate`, and a push tap is
  still delivered to the `UNUserNotificationCenter` delegate that Capacitor's
  bridge installs.

**If `npx cap add ios` ever regenerates `ios/App`,** it writes the template
back without a scene. `tests/ios-27-would-not-launch-an-app-without-a-scene.test.ts`
fails on that.

`.github/workflows/ios-launch.yml` runs `scripts/ios-launch-smoke.sh` on a
macOS runner: the newest installed Xcode, a fresh iPhone and iPad on the
newest iOS runtime, a fresh iPhone and iPad on the newest iOS 26.x runtime
(#620), and `ios/UITests/HoundStackUITests/ColdLaunch.swift` on
each (five cold launches to the sign-in form, a link from cold, a link while
running). It needs no session, which is why it can run unattended. When the
newest runtime is older than iOS 27 the summary says the run did not exercise
iOS 27, and when no iOS 26.x runtime offers both an iPhone and an iPad the run
fails. It cannot prove a physical device, a foldable's folded and unfolded
postures, or that a push tap routes (that needs a signed-in session). To run
it on a Mac:

```bash
npm run build:native && npx cap sync ios && scripts/ios-launch-smoke.sh
```

## The privacy manifest

When a native dependency is added or upgraded, rescan it for required-reason APIs and update `ios/App/App/PrivacyInfo.xcprivacy`.

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
