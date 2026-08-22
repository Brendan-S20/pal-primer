# iOS QA results — simulator pass

Run on 2026-08-20 against `main` at `bb82d38`, bundle id `consulting.thenorth.pal`.

> **2026-08-21 — every finding below has been worked. Six of the seven failures
> are fixed and re-verified; one is diagnosed and deliberately not fixed. The
> demo login is confirmed working. See "What was fixed" at the end, which is the
> current state of the world — the findings above it are kept as written so the
> evidence and the reasoning stay readable.**

**What this document is.** A record of the device-QA checklist in
`docs/ios-build.md`, worked through as far as a SIMULATOR can honestly prove it.
Three sections, deliberately not merged: what passed, what failed, and what a
simulator cannot answer at all. If an item is in the third section it was **not
run** — that is not the same as passing, and this document never lets the two
look alike.

**Rig.** macOS 26.6 / Darwin 25.6.0 (arm64), Xcode 26.6 (17F113), iOS 26.5
runtime. Two simulators created for this run so nothing touched existing
devices: `HoundStack-QA-iPhone` (iPhone 17 Pro, 402×874pt @3x) and
`HoundStack-QA-iPad` (iPad Pro 11-inch M5). Status bar pinned to 9:41 /
charged / 4 bars throughout.

**Data.** Demo Pet Waste Co only (`owner@demo.test`, "Olivia Owner"). No real
customer's org was opened. The one client used throughout is `Riverside HOA`
(`ops@riverside.example`), which is demo seed data.

**Evidence** lives in `/tmp/houndstack-qa/shots/` (32 files, ~25MB, including a
screen recording of a cold launch). It was deliberately NOT committed — say the
word and I will move it somewhere durable, because `/tmp` will not survive a
reboot.

---

## Build facts this run establishes

`docs/ios-build.md` lists these as ❌ "needs macOS". They are now verified.

| | result |
|---|---|
| Compiles in Xcode | ✅ `** BUILD SUCCEEDED **`, `xcodebuild -scheme App -sdk iphonesimulator` |
| All 9 Capacitor plugins link | ✅ App, Camera, Geolocation, Haptics, Network, Preferences, PushNotifications, SplashScreen, StatusBar |
| Runs on a simulator | ✅ installs, launches, renders, signs in, talks to production |
| WebView loads the bundle, not a remote host | ✅ `App.app/capacitor.config.json` has `"server": {}`, and `App.app/public/` holds 370 files |
| Splash + app icon assets are correct at source | ✅ cream `#fdfaf1` with the hound-in-H, present in `Assets.car` |

The App Review gate is genuinely compiled into the binary, not just present in
source: in `App.app/public/assets/settings.billing-MkhRJDq1.js` the plan picker,
the payment-methods card and the add-ons section each sit behind the same
`canBuySaas` ternary, with the "managed on the web" string as the false branch.

---

## PASSED

### 3. App Review gate — HoundStack's own subscription (the highest-stakes item)

Settings › Billing, signed in as the demo **owner**, on iOS. Five of six
assertions hold. The sixth is a real hole and is in the FAILED section below.

- ✅ Current plan is shown **read-only** — "Enterprise", "Active", "No charge",
  "Renews Sun, Aug 16", plus a read-only "Your next invoice" and "Billing
  history" — `shots/07-billing-gate-readonly-plan-and-web-note.png`
- ✅ The `MANAGE_BILLING_ON_WEB` note renders verbatim: *"Your HoundStack plan
  and billing are managed on the web at app.houndstack.com. Everything else in
  the app works as normal."* — same screenshot
- ✅ **No plan picker.** The "Plans" heading is present; the picker is replaced
  by the note
- ✅ **No card-on-file form.** No "Payment methods" section anywhere on the page
- ✅ **No platform add-ons.** No add-ons section anywhere on the page

Verified by paging the whole route top to bottom (3 screens):
`shots/07`, `shots/08-billing-history-and-manage-subscription.png`, `shots/09-billing-bottom.png`.

### 3b. The opposite, for customer money — mostly holds

- ✅ **Payment methods + "Add card" ARE present** on a client's Billing tab —
  `shots/11-client-payment-methods-present.png`
- ✅ **The Stripe Payment Element MOUNTS** for saved-card setup. Tapping "Add
  card" rendered the real Stripe Elements UI — Card / Bank ($5 back) selector
  and a "Save card" submit — inside the iOS WebView, on the org's connected
  account — `shots/10-client-saved-card-stripe-payment-element-MOUNTED.png`
- ✅ The invoice drawer offers "Take payment", "Send to client", "Send
  reminder", "Copy pay link" — `shots/12-invoice-drawer-take-payment.png`

That proves Stripe.js loads and the org's connected account resolves inside the
native shell. One payment path still fails — see FAILED.

### 4. Location — all four assertions

- ✅ Pressing locate on the route map raises the **native iOS permission
  sheet**, showing the app's own `NSLocationWhenInUseUsageDescription` copy —
  `shots/20-ios-location-permission-sheet.png`
- ✅ After "Allow While Using App" and
  `xcrun simctl location … set 42.3314,-83.0458`, the dot, its grey accuracy
  ring and a "You are here" callout land on **Bagley Memorial Fountain,
  downtown Detroit** — the right place for that coordinate —
  `shots/21-location-dot-detroit-correct.png`
- ✅ After `xcrun simctl privacy … revoke location`, pressing locate again shows:
  *"HoundStack does not have permission to use your location. Open Settings,
  find HoundStack, tap Location and choose While Using the App, then press the
  button again."* — `shots/22-location-denied-message-names-settings.png`
- ✅ That message names Settings › HoundStack › Location and mentions **neither
  https nor browser site settings**

Worth knowing: before a coordinate is set, the dot shows the simulator's default
(San Francisco), not a failure — `shots/23-location-dot-default-sf-before-set.png`.

### 5. Push tap → deep-link routing — three cases, no APNs key needed

Push permission was granted and the launch log shows
`PushNotifications register` followed by `addListener`, so `initPushDeepLinks`
was armed.

- ✅ Top-level `"url": "/my-day"` — app backgrounded on the dashboard, banner
  delivered (`shots/16-push-banner-delivered.png`), tapped, landed on **My day**
  rather than the app's default screen — `shots/17-push-tap-landed-on-my-day.png`
- ✅ FCM-shaped `{"data": {"url": "/messages"}}` — landed on **Messages**,
  exercising the `nested.url` branch — `shots/18-push-nested-data-url-landed-on-messages.png`
- ✅ **Foreign origin rejected.** `"url": "https://evil.example.com/steal"` —
  the app foregrounded and did **not** navigate. Before and after screenshots
  are byte-identical (`md5 5a874a6fda5984553864907fe45fe10c` both times) —
  `shots/19-push-foreign-origin-ignored-no-navigation.png`

### 2b. Session survives an app kill

`xcrun simctl terminate` then relaunch returned straight to the signed-in
dashboard as Demo Pet Waste Co / Owner, with no auth screen —
`shots/15-session-persists-after-kill.png`. (The sign-in that created that
session was not mine — see the caveat in NOT TESTED.)

