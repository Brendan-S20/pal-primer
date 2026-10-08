# Google Play submission: HoundStack for Android

Rewritten 2026-10-03 as a checklist; listing copy updated 2026-10-07. **Nothing has been submitted, and no Play
Console app exists yet.** Every code-side piece is now done and tested; what is
left needs the owner's accounts, a key only the owner should hold, or a phone.

This is the Android counterpart to `docs/app-store-submission.md`. Where the
two agree this file points there; where Play differs, the difference is the
section. The build history (what `cap add android` produced, the first emulator
run, the FCM crash) is in `docs/android-generated.md`.

Package name (`applicationId`): **`consulting.thenorth.houndstack`**, from
`appId` in `capacitor.config.ts`. It is permanent on Play the moment the first
bundle is uploaded.

---

## 1. What is done in code

| | where | proof |
|---|---|---|
| Release signing read from outside the repo, applied only when present | `android/app/build.gradle` (header comment) | `tests/an-android-release-signed-with-nothing-in-the-repo.test.ts` |
| `keystore.properties`, `*.jks`, `*.keystore` ignored; template provided | `.gitignore`, `android/keystore.properties.example` | same test, which also checks `git ls-files` |
| versionCode explicit, one committed number, bump script | `android/version.properties`, `npm run android:bump` | same test |
| One command to a signed `.aab` | `npm run android:bundle` | prints `Signed: yes` or `Signed: NO` |
| google-services plugin applied only when `google-services.json` exists | `android/app/build.gradle` (Capacitor template, verified) | builds without it |
| Push registration skipped when Firebase is absent (it would crash) | `FCM_CONFIGURED`, `src/lib/native-build.ts` | `tests/an-android-notification-drawn-as-a-white-square.test.ts` |
| Monochrome status-bar icon, accent colour, a named channel | `res/drawable/ic_stat_notification.xml`, manifest meta-data, `ANDROID_PUSH_CHANNEL` | same test |
| **Notification taps that carried a link did nothing** (fixed) | `fcmMessageFor` in `src/lib/push.server.ts` | `tests/every-android-notification-went-to-a-decommissioned-endpoint.test.ts` |
| App Links for staff pages, verified by `assetlinks.json` | manifest intent filter, `src/lib/android-app-links.ts`, `initAppLinks` | `tests/an-android-link-opens-the-app-only-where-it-should.test.ts` |
| `/.well-known/assetlinks.json` served, 404 until a real fingerprint exists | `src/routes/[.]well-known.assetlinks[.]json.ts` | same test |
| Back button: closes the open sheet or dialog first, then history, then backgrounds from a start screen | `handleBackButton` in `src/lib/native.ts` | `tests/the-android-back-button-closes-before-it-leaves.test.ts` |
| Play-size screenshots: phone 1080x1920, 7" and 10" tablet | `tests/viewports/play-store-screenshots.spec.ts`, `npm run screenshots:play` | asserts each PNG's pixel size and 9:16 |
| No HoundStack purchase inside the binary | `STORE_PLATFORMS = {ios, android}`; plan-picker stub swapped by `NATIVE_BUILD`, which Android shares | see §5 |

### The tap bug, because the first real user would have found it

`fcmMessageFor` sent `click_action: "FCM_PLUGIN_ACTIVITY"` on every
notification that carried a link. That string is the cordova-plugin-fcm
convention: it makes a tap fire an intent with that action, and only an
activity declaring that action can receive it. Nothing in this app declares
it, so a tap on "your route changed" resolved to no activity and did nothing.
`click_action` is no longer sent; the tap launches `MainActivity`, Capacitor
turns it into `pushNotificationActionPerformed`, and `initPushDeepLinks`
routes the `url` from `data`. The web icon URL (`/pwa-192.png`) is no longer
passed as an Android drawable name either.

### Which links open the app