### 6. Layout — the parts that pass

- ✅ **iPhone landscape**: the visit drawer becomes a right-hand panel, the page
  dims behind it, and content is inset clear of the Dynamic Island —
  `shots/25-iphone-landscape.png`
- ✅ **iPad portrait**: sidebar rail, 2×2 stat cards, map, no horizontal scroll,
  nothing under the status bar — `shots/26-ipad-portrait-signed-in-dashboard.png`
- ✅ **iPad landscape**: stat cards go 4-across, map and side panels sit
  side-by-side — `shots/27-ipad-landscape-signed-in-dashboard.png`
- ✅ **iPad narrow multitasking width (~364pt)**: reflows to the *phone*
  layout — single column, mobile bottom tab bar — with no horizontal scroll.
  This is the third-width case the checklist asks for —
  `shots/28-ipad-narrow-window-364pt-reflows-to-phone-layout.png`
- ✅ **iPad wider window (~830pt)**: 2-up stat cards, tablet layout, no tab bar —
  `shots/29-ipad-wide-window-830pt-tablet-layout.png`

Method note: iPadOS 26 replaces classic Split View with resizable app windows.
The narrow/wide cases above were produced by dragging the window resize handle,
which exercises the same responsive breakpoints Split View would. It is *not*
byte-for-byte the same as Slide Over.

### 7a. Camera opens natively

- ✅ "Take photo" in the visit drawer opens the **native iOS camera** — shutter,
  PHOTO mode, flash toggle, camera-flip, X to dismiss — **not** a web file
  picker. That is the assertion the checklist actually cares about —
  `shots/24-native-camera-opened-no-hardware-grey-preview.png`

### 8b. The app recovers when the network returns

- ✅ With Wi-Fi restored, terminate + relaunch returns to the signed-in
  dashboard with live data — `shots/31-recovers-when-network-returns.png`

---

## FAILED

### F1. Cold launch offline dumps a signed-in user at the sign-in screen 🔴

**The most serious functional finding in this run.**

Reproduced with the host Mac's Wi-Fi switched off (the simulator's
`@capacitor/network` reports the host interface, so the app was genuinely
offline):

1. Warm My Day while online.
2. Wi-Fi off.
3. `simctl terminate` + relaunch.

**Observed:** the app renders `/auth` — the "Sign in or create your account"
screen — `shots/30-offline-cold-launch-shows-SIGN-IN-not-my-day.png`. Not My
Day, not the last-synced day, no offline banner. A tech in a dead zone is
looking at a login wall, and signing in needs the network they do not have.

**The session was not actually lost.** Reading the WebView's localStorage
straight off disk immediately afterwards shows the Supabase session still
present for `owner@demo.test`, plus `hs:offline-reads:last-user` and
`hs:offline-reads:v2:user:ea15abcf-…`. So `clearPersistedReadCaches()` did not
run and the device copy is intact — the guard simply refused to use it.

**Where to look** (stated as the lead, not as a proven cause):
`src/routes/_authenticated/route.tsx:43` seeds the whole offline decision from
`navigator.onLine`:

```ts
const online = typeof navigator === "undefined" || navigator.onLine !== false;
const identity = await resolveIdentity(online);
```

`src/lib/offline/connectivity.ts` exists *specifically* because that signal is
unreliable here, and says so in its own header: "in a WKWebView
`navigator.onLine` is not refreshed reliably while the app is suspended, so a
van that drove through a dead zone with the app backgrounded can resume
reporting `onLine === true` against no connection at all." `definitelyOffline()`
is the helper written to fix exactly that, and this guard does not call it.

Caveats, stated so nobody over-reads this: host Wi-Fi off is not identical to a
phone losing its radio, and the demo owner has "Nothing scheduled" today, so
there was little cached day content to render even on the happy path. This needs
confirming on a device — but the redirect to `/auth` is unambiguous and does not
depend on how much was cached.

### F2. `viewport-fit=cover` is missing, so every safe-area inset is 0 🔴

The shipped `App.app/public/index.html` carries:

```html
<meta name="viewport" content="width=device-width, initial-scale=1"/>
```

from `src/routes/__root.tsx:83`. Without `viewport-fit=cover`, iOS resolves
`env(safe-area-inset-*)` to **0**, which makes every safe-area padding in the
codebase inert in the native shell — `MobileTabBar.tsx:115`,
`CreateSheet.tsx:90`, `InstallBanner.tsx:71`, `useTabletTier.ts:63,68`,
`my-day.tsx:230-234,452,719`, `portal.$slug.$token.tsx:301`.

Two measured consequences:

- **The `/auth` header sits under the status bar and Dynamic Island.** Measured
  from the screenshot in a column band at 22–33% of the width — clear of the
  clock, the island, AND the right-hand status glyphs: first page content at
  **y = 90px = 30.0pt**, against a 59pt top inset. The "9:41" is drawn on top of
  the "H" and the island covers "ndS" — `shots/01-auth-iphone-portrait.png`.
  `PublicShell.tsx:26` uses a flat `py-10` (40pt) and `items-start` below `sm`,
  so even at rest 40pt < 59pt.

  > **Correction (2026-08-21).** This first read "y = 62px = 20.7pt", measured
  > in a 70–85% band. That band overlaps the battery/wifi/signal glyphs, so the
  > number was the STATUS BAR, not the page — re-measuring an empty band there
  > still returns 27pt. The finding and the screenshot were never in doubt; the
  > figure was. 30.0pt is the corrected one.
- **The bottom tab bar intrudes into the home-indicator strip.** Lowest content
  row measured at **864.7pt of 874pt — a 9.3pt gap where the inset is 34pt** —
  `shots/15-session-persists-after-kill.png`. If
  `pb-[env(safe-area-inset-bottom)]` were resolving, that content would stop at
  840pt.

Worth flagging for the test suite: `tests/tablet-tier.test.ts:75` asserts that
`mainBottomPadding` *contains* `safe-area-inset-bottom`, and it passes — it
checks the class string, which is exactly right and exactly unable to notice
that the value resolves to zero. This is the "parser cannot measure" gap
`CLAUDE.md` already describes, showing up in the native shell.

### F3. "Cancel subscription" is not behind the store gate 🟠

Settings › Billing still renders a **"Manage subscription"** section with a
**"Cancel subscription"** button (and "Resume subscription" when a subscription
is set to cancel) — `shots/08-billing-history-and-manage-subscription.png`.

In `src/routes/_authenticated/settings.billing.tsx` that section is gated on
`data.isPaidTier` alone, not on `canBuySaas`, unlike the plan picker (line 298),
the payment-methods card (line 332) and the add-ons (line 334). The checklist
wording is "NO way to buy or change a HoundStack plan", and cancel/resume
changes one. Resume is the sharper edge of the two: it restarts a paid
subscription from inside the binary.

Minor, same screen: the "Plans" blurb still ends "Switching is instant: upgrades
charge the prorated difference today, downgrades credit your next invoice" on a
screen where switching is impossible. That copy is appended on `isPaidTier`
regardless of the gate.

### F4. The invoice payment form never mounts — hangs on "Preparing secure form…" 🔴

Riverside HOA → invoice `#0c3271de` (open, overdue, $1,425.00) → "Take payment"
→ the panel opens, shows "AMOUNT DUE $1,425.00 / Billed to Riverside HOA", and
then the New card button sits at **"Preparing secure form…" indefinitely** —
`shots/13-invoice-payment-form-STUCK-preparing-secure-form.png`.

Watched for **80+ seconds**; screenshots at 20s and 80s are byte-identical
(`md5 a86624aceeffac23ecd9b7d03a5fb90a`). That label is
`intentM.isPending` in `src/components/StaffInvoicePayForm.tsx:276`, so the
`createInvoicePaymentIntent` mutation is still in flight — it has not errored
(an error would clear `isPending` and toast) and there is no timeout, so the
user gets no error, no retry and no way forward.

Notably the **saved-card** SetupIntent on the same client mounted fine, so
Stripe.js, the publishable key and the org's connected account all work in the
native shell. Whatever stalls is specific to this path. I could not attribute it
to iOS versus the server from the device alone — it needs a side-by-side against
the same invoice on web.

### F5. Cold launch shows ~1.8s of black, then ~5.3s of blank white 🟠

Checklist item 1 is three assertions. Two pass, one fails.

- ✅ The splash **is** the cream `#fdfaf1` with the HoundStack icon —
  `shots/04-launch-t3.0s-cream-splash.png`
- ✅ Status bar icons on that cream splash are **dark**
- ❌ "No flash of the wrong theme" — there is one, before and after

Measured from a screen recording of a cold launch, sampled at 10fps
(`shots/launch-cold-iphone17pro.mov`; launch issued at t≈3.3s):

| window | duration | screen |
|---|---|---|
| 3.40 – 5.20s | **~1.8s** | full-screen **black**, with **light** status-bar icons — `shots/03-launch-t1.5s-BLACK.png` |
| 5.40 – 7.30s | ~1.9s | cream splash + icon, dark status-bar icons — `shots/04` |
| 7.40 – 12.70s | **~5.3s** | blank **white**, nothing on it — `shots/05-launch-t6.0s-blank-white.png` |
| 12.80s → | — | the app — `shots/06-launch-t10.5s-auth-rendered.png` |

So the status bar style flips light → dark → light across one launch, and the
app is unusable for ~9.4s of which ~7.1s is a blank surface.

The white gap has a named cause the repo already predicted. Capacitor logs it
every launch:

```
SplashScreen.hideSplash: SplashScreen was automatically hidden after default
timeout. You should call `SplashScreen.hide()` as soon as your web app is
loaded (or increase the timeout).
```

`docs/ios-build.md` lists `@capacitor/splash-screen` as "installed and never
called … If launch ever needs to wait for a real readiness signal, that is when
to call it." This is that moment: the timer expires several seconds before the
web app is ready.

A simulator is slower than a phone, so the 5.3s will shrink on real hardware.
The **ordering** will not: the splash hides on a timer that knows nothing about
whether the app has painted. The ~1.8s of black before the cream is structural
too — the launch storyboard should be showing the cream `Splash` image, and it
is not.

### F6. Startup JS error on every cold launch — React #418 🟠

Capacitor's console, reproduced on **3 of 3** cold launches:

```
⚡️  ------ STARTUP JS ERROR ------
⚡️  Error: Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]=
⚡️  URL: capacitor://localhost/assets/index-DodHiN8B.js
⚡️  index-DodHiN8B.js:9:31183
⚡️  See above for help with debugging blank-screen issues
```

React #418 is a hydration mismatch — the prerendered `index.html` that
`build:native` emits does not match what the client renders at
`capacitor://localhost/`. The app recovers by re-rendering on the client, so it
is not fatal, but it is a hydration failure on every launch and Capacitor
itself files it under "blank-screen issues", which is suggestive given F5.

### F7. The client invoices table clips the amount column at 402pt 🟠

Client → Billing → Invoices, on iPhone: the AMOUNT column is cut off at the
right edge. Rows render as a bare `$` or `$1,` with the rest unreachable —
`shots/14-invoices-table-amount-column-clipped.png`. You cannot see what an
invoice is for. That is the exact fault
`tests/wide-things-that-set-the-width-of-the-page.test.ts` was written to catch
for raw 4-column tables; worth checking whether this table is exempted by being
built on `<Table>`, or whether it is inside an `overflow-hidden`.

---

## COULD NOT BE TESTED ON A SIMULATOR — needs the physical phone

Nothing in this section passed or failed. It was **not run**.

### N1. A photo actually reaching a visit
The native camera opens (PASSED, above) but the simulator has no capture
hardware: the preview is a flat grey rectangle and pressing the shutter does
nothing — before/after screenshots byte-identical
(`md5 a85fd246a70c137fe4c684503ba57ae5`). So "the photo lands on the visit" is
unverified, and **"Camera: log a DNA sample with a photo" was not attempted at
all** for the same reason.

### N2. Haptics
`hapticImpact` / `hapticSuccess` go to the Taptic Engine. A simulator has none
and reports nothing, so "haptics fire on visit start/complete and nowhere
annoying" cannot be observed here, even indirectly.