Staff pages only, listed in `src/lib/android-app-links.ts` with the reason for
every exclusion. Kept in the browser: everything a customer is sent (`/pay`,
`/portal`, `/q`, `/track`, `/lead`, `/signup`, `/unsubscribe`), everything that
buys HoundStack (`/billing`, `/settings/billing`, `/settings/addons`, which the
binary hides by store rule), and `/auth`, which is the **web** OAuth redirect
target: claiming it would hand a web sign-in to the app mid-flow on any phone
that has it. Android before 15 cannot exclude a path inside a claimed prefix,
so Settings is claimed page by page. The test fails if a new route is in
neither list.

### The back button

1. An open dialog, sheet, drawer, popover or menu closes (Escape, which every
   Radix layer and the two hand-rolled panels honour). A dialog that refuses
   to close keeps the screen; one that ignores Escape (the guided tour) does
   not trap the user.
2. Otherwise, back one history entry, unless on a start screen.
3. Start screens (`/`, `/auth`, the sign-in steps, `/dashboard`, `/my-day`,
   `/routes`, `/platform`, a portal home) and an empty history send the app to
   the background (`minimizeApp`, never `exitApp`).

Start screens are a list because after sign-in the history behind the
dashboard is `/auth`, which bounces a signed-in user straight back: "back"
looked dead on the screen people press it most. Accepted cost: an owner who
opens `/routes` from the dashboard leaves the app on back, because `/routes`
is a dispatcher's start screen.

---

## 2. Owner checklist, in order

Each step says what it unblocks. Steps 1 to 4 can happen today.

1. **Create the Play Console developer account** (one-time USD 25; identity
   verification can take days). Choose an **organization** account for The
   North Consulting (needs a D-U-N-S number), not personal: new personal
   accounts must run a 14-day closed test with at least 12 testers before
   they can publish to production. *Unblocks everything.*

2. **Create the app** in Play Console: name `HoundStack: Pet Business App`, default language
   English (United States), App, Free. Accept the declarations.

3. **Generate the upload key**, once, outside the repo directory:

       keytool -genkeypair -v -keystore ~/keys/houndstack-upload.jks \
         -keyalg RSA -keysize 2048 -validity 10000 -alias upload

   Store the `.jks` and both passwords in your password manager as well. With
   Play App Signing a lost upload key is recoverable (a reset request), but it
   costs days. Then `cp android/keystore.properties.example
   android/keystore.properties` and fill in the four values. Never commit it.

4. **Firebase, for push.** Steps 1-3 done 2026-10-07: project
   `houndstack-thenorth` (number 365671572406), Android app
   `consulting.thenorth.houndstack` registered as "HoundStack Android", FCM API
   (V1) enabled, legacy API disabled, and `google-services.json` committed.
   1. ~~console.firebase.google.com > Add project (or reuse one) > HoundStack.~~
   2. ~~Add app > Android > package name `consulting.thenorth.houndstack`,
      nickname HoundStack Android. The SHA-1 is optional (FCM does not need it).~~
   3. Download `google-services.json` and place it at
      `android/app/google-services.json`. It is not a secret (its API key is
      restricted to this package), and committing it is the normal choice so
      every build gets push. `FCM_CONFIGURED` switches push registration on at
      the next `build:native` with no code change. Place it **before** building:
      a binary built without it has push registration compiled off.
   4. Project settings > Service accounts > Generate new private key. Paste the
      whole JSON into the server environment as **`FCM_SERVICE_ACCOUNT`**
      (hosting secrets, not the repo). `src/lib/push.server.ts` reads it;
      until it is set, Android sends are skipped quietly.

5. **Build the bundle**:

       npm run android:bump      # skip for the very first upload (versionCode 1)
       npm run android:bundle    # build:native, cap sync android, gradle bundleRelease

   Output `android/app/build/outputs/bundle/release/app-release.aab`, and the
   script prints `Signed: yes`. Needs JDK 21 and the Android SDK; see the
   header of `android/build-debug.sh`. Commit the bumped
   `android/version.properties` with the release, so the number in git is the
   number on Play. Every upload to any track needs a higher versionCode.