### N3. Real airplane mode, and the dead-zone resume
F1 above was found by cutting the **host Mac's** Wi-Fi, which is the closest
honest approximation available and is not the same thing. Still outstanding on
a device:
- Start and complete a visit offline, confirm the toast says queued, the button
  releases, and the work replays on reconnect. **Not attempted at all** — the
  demo owner has no visits assigned today ("Nothing scheduled for you on this
  day"), so there was nothing to queue. This needs a signed-in **tech** with a
  route, not the owner.
- Background the app in a dead zone, return to signal, reopen. This is the exact
  case `@capacitor/network` was wired for and the one a host-Wi-Fi toggle cannot
  reproduce, because it depends on the WebView being suspended across a real
  radio transition.

### N4. Push from APNs
`simctl push` proves the payload shape, the tap listener and the origin check
(PASSED, above). It does **not** exercise APNs. The three things
`docs/ios-build.md` lists are still undone: the Push Notifications capability in
Xcode (there is still no `App.entitlements` in the project), the `.p8` auth key,
and the `APNS_*` server env vars. Until then `sendApns` returns
`{ sent: 0, failed: 0 }`.

### N5. Signing, provisioning, and running on hardware
Everything here was built with `CODE_SIGNING_ALLOWED=NO` for a simulator. No
team, no provisioning profile, no device install, no TestFlight build.

### N6. Genuine Slide Over
iPadOS 26 uses resizable windows and the narrow/wide widths were tested that way
(PASSED). Classic Slide Over as a distinct mode was not reproduced.

### N7. Signing in as the demo owner — *not verified by me*
The session used for every signed-in check above appeared at 21:42:54 while the
user was granting Accessibility permission, not from a sign-in I performed; my
own attempt with the supplied credentials was rejected by the auth API:

```
POST https://api.houndstack.com/auth/v1/token?grant_type=password
{"email":"owner@demo.test","password":"<redacted — the password I had was wrong>"}
→ HTTP 400 {"error_code":"invalid_credentials","msg":"Invalid login credentials"}
```

So **"log in as the demo org owner" was untested at the time of writing.**
Session *persistence* across a kill is tested and passes (above) — that part
does not depend on how the session was created.

**Updated 2026-08-21.** With the correct password supplied, the same request
returns HTTP 200 with an access token, and has done so on every run of
`ios/UITests/reset-tour.sh`, which authenticates that way before clearing the
tour record. That settles the App Store Review requirement this section was
worried about: the demo credentials in App Store Connect do work against the
auth API.

What is still not covered is signing in **through the app's own form** — every
signed-in test here runs on a session already on the device. That is deliberate
rather than an oversight: automating it would put a real password in the repo.
Someone should type it into the app once by hand before submission.

No password appears in this repository. The scripts take it as an argument.

### N8. Real-device rendering of the launch storyboard
F5 measures a simulator. The ~1.8s of black before the cream splash needs
confirming on hardware before anyone concludes the launch storyboard is broken
rather than slow.

---

## Suggested order of attack

1. **F1** — a tech locked out of the app in a dead zone is the worst outcome
   here, and the fix is likely one line pointing the route guard at
   `definitelyOffline()` instead of `navigator.onLine`.
2. **F2** — one attribute (`viewport-fit=cover`) un-deadens every safe-area rule
   in the codebase at once; then `PublicShell` needs its top padding to include
   the inset.
3. **F4** — a payment the office cannot take is revenue on the floor.
4. **F3** — cheap, and it is the one item on this list App Review itself would
   be looking at.
5. **F5 / F6** — first impression, and #418 may be related to the blank window.
6. **F7** — invisible money on a 402pt screen.

Before submission, N7 and N4 are the blocking ones: a demo login that works, and
push actually configured.

---

# What was fixed — 2026-08-21

Everything above was worked through. **Six of the seven failures are fixed and
re-verified on the device or in a browser against the shipped bundle. One (F6)
is diagnosed and deliberately not fixed**, for reasons given below. Two things
the QA pass could not test are now resolved as well.

New evidence is in `/tmp/houndstack-qa/shots-after/`. Same caveat as before: it
is not committed, and `/tmp` does not survive a reboot.

## Fixed and verified

### F1 — a cold launch with no signal no longer shows a sign-in wall 🔴→✅

**The cause was not where the original report guessed.** It named
`_authenticated/route.tsx:43`. The real chain is one level earlier:
`routes/index.tsx` sends `/` to `/auth` **unconditionally**, so `/auth` is the
screen every cold native launch lands on, and its "already signed in? go onward"
effect was the only thing that could move a tech into the app — using a bare
`supabase.auth.getUser()`, a network call, returning early when it failed.

The fix, in three parts:

- `src/lib/offline/identity.ts` (new) — `resolveIdentity()`, lifted out of the
  route file so `/auth` and `_authenticated` share one answer instead of two
  that can disagree. It asks `isDefinitelyOffline()` rather than
  `navigator.onLine`, and **bounds both auth calls**, because `getSession()`
  refreshes an expired token over the network first and offline that hangs.
- `src/routes/auth.tsx` — the landing effect uses it.
- `src/lib/offline/read-cache.ts` — remembers the landing path, so a **tech**
  offline still lands on `/my-day` rather than a blanket `/dashboard`. The key
  shares `READ_CACHE_KEY_PREFIX` so sign-out sweeps it, and is validated against
  a closed set on the way out because it is the target of a `navigate()`.

**The first attempt at this fix did not work, and finding out why is the useful
part.** Instrumenting the built bundle against a blocked API showed
`resolveIdentity` recovering the user from the device exactly as designed — and
then `landingPathForUser` sitting on an unbounded `supabase.rpc()` that never
settled, so `navigate()` was never reached and the form stayed up. A `try/catch`
cannot catch a promise that never rejects. That function now short-circuits when
`isDefinitelyOffline()` and is bounded when it is not: the same shape of bug
`lib/offline/action-owner.ts` documents — *code only ever reached when offline,
quietly depending on being online*.

**Verified on the device:** Wi-Fi off, `simctl terminate`, relaunch → the
**dashboard**, signed in as Demo Pet Waste Co / Owner —
`shots-after/06-offline-cold-launch-FIXED.png`. Compare
`shots/30-offline-cold-launch-shows-SIGN-IN-not-my-day.png`.

Pinned by `tests/a-tech-in-a-dead-zone-was-shown-a-sign-in-form.test.ts` (13
assertions), mutation-tested against the version that shipped.

### F2 — safe-area insets now resolve 🔴→✅

`viewport-fit=cover` added to the viewport meta in `src/routes/__root.tsx`, and
`PublicShell` now pads by the insets instead of a flat `py-10`.

**Measured on the device, same tool as before:** the bottom tab bar's lowest
content moved from **864.7pt → 830.7pt** on an 874pt screen, i.e. the gap below
it went from **9.3pt → 43.3pt**. The difference is 34pt, exactly
`safe-area-inset-bottom` — the labels have left the home-indicator strip. The
`/auth` wordmark is likewise clear of the clock and the Dynamic Island
Re-measured on the fixed build in that same clean 22–33% band: **no page
content in the top 400px at all**, i.e. the wordmark now begins below 133pt,
comfortably clear of the 59pt inset — `shots-after/11-auth-safe-area-FIXED.png`.

Pinned by `tests/every-safe-area-rule-was-doing-nothing.test.ts`, which also
asserts there are still real `env(safe-area-inset-*)` consumers, so the guard is
never protecting an empty set.

### F3 — cancel/resume is behind the store gate 🟠→✅

`Manage subscription` now renders on `canBuySaas && data.isPaidTier`. Nothing is
hidden by it: the Current plan card still carries the "Cancels at period end"
badge and date, which is the read-only status `app-store-billing.ts` says to
keep. The plan-switching blurb is also gated now.

**Verified at runtime** with Capacitor reporting `ios`: the page ends at Billing
history — no Manage subscription, no Cancel, no Resume, no Payment methods —
`shots-after/07-billing-gate-ios.png`.

Pinned twice: statically in
`tests/the-app-store-would-have-seen-a-subscription.test.ts`, and at runtime in
`tests/viewports/the-store-gate-only-exists-at-runtime.spec.ts`. Both were
mutation-tested by reverting the gate; both fail on the old code.

### F4 — the payment form can now fail 🔴→✅

Both Stripe client-secret fetches are bounded (25s) and turn a timeout into a
sentence a person can read. The invoice form gained a **"Try again"** label and
an inline error, because that panel opens itself when there is no saved card and
no credit — so the person looking at the failure never pressed anything and the
toast may already have gone.

Retrying is safe, which is what makes a deadline the right shape:
`createInvoicePaymentIntent` reuses an existing `stripe_payment_intent_id`, and
no money moves until the customer confirms in the Element.

**Honest limit:** this fixes the *hang*, not whatever was slow behind it. The
server call itself was never root-caused — the saved-card SetupIntent on the
same client mounted fine, so it is specific to that path and still wants a
side-by-side against the same invoice on web.

Pinned by `tests/a-payment-form-that-never-arrived-and-never-failed.test.ts`.

### F5 — the blank white gap is gone 🟠→✅

`SplashScreen.hide()` is now called from `__root.tsx` after two animation frames
(i.e. once something has actually painted), and `launchShowDuration` is a
20-second **backstop** rather than the mechanism. The launch storyboard is also
pinned to the cream `#fdfaf1` and to light appearance, so the status bar
resolves to dark icons instead of following the system theme.

**Measured from a new recording, 20fps** (`shots-after/launch-cold-AFTER.mov`):

| | before | after |
|---|---|---|
| black before the splash | ~1.8s | **~0.85s**, and it crossfades in |
| cream splash | ~1.9s | ~1.7s |
| **blank white** | **~5.3s** | **none — no white frame at any sample** |
| to usable UI | ~9.4s | ~3.4s |

Capacitor's "SplashScreen was automatically hidden after default timeout"
warning no longer appears in the launch log.

### F7 — invoice amounts are readable on a phone 🟠→✅

The client Billing tab now uses the same `InvoiceCard` the Invoices page already
had below `md`. The table alone was never going to work: six columns inside
`w-full` can never exceed their container, so `overflow-x-auto` never engaged.

**Verified at 402px:** amounts render in full — $88.00, $100.75, $113.50,
$126.25 — with no visible table and no sideways page scroll —
`shots-after/08-client-billing-402.png`.

### N7 — the demo login works ✅

The earlier `invalid_credentials` was a wrong password on my side, not a broken
account. Confirmed against the live auth API (HTTP 200, `owner@demo.test`). The
App Store Connect demo-account requirement is satisfiable.

The password itself is deliberately not written down here. It is an argument to
`ios/UITests/reset-tour.sh` and `run-tour-test.sh`, and nothing in this
repository contains it.

### Also fixed, not previously reported

`ios/App/App/Info.plist` declared `UIRequiredDeviceCapabilities = armv7` — a
statement that the app **requires a 32-bit ARM CPU**, which no device Apple
still supports has, and the opposite of true for an arm64-only build with an
iOS 15 deployment target. Now `arm64`.

## Diagnosed, deliberately not fixed

### F6 — React #418 on every cold launch 🟠

Still present. What the investigation established, so nobody repeats it:

- It is **not iOS-specific and not ours**: it reproduces in desktop Chromium
  loading `dist-native/client` from a plain static server.
- It is **not the Toaster**: removing `<Toaster>` and rebuilding did not change
  it.
- It is **not the prerender mask path**: `spa.maskPath` leaves the prerendered
  `<body>` byte-for-byte identical, because `TSS_SHELL` renders the shell only.

The cause is structural to TanStack Start's SPA shell: the outlet is emitted as
an **empty RESOLVED** Suspense boundary (`<!--$--><!--/$-->`, not a pending
`<!--$?-->`), so React is told the server finished rendering nothing there, and
the client then hydrates a real route into it. The obvious fix — mount instead
of hydrate for the bundled build — is not available: the entry hydrates
`document`, and React refuses `createRoot(document)`.

It is a console error and one extra client render at boot; the app recovers and
renders correctly. Fixing it properly means a custom client entry coupled to
framework internals, which is a worse trade than living with a known, documented
error. `spa.maskPath` was still set to `/auth` — a real but separate improvement
(the shipped `<head>` now matches the first screen instead of carrying the
root's generic title).

## Still not tested — unchanged

N1 (a photo reaching a visit), N2 (haptics), N3 (real airplane mode and the
dead-zone resume), N4 (APNs), N5 (signing and hardware), N6 (Slide Over) and N8
(the launch storyboard on real hardware) all still need a physical device. F1's
fix was verified with the host Mac's Wi-Fi off, which remains an approximation
of a phone losing its radio.

One thing worth adding to that list: **the offline dashboard is thin**. It
renders, signed in, with the org name and role — but the stat cards show dashes
and "No routes yet", because the persisted read cache holds only `["my-org"]`.
That is the designed behaviour for an owner who has not opened My Day, and it is
not a login wall, which was the failure. Whether a **tech's** day survives the
same test is exactly what N3 still needs a device for.

## Checks run

- `npm test` — **3041 passed**, 36 skipped, 0 failed (25 new assertions)
- `npx tsc --noEmit` — clean
- `npm run test:viewports:auth` — **84 passed** (20 signed-in surfaces × 4 widths)
- `npm run test:viewports:public` — **58 passed**
- `xcodebuild` — `** BUILD SUCCEEDED **`, reinstalled and re-exercised
- `eslint` on every changed file — no new errors. The repo's lint baseline is
  already red with `no-explicit-any` on untouched files; this work adds none.

---

# Fenced off from the web app — 2026-08-21

**One codebase, two products.** `src/` is the web app `main` deploys to
app.houndstack.com. `ios/` is a native shell that bundles a *build* of that same
`src/`, and `ios/App/App/public` is gitignored with zero tracked files — a copy
`cap sync` regenerates and overwrites. So there is **nowhere in `ios/` to put a
React, layout or behaviour change**: those must live in `src/`, which means they
are live on the web the moment they merge.

Five of the seven fixes above were in shared code. Owner decision (2026-08-21):
the iOS work must not change what is already set up on the web. All five are now
behind a build-time flag.

## The switch

`src/lib/native-build.ts` exports `IS_NATIVE_BUNDLE`, derived from
`import.meta.env.VITE_NATIVE_BUNDLE`, which `vite.config.ts` defines **only** in
its `NATIVE_BUILD` branch. Build-time rather than `Capacitor.isNativePlatform()`
on purpose: a runtime check still ships both branches to the web bundle, where a
later refactor can enable the wrong one.

It is a **separate key** from `VITE_NATIVE_API_ORIGIN`. The origin answers
"where do server functions go"; this answers "may I change how the product looks
and behaves". Overloading one on the other would mean a future staging origin
silently switching UI branches on.

| fix | native gets | web keeps |
|---|---|---|
| F2 viewport | `viewport-fit=cover` | `width=device-width, initial-scale=1` |
| F2 PublicShell | safe-area padding, as an **inline style** | the flat `px-4 py-10` |
| F7 invoices | `InvoiceCard` below `md` | the existing table |
| F4 Stripe | 25s deadlines + inline error + "Try again" | the existing unbounded awaits |
| F1 auth | offline-tolerant `resolveIdentity`, bounded, native-aware | the original `getUser().then(...)` bounce and `navigator.onLine` |

The PublicShell padding is an inline style rather than Tailwind classes
deliberately: Tailwind emits a rule for every class it finds in source, branch or
not, so arbitrary safe-area utilities would have landed in the **shared**
stylesheet — the hosted CSS growing rules for a platform it does not serve.

## Proof the hosted build is unaffected

Built `.output` from a clean `HEAD`, then again with all of this work applied.

- **`styles-nHjrh_a9.css` is byte-identical, filename hash included.** No style
  change is possible.
- **`viewport-fit` appears nowhere** in `.output` — client or SSR.
- **Zero occurrences of `VITE_NATIVE_BUNDLE`** in either bundle: the flag folds
  completely, taking its branches with it. Independently confirmed by the
  absence of every native-only string (`calc(2.5rem + env(safe-area-inset-top))`,
  the card-form timeout copy).
- `server/_ssr/ssr.mjs` differs **only** by one chunk filename reference.
- Everything else that differs is naming churn: chunk hashes moved because a new
  module changed the graph, and `sw.js`'s precache manifest lists those names.
  `.DS_Store`, `nitro.json` and `server/index.mjs` already differ between two
  identical builds — that is the measured noise floor, not an effect of this work.

And behaviourally: `npm test` 3059 passed, `npm run test:viewports` 144 passed
(1 fixme, below). Re-verified on the device after gating — the tab bar still
clears the home indicator by 43.3pt, and an offline cold launch still lands on
the dashboard rather than the sign-in form.

`tests/an-ios-fix-that-would-have-shipped-to-the-web-app.test.ts` pins the
invariant: every shared file this pass touched carries the gate, and the web
branch of each is still the thing it always was.

## A pre-existing web bug this turned up

**The client Billing tab scrolls sideways at phone widths on the hosted app** —
603px of content in a 402px viewport, with `table.w-full` measured 582px wide
inside a scroll container that grows to fit it instead of clipping it. That
breaks the hardest rule in `CLAUDE.md`: *"No horizontal page scroll, ever."*

It is **not** caused by this work: stashing the only change made to
`billing-panels.tsx` and re-measuring gives the same 603px and the same
offending element. The repo's own signed-in sweep misses it because it loads
`/clients/:id` on the default Summary tab and never opens Billing.

The native fix removes the table and with it the overflow, but it is gated, so
the web still has this. Recorded as a standing `test.fixme` in
`tests/viewports/the-store-gate-only-exists-at-runtime.spec.ts` so every run
keeps saying so. Fixing it is a web decision and wants its own call: either
ungate the invoice cards, or give the scroll container a `min-w-0` chain so it
actually clips.


---

# Re-verification on the fixed, gated build — 2026-08-21

Everything below was re-run against the binary that carries all the fixes AND
the web fencing, to confirm the gating did not undo the fixes.

## Confirmed on the device

- **Session persists across a hard kill.** `simctl terminate` + relaunch returns
  straight to the signed-in dashboard.
- **Safe areas.** Bottom tab bar content ends at **830.7pt of 874pt — a 43.3pt
  gap**, unchanged from the pre-gating measurement, so `env(safe-area-inset-*)`
  still resolves in the native bundle. On `/auth`, the wordmark now begins below
  **133pt** against a 59pt inset (was 30.0pt, i.e. under the clock and island) —
  `shots-after/11-auth-safe-area-FIXED.png`.
- **Offline cold launch** still lands on the dashboard, signed in, with Wi-Fi off.
- **Launch sequence** still cream splash with no blank-white gap.
- **Push wiring intact.** The launch console shows `PushNotifications
  addListener` **twice** — the `registration` listener and the
  `pushNotificationActionPerformed` listener that `initPushDeepLinks` installs —
  plus `requestPermissions` → `{"receive":"granted"}` and `register`. The only
  change to the push code in this entire body of work is prettier rewriting
  single quotes as double quotes; the routing and the same-origin check are
  byte-equivalent to the build on which the three-case tap test passed.

## All three finished on the device — 2026-08-21

The three checks that had been left open are now done, and done repeatably.

Host UI automation stayed unavailable: macOS revoked Terminal's Accessibility
grant and re-granting does not reach an already-running process, so Terminal
would have had to be relaunched — ending the session driving the tests.
`ios-webkit-debug-proxy` was tried and does not work against a simulator either:
its `--simulator-webinspector` socket is launch-on-demand and only exists while
Safari's Develop menu is attached, which needs the same GUI. Both dead ends are
recorded in `ios/UITests/README.md`.

The fix was to stop driving from the host. **`ios/UITests/` is a standalone
XCUITest project** that runs inside the simulator: no permission to grant,
nothing that can be revoked mid-run, and it drives the app by bundle id so it
never references — and can never be clobbered by — Capacitor's `App.xcodeproj`.

| check | result | evidence |
|---|---|---|
| App Review gate | **PASS** — read-only plan and the "managed on the web" note present; Cancel/Resume, the card form, add-ons and every plan control absent across the whole scrolled route | `shots-after/uitest-billing-gate-top.png`, `-page-2`, `-page-3` |
| Customer payment surfaces | **PASS** — Payment methods and Add card still present on a client's Billing tab | `shots-after/uitest-client-billing-payment-methods.png` |
| Invoice amounts at phone width | **PASS** — amounts render in full rather than clipping to a bare `$` | `shots-after/uitest-client-invoices-phone.png` |
| Push tap → deep link | **PASS** — banner delivered by `simctl push`, tapped, landed on **My day** rather than the default screen | `shots-after/uitest-push-banner.png`, `uitest-push-landed.png` |

Four things about driving a Capacitor WebView cost real time and are worth
knowing before extending this, all handled in `AppDriver.swift`:

- **Element types do not map from HTML.** A clickable `<div>` arrives as
  `.other`, not `.button`.
- **Frames are in the WebView's own coordinate space.** A palette row reports
  440pt wide on a 402pt screen, so a coordinate tap derived from a frame lands
  nowhere near it. The palette is driven with Return instead.
- **Short labels are ambiguous.** Typing "billing" leaves a *Billing* section
  header AND a *Billing* row under *Settings*; a substring match taps the
  header and goes nowhere.
- **The keyboard covers the results.** They are in the tree, they report as
  tappable, and the tap hits a keycap.

Two failures during development are worth recording because both looked like
product bugs and were not. Asserting "signed out" immediately after launch
caught the legitimate `/auth` transient before the landing effect runs.
And `allElementsBoundByIndex` went stale mid-iteration — "No matches found for
Element at index 64" — which the first version reported as a clipped invoice
column. Both are now guarded.

### Still needing a physical device

Unchanged: camera capture landing on a visit (N1), haptics (N2), real airplane
mode and the dead-zone resume (N3), APNs proper (N4), signing and hardware (N5),
Slide Over (N6). The harness above is where those belong when a device is
available — it already presses Home, taps SpringBoard and reads notifications.

---

# The top bar while scrolled — 2026-08-21

**Reported:** "the top bar is buggy when scrolling/while scrolled."

**Reproduced** on Settings › Billing: once the page moves, the sticky bar's
controls are drawn **inside the status bar**. "9:41" lands on the search icon;
the signal, wifi and battery glyphs land on the weather and notification icons.

**Cause.** `src/routes/_authenticated/route.tsx` renders the bar as
`sticky top-[var(--hs-banner-h,0px)] … h-14`. Inside a `viewport-fit=cover`
WebView, `top: 0` is the PHYSICAL top of the screen, so a fixed-height bar puts
its own row under the clock.

Not a regression from the safe-area work, but not untouched by it either. The
build before `viewport-fit=cover` was broken differently and arguably worse:
page content scrolled up *through* the status bar strip with the bar sitting
below it (`shots/08-billing-history-and-manage-subscription.png` shows the
paragraph text running behind the clock and the Dynamic Island). Both states are
wrong; the fix addresses the class rather than either symptom.

**Fix.** A native top bar extends *under* the status bar and paints its own
background there, with its contents padded clear. `nativeTopBarStyle()` in
`src/lib/native-build.ts` returns that pair — `paddingTop:
env(safe-area-inset-top)`, plus a height grown by the same inset for bars with a
fixed `h-14`, since padding alone pushes contents out of a fixed box.

**Applied to all three sticky headers**, which is the part worth keeping:

| header | before |
|---|---|
| `_authenticated/route.tsx` (staff shell) | `h-14`, no inset — the reported fault |
| `platform.tsx` (platform shell) | identical bar, identical fault |
| `_authenticated/my-day.tsx` | had already solved it, alone, with its own inline style |

My Day having its own spelling is how the other two came to be missing it, so
they now share one helper. `tests/an-ios-fix-that-would-have-shipped-to-the-web-app.test.ts`
asserts all three use it.

**Verified on the device, scrolled** — `sweepshots/named/settings-billing-1.png`:
the clock and status glyphs sit on the bar's own blurred background with nothing
overlapping, and the controls are below them.

## A scroll sweep, because at-rest screenshots miss this entirely

Every previous pass screenshotted pages at rest. Everything that sticks, floats
or blurs only misbehaves once the page moves underneath it — which is exactly
where this fault lived.

`ios/UITests/HoundStackUITests/ScrollSweep.swift` now walks Settings › Billing,
Invoices, Clients and Schedule from top to bottom, capturing every screenful (16
in this run) and asserting by geometry that the bar's controls never enter the
top 44pt. It catches both failure modes: a bar that stops below the inset leaves
content scrolling through the strip above it, and a bar that sticks at the
physical top draws its controls under the clock.

## Web is still untouched

`styles-nHjrh_a9.css` byte-identical, filename hash included. `viewport-fit`,
`env(safe-area-inset-top)` and the top-bar style all absent from `.output`
(client and SSR) and present in `dist-native`. `npm test` 3063 passed,
`npm run test:viewports` 144 passed, all four device tests passed.

## Seen while sweeping, not yet acted on

- **The onboarding tour fires on an offline launch.** "Welcome to HoundStack!
  1 of 8" opens over a dashboard whose figures are all dashes, because offline
  the read cache holds only `["my-org"]`. Harmless, but it is the worst possible
  moment to offer a tour of numbers that are not there.
- **Bottom padding vs the tab bar is unconfirmed.** `useTabletTier.ts` pads by
  `4.5rem + env(safe-area-inset-bottom)` ≈ 72pt + 34pt, against a bar that is
  3.5rem + the same inset. It looks right in the sweep, but the sweep never
  reached the true end of a long list, so whether the LAST row clears the bar is
  not proven. A sweep that scrolls to the bottom and measures the final row
  would settle it.

---

# The guided tour, and 62pt at the top of every screen — 2026-08-21

Two pieces of work: making the onboarding tour actually guide someone, and a
fault that turned up while proving the first one had worked.

## The tour now takes you there

**Before:** every step anchored to `[data-tour=…]`, which only ever existed on
`AppSidebar` items — and the sidebar is `hidden` below `md`. On a phone the
anchor was never found, so all eight steps fell back to a centred card over a
dimmed screen. Eight cards later nobody had been shown where anything lives,
which is the one thing a tour is for.

**Now:** each step navigates to the area it describes, the phone tab bar carries
the same `data-tour` anchors, and sections with no tab of their own
(Zones, Invoices, Settings) spotlight **More**, which is where they actually
are. `docs/` screenshots: step 4 dims the whole screen, renders the real Zones
page behind the card, spotlights More, and sits clear of the tab bar.

**Dismissal is per user, per device, and works offline.** `src/lib/tour-seen.ts`
keeps a local record keyed by user id. The old record was only
`user_metadata.tour_seen_at`, read over the network, and the read failed OPEN —
offline `data.user` is undefined, so `seen` is undefined, so the tour started,
on every single offline launch, over a dashboard whose figures were all dashes.
Local and server are OR'd, not synchronised: a false "seen" costs a re-run from
the Knowledge Center, a false "unseen" is the bug above.

### It navigated in a circle and rendered a blank white screen

Caught by `TourWalk` on its first run. Step 8's screenshot was a status bar and
nothing else.

The navigation effect was guarded the obvious way — `if (pathname ===
step.route) return` — which assumes the router ends up where it was sent. A
route whose `beforeLoad` throws a `redirect` never does: `/settings` lands on
`/settings/preferences`, which still is not `/settings`, so the effect fired
again, and again.

Fixed in both halves. The step points at `/settings/preferences`, the page it
actually settles on; and the effect is keyed on a `useRef` of the step index, so
it navigates once per step and cannot loop regardless of where the router ends
up. `tests/a-guided-tour-that-navigated-in-a-circle.test.ts` guards the first —
mutation-tested against the version that shipped, where it names the file, the
route and the fix.

Worth noting how nearly invisible this was: steps 1–7 average a pixel value
around 145 (dim overlay over real content) and step 8 is 254. Without a
screenshot per step it would have read as one flaky assertion.

## `ios.contentInset` was costing 62pt at the top of every screen

Found while checking why the tour's dim overlay stopped short of the status bar.

`capacitor.config.ts` had `contentInset: "always"`. That is WKWebView's scroll
view inset, and it applies the safe area to the **document**. The accessibility
tree put `<body>` at y=62 inside a WebView measured `{{0,0},{402,874}}`. Three
consequences, none of them visible without measuring:

- `env(safe-area-inset-top)` still resolves to 62 inside that inset document, so
  the header's own padding was a **second** inset. 62pt of dead white space
  above the top bar on every screen. `main` began at 180pt; it now begins at 118.
- `position: fixed; inset: 0` resolves to the inset viewport, so nothing fixed
  could reach the top of the screen. The tour's overlay stopped dead at 62pt and
  left a bright white strip across the top of an otherwise dimmed app.
- The header is designed to extend **under** the status bar and paint its own
  background there (`nativeTopBarStyle`, added earlier this pass). It never
  could, because the document it lives in started below it.

Set to `"never"`, handing the safe area back to CSS, which is where this
codebase already handles it and what `viewport-fit=cover` exists to make
resolve. Measured after: document at y=0, header 0→118pt with its controls at
67pt, `main` at 118pt, and the tab bar still ending 34pt clear of the bottom —
the home-indicator inset, unchanged.

**Why a screenshot could never have found this.** "The WebView does not reach
the top" and "the WebView reaches the top and the page inside it starts low"
are the same picture — white above a white header — and have completely
different fixes. It took the accessibility tree to tell them apart. New guard:
`Geometry/testTheTopBarStartsAtTheTopOfTheScreen`, mutation-tested by putting
`"always"` back, where it fails with the real numbers (62.0pt, 129.0pt) and
names the config key.

## The harness was hiding failures behind unrelated ones

Three fixes, all of which had produced a misleading run at least once:

- **The tour blocks the palette.** Most tests navigate by the command palette;
  a first-run tour is a modal over it, and the resulting error is `Neither
  element nor any descendant has keyboard focus` — a message naming neither a
  tour nor a palette. `dismissTourIfPresent` polls (the tour renders a second or
  two after first paint, so one check finds nothing) and runs after `isSignedIn`
  (in front of it, its polling made the sign-in probe time out and turned two
  tests from failing into *skipped*).
- **`dismissKeyboard` did not check whether the keyboard went.** "Done" above a
  web input is a checkmark glyph, and its hittability depends on the keyboard
  animation. It now reports, and callers stop rather than tapping a keycap.
- **One stuck overlay failed every test after it.** The tap above left the
  palette open across the whole app, and the next surface spent 30s unable to
  find a top bar the palette was covering — 40s of silence pointing somewhere
  entirely innocent. `closePaletteIfOpen` at the top of each iteration keeps one
  real failure from becoming four confusing ones.

`TourWalk` also gained a blank-screen guard: it asserts the card is still up at
each step, so a vanished tour fails naming the step that did it, and its
silent `break` on a missing Next button is now an explicit failure.

`ios/UITests/run-tour-test.sh` runs the tour walk in its own invocation, because
there is only ever one first run and whichever test launches first consumes it —
running the whole suite after a reset passes the others and *skips* TourWalk,
and a skip reads almost exactly like a pass.

## Checks run

| check | result |
|---|---|
| `npx vitest run` | **3078 passed**, 36 skipped |
| `Geometry` | passed; fails on `contentInset: "always"` |
| `TourWalk` | passed, from a reset tour state |
| `HoundStackUITests` ×3 + `ScrollSweep` | passed together, from a reset tour state |
| tour overlay top edge | 62.0pt → **0.0pt** (dim reaches the status bar) |
| `main` top edge | 180pt → **118pt** |
| tab bar bottom gap | 34pt, unchanged |

### The confirming run

On a simulator restarted from cold, warmed up, then run once:

```
Geometry/testTheTopBarStartsAtTheTopOfTheScreen   passed ( 16.2s)
testBillingGateHidesEveryPurchaseControl          passed ( 36.1s)
testClientBillingKeepsItsPaymentSurfaces          passed ( 23.9s)
testInvoiceAmountsAreLegibleOnAPhone              passed ( 22.4s)
ScrollSweep/testScrolledChromeHoldsUp             passed (125.8s)
** TEST EXECUTE SUCCEEDED **

TourWalk/testTourWalksThroughTheAppAndStaysDismissed   passed (55.2s)
```

All six, first attempt, no re-runs. The tour screenshots from that run measure
the fix directly: every step's dim overlay starts at y=0 rather than 62pt, and
every step's mean pixel value is 132-137 — real content behind a dimmed screen.
Step 8, the blank one, is 136 where it was 254.

## The device suite is still not fully deterministic, and saying so is the point

The run above was clean, and so were several before it — but not all of them,
and the failures were never the same twice. This is stated rather than
averaged away, because a harness whose flaky runs get quietly re-run until they
are green is a harness that will one day hide something real.

Two distinct causes, both outside the app:

- **The simulator wedges after roughly twenty app launches.** Every test then
  fails with `Failed to launch consulting.thenorth.pal: Timed out attempting to
  launch app`, and a screenshot shows a blank white screen. It is CoreSimulator,
  not the product: `xcrun simctl shutdown && boot` clears it completely. One run
  hung with no output for over twenty minutes and had to be killed. Restart the
  simulator between full runs, and treat an all-tests-failed run as an
  environment result rather than a product one.
- **A launch takes 40-60s to paint after a fresh boot**, showing pure black
  throughout. Whatever test goes first absorbs that. Worth stating precisely
  because it was briefly misdiagnosed here: three launches sampled at 22s each
  read `rgb(0,0,0)` and were taken for a broken app, when WebKit had logged
  `didCommitLoadForFrame` and `didFinishLoadForFrame` with no crash and the page
  simply had not painted yet. A screenshot at 60s read white and the suite went
  green immediately after. `docs/ios-build.md` has the warm-up sequence — the
  point of which is to sample LATE, not to relaunch.
- **A real backend behind a 30s timeout.** Signed-in surfaces wait on
  api.houndstack.com, and Settings › Billing does several round trips before it
  renders "Current plan". `elementTimeout` is now 60s, because at 30 a slow
  backend and a broken page were the same result.

The rule this pass has been following applies to its own harness: a test that
failed for a reason having nothing to do with what it asserts has not passed,
and must not be reported as though it had.

The converse bit too, and is worth recording as the sharper lesson. Three
launches sampled at 22s each read pure black, and that was written up here as a
product fault before anything checked the WebKit log — which said the page had
committed and finished loading with no crash the entire time. The app was
painting late, not failing. **A measurement repeated three times is still one
measurement if it is taken the same wrong way each time**, and "consistent" felt
exactly like "confirmed". The suite went green immediately afterwards with no
code change at all.

## What ships to the web, and what does not

`contentInset` lives in `capacitor.config.ts`, which the hosted app never
loads — that fix is native by construction.

**The tour changes are SHARED and do reach app.houndstack.com.** That is
deliberate rather than an escape: a tour that walks you to each area is an
improvement everywhere, and on desktop it still anchors to the sidebar it always
used. It is called out here because it is the one thing in this pass that is not
fenced, and it is a visible behaviour change to the hosted product — the tour
now navigates, where before it described eight areas from wherever you happened
to be standing.

Re-verified that nothing else leaked:

- `styles-nHjrh_a9.css` — **the same content hash** as the clean-`HEAD` build
  recorded earlier in this document. The shared stylesheet is byte-identical, so
  no style change is possible.
- **Zero occurrences** of `viewport-fit=cover`, `safe-area-inset-top`,
  `VITE_NATIVE_BUNDLE` and the store-gate copy in the hosted `.output` —
  matching the clean-`HEAD` build exactly.

One method note, because the earlier version of this section overstates what a
diff can do: comparing built filenames is **not** a valid check here. Any change
to a shared chunk renumbers the graph, and a normalised content comparison of
`HEAD` against this work reports 186 changed chunks including pure icon chunks
(`x.js`, `check.js`) that have no source change at all. The stylesheet hash and
the string-absence checks are the load-bearing evidence; chunk-name churn is
noise.