6. **Internal testing track**: Test and release > Testing > Internal testing >
   Create release. Accept **Play App Signing** (the default; Google holds the
   app signing key, your key only signs uploads). Upload the `.aab`. Add
   yourself and any testers by email, and install from the opt-in link on a
   **physical** Android phone. This is the Play analogue of TestFlight
   Internal.

7. **App Links fingerprint**: Play Console > Test and release > App integrity >
   App signing > *App signing key certificate* > **SHA-256** (not the SHA-1
   beside it). Either paste it into `ANDROID_CERT_SHA256_FINGERPRINTS` in
   `src/lib/android-app-links.ts` (and update the one test that expects it
   empty), or set `ANDROID_CERT_SHA256` in the hosting environment
   (comma-separated). Add the *upload* key's SHA-256 too if you will install
   release builds that did not come from Play. Then check that
   `https://app.houndstack.com/.well-known/assetlinks.json` returns JSON and
   that Play Console's Deep links page shows the domain verified. Until then
   links open the browser, which is the safe failure.

8. **On the phone from step 6, run the device checks** (none of these can be
   proved off a device):
   - Sign in with Google, Apple and email; sign out; sign in again.
   - Grant notifications. Send yourself a push (assign a visit to yourself):
     it arrives, the status-bar icon is the white paw (not a white square),
     and **tapping it opens the right screen**. Settings > Apps > HoundStack >
     Notifications shows a channel named "HoundStack", not "Miscellaneous".
   - Back button: open a sheet (a visit on My Day), press back, the sheet
     closes and the page stays; press back on `/my-day` or `/dashboard`, the
     app goes to the background.
   - Tap an `https://app.houndstack.com/my-day` link in Gmail: the app opens
     on My Day (after step 7). Tap a pay link: the browser opens.
   - Camera on a visit photo, "locate me" on the route map, offline mode
     (airplane mode, complete a stop, reconnect, it syncs).

9. **Store listing** (Grow users > Store presence > Main store listing). The
   positioning is the iOS listing's (2026-10-07): the business system for pet
   service companies that work a route, pet-waste removal first. Routing is
   a feature, not the product.
   - **App name** (30 max): `HoundStack: Pet Business App` (28 characters,
     the same as iOS).
   - **Short description** (80 max): `Schedule, route, invoice and get paid:
     the business app for pet service crews.` (78 characters)
   - **Full description** (4000 max). The iOS text minus what only iOS has:
     no Lock Screen or Dynamic Island line (there is no Android counterpart
     to the Live Activity), and "ON iPad" becomes "ON TABLETS". Do not name
     a website to buy plans on: the same no-steering rule as the in-app copy
     (`BILLING_MANAGED_OUTSIDE_APP`).

     ```
     Schedule the work, run the route, get paid. HoundStack runs the whole business for pet service companies that work a route, starting with pet-waste removal: scheduling and dispatch, the day in the field, invoicing and payments, the client portal and the numbers behind it, in one place. Sign in with your existing account and your business is on your phone.

     FOR THE CREW
     • Today's route, in order, with the drive between stops
     • Start, complete or skip a stop in one tap
     • Photos of finished work, gate conditions and anything that needs saying
     • Gate codes, pet names and yard notes where you need them
     • Clock in and out, and log expenses on the go
     • A notification when your route changes or a stop is added to your day
     • Works with no signal. Everything you do is saved on the phone and syncs itself when you have service again.
     • In English, Spanish, Arabic and Chinese

     FOR THE OFFICE
     • Clients, properties, pets and service history
     • Scheduling, dispatch and automatic route planning across your technicians
     • An alert when a stop is skipped or a truck is running late
     • Quotes, invoices, payments, autopay and account credits
     • Timesheets, expenses and reports
     • The customer portal your clients already use

     ON TABLETS
     Built for the bigger screen, so the office side has room to work.

     REQUIREMENTS
     HoundStack is for businesses with an existing HoundStack account and for the people they invite. The app is free to download.
     ```
   - **App icon** 512x512 PNG: `public/pwa-512.png`.
   - **Feature graphic** 1024x500 PNG or JPEG: required, and not generated
     here. Make one (cream `#fdfaf1`, the hound-in-H, the wordmark).
   - **Screenshots:** `npm run screenshots:play` writes phone (1080x1920),
     7-inch and 10-inch tablet sets to `android/screenshots/`. Upload 2 to 8
     per form factor.
   - **Category:** Business. **Contact email:** support@houndstack.com.
     **Website:** https://houndstack.com.
   - **Privacy policy URL:** `https://app.houndstack.com/legal/privacy` (route
     exists: `src/routes/legal.privacy.tsx`; `https://houndstack.com/privacy`,
     the iOS listing's URL, also works). Check it loads before saving.

10. **App content** (Policy > App content). Answers in §3 and §4: privacy
    policy, ads (**no ads**), app access (the same demo owner account as App
    Review, with a note that it is a B2B app for existing organizations),
    content rating, target audience (**18 and over**), data safety, news
    (no), government (no), financial features (§4), health (no).

11. **Promote to production** once the internal build has passed step 8 and
    the pre-launch report (Play runs it automatically on testing tracks) shows
    no crashes. A staged rollout at 20% is a reasonable first release.

12. **Recurring:** the target API level must be within a year of the latest
    Android release. `targetSdkVersion = 36` in `android/variables.gradle` is
    current today; Play emails before the deadline.

---

## 3. Data safety form answers

Derived from the app and from the privacy policy at `/legal/privacy`, which is
the document these answers must agree with. Play's definitions matter:
"collected" means sent off the device; data used only on the device is not
collected; a service provider processing data for you (Supabase, Stripe,
Twilio, Resend, Google Maps, Geocodio) is not "sharing".

**Overview questions**

- Does your app collect or share any of the required user data types? **Yes.**
- Is all user data encrypted in transit? **Yes** (HTTPS only; cleartext is off
  by default at targetSdk 36 and `allowMixedContent` is false).
- Do you provide a way for users to request that their data is deleted?
  **Yes**: in the app (Profile > Delete my account, `DeleteAccountCard`) and by
  email to support@houndstack.com. Account deletion URL for the form:
  `https://app.houndstack.com/legal/privacy` (section "Data retention and
  deletion"). Play requires this URL because an account can be created from
  inside the app (Google or Apple sign-in with a new email bootstraps one).

**Data types.** All: collected, **not shared**, not processed ephemerally,
purpose **App functionality** unless stated.

| Play category | data type | required or optional | notes |
|---|---|---|---|
| Location | **Approximate location** | Optional | Only when a business turns on live tracking: rounded to about 100 m, from "on my way" until the visit starts, at most two hours, app open only; only the latest point is kept and it is deleted at visit start. Precise location is used **on the device only** (the route map), so it is not "collected". Foreground only: no background-location permission is declared. |
| Personal info | Name | Required | Also Account management |
| Personal info | Email address | Required | Also Account management |
| Personal info | Phone number | Optional | SMS sign-in codes and texting consent |
| Personal info | Address | Required | Client and business addresses the business enters |
| Personal info | Other info | Optional | Pets, gate codes and notes the business enters |
| Financial info | Purchase history | Required | Invoices and payments between a business and its clients |
| Financial info | User payment info | Optional | Card entry goes to **Stripe** (service provider); the app keeps brand and last four only |
| Messages | Other in-app messages | Optional | Conversations between a business and its clients in the inbox |
| Photos and videos | Photos | Optional | Visit and DNA-sample photos |
| App info and performance | Crash logs, Diagnostics | Required | Error reports to **Sentry** (service provider, `src/lib/monitoring/`) from the app and the server: the error, the screen's path, device and OS. Tied to the account's user id and org id only; never a name, email, IP, cookies, screen recording or performance tracing. Plus server logs for reliability and security |
| Device or other IDs | Device or other IDs | Optional | The FCM push token, for notifications only |

Do **not** declare: contacts, calendar, SMS or email on the device, web
browsing history, audio, health, files and docs, app interactions or search
history (no analytics SDK), advertising ID (none).

**On "shared":** when a business turns on live tracking, the client who got
the "on my way" message sees the technician's first name and approximate
position. Play's user-initiated exception covers this (the technician starts
it and can stop it), so the answer above is "not shared". To be conservative,
mark Approximate location as **shared**, purpose App functionality; it costs
nothing in review.

**The iOS notes already agree:** `docs/app-store-submission.md` §3 describes
live tracking (opt-in per business, approximate, only while driving to that
client) the same way the privacy policy does. An earlier version of this file
asked for that correction; it was made before the 2026-10-07 listing update.

---

## 4. Content rating and the other declarations

**IARC questionnaire.** Category: **All Other App Types** (a business utility;
not a game, not social, not reference or news). Answers:

- Violence, fear, sexuality, nudity, crude humour, language: **No** to all.
- Controlled substances (drugs, alcohol, tobacco): **No.**
- Gambling or simulated gambling: **No.**
- Does the app let users interact or exchange content? **Yes** (a business
  messages its clients through the inbox).
- Does the app share the user's current location with other users? **Yes**
  (live tracking to the client, when the business turns it on).
- Does the app allow purchases of digital goods? **No.**
- Unrestricted web access (an in-app browser to arbitrary sites)? **No.**

Expected result: Everyone / PEGI 3, with the interactive elements "Users
Interact" and "Shares Location".

**Target audience:** 18 and over only. Not designed for children; the Families
policy does not apply.

**Ads:** the app contains no ads.

**Financial features declaration:** HoundStack lets a business invoice its own
clients and take card payment for a physical service through the business's
Stripe account. It is not a bank, lender, wallet, crypto or money-transfer
app. Read the options at submission time: the closest honest answer is "my
app does not provide any of these financial features", with a sentence in App
access saying payments go through Stripe to the business; if the form insists
on a category, pick the payment-processing one rather than leave it
ambiguous. This is the one answer here that is a judgement call.

---

## 5. The billing rule on Android, confirmed

Google Play's Payments policy matches Apple's on the two kinds of money in
this app: a homeowner paying a pet-waste company for a service at their
address is outside Play Billing; a business buying HoundStack software inside
the app would be inside it. HoundStack subscriptions are web-sold, so the
binary must not offer them. Verified 2026-10-03:

- `src/lib/app-store-billing.ts`: `STORE_PLATFORMS = new Set(["ios", "android"])`.
  The runtime gate is on the running platform, and `"android"` is in it.
- The build-time half is the `NATIVE_BUILD` alias in `vite.config.ts` that
  swaps the plan picker for `PlanPicker.native-stub.tsx`. It keys on the build
  (`npm run build:native`), not on a platform, and Android bundles the same
  `dist-native/client` as iOS (`webDir` in `capacitor.config.ts`), so the stub
  is what ships in the `.aab` too. `npm run check:native-bundle` proves the
  stub is present and the real picker absent.
- No Play Billing library and no in-app products. Nothing to configure under
  Monetize.
- The App Links allowlist keeps `/billing`, `/settings/billing` and
  `/settings/addons` in the browser, so a billing email never lands the owner
  on the "managed outside the app" screen.

---

## 6. iOS universal links, noted and not done

The iOS app has no Associated Domains entitlement and the site serves no
`apple-app-site-association`, so links open Safari on iOS. The allowlist in
`src/lib/android-app-links.ts` is the source to generate the AASA
`components` from when that is wanted; it would need the entitlement in Xcode,
the Team ID in the file, and a route like the assetlinks one. Out of scope for
the Android track.
