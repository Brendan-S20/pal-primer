# Google Play submission: HoundStack for Android

Written 2026-09-15. **Nothing here has been submitted, and no Play Console
account is known to exist.** Before this file there was no document in `docs/`
that mentioned Play Store, Google Play or Play Console at all — that track was
at zero, which is worth stating plainly rather than discovering at submission.

This is the Android counterpart to `docs/app-store-submission.md`. Where the two
agree, this file says so and points there rather than restating it; where Play
differs from the App Store, the difference is the whole point of the section.

**Read `docs/android-generated.md` first.** It records what `npx cap add android`
produced, what had to be fixed, and — under "The first run" — what happened when
it was finally launched.

This paragraph said "the app has never run" when this file was written on
2026-09-15, and stopped being true a few hours later on the same day. It has now
run on an emulator: it does not crash, it renders correctly, and edge-to-edge,
the tab bar, the back button and the launcher icon were all measured rather than
assumed. What it has NOT done is run on physical hardware, which is a different
and smaller claim — see §3.

---

## 1. The review risk — already handled, and not by accident

Google's position on real-world goods and services matches Apple's: a payment
for a service performed at a physical address is outside Play Billing, and
digital software sold to the person holding the phone is inside it. HoundStack
has both, and they are already separated.

`src/lib/app-store-billing.ts` gates on **`native`**, not on `ios`:

```ts
const STORE_PLATFORMS = new Set(["ios", "android"]);
```

with a comment in the file explaining the choice — gating on `ios` alone would
have left "a rule that silently stops applying the moment `npx cap add android`
runs". That is exactly what happened, and the rule held. No HoundStack
subscription is purchasable inside the Android binary, and a tenant taking their
own customer's money still can.

So the highest-stakes review item needs **nothing** for Play. The reasoning, the
distinction between `createAddonSubscription` and `subscribePlatformAddon`, and
the twelve mutation-checked tests that pin both directions are all documented in
`docs/app-store-submission.md` §1. Do not re-derive them here.

---

## 2. What Play needs that the App Store did not

This is the section that earns this file. Four of these are unstarted.

### 2a. Play wants an **Android App Bundle**, and this repo builds a debug APK

`android/build-debug.sh` runs `./gradlew assembleDebug`. That is correct for
what it is for — reproducing the build locally — and it is **not** what Play
accepts. Play has required `.aab` for new apps since August 2021.

    ./gradlew bundleRelease        # produces app/build/outputs/bundle/release/

### 2b. There is no release signing config, so a release build is unsigned

`android/app/build.gradle` has a `release` block containing exactly one line,
`minifyEnabled false`. There is **no `signingConfig`**, and no keystore anywhere
in the tree — which is correct, a keystore must never be committed, but it means
`bundleRelease` today produces something Play will reject.

What this needs, in order:

1. **An upload key**, generated once and kept somewhere durable:

       keytool -genkey -v -keystore houndstack-upload.jks \
         -keyalg RSA -keysize 2048 -validity 10000 -alias upload

2. A **gitignored** `android/keystore.properties` holding the path and
   passwords, and a `signingConfigs.release` in `build.gradle` that reads it.
   `.gitignore` already covers `*.jks`, `*.p12` and `AuthKey_*.p8`; add
   `keystore.properties` and `*.keystore` when this is wired.
3. **Play App Signing** enabled in the console, which is the default for new
   apps. Google then holds the app signing key and your upload key only signs
   uploads — so losing the upload key is recoverable and losing the app signing
   key is not. This is the opposite of the Apple `.p8` situation described in
   `docs/owner-actions-before-submission.md` §2, and worth not confusing.

**The same warning as the `.p8`:** whoever holds the upload key can push builds
to your listing. Keep it out of the repo directory, not merely out of git.

### 2c. The Data safety form

Play's equivalent of the App Privacy questionnaire, and it is **not** a copy of
it — Play asks separately about collection, sharing, encryption in transit, and
whether users can request deletion. The answers should follow the same facts the
App Privacy questionnaire used (`docs/owner-actions-before-submission.md` §4,
marked DONE), but they must be entered fresh and they are attested.

Permissions the form will ask about, all seven verified present in the manifest:
`INTERNET`, `CAMERA`, `READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE` (the
pre-Android-13 form of the same thing, capped by `maxSdkVersion`),
`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` and `POST_NOTIFICATIONS`.
Location is the one that draws scrutiny: it is used to show a technician
their position against the day's route, and it is **foreground only** — there is
no background-location permission declared, which is the request that triggers
Play's separate review and a demo video requirement. Keep it that way unless
there is a reason not to.

### 2d. Content rating, and the rest of the console checklist

- **IARC content rating questionnaire** — no App Store equivalent. Short, but
  the listing cannot publish without it.
- **Privacy policy URL** — required in the listing, not just in-app.
- **Target API level** — Play requires new apps to target within one year of the
  latest Android release. `variables.gradle` pins `targetSdkVersion = 36`, which
  is current. Nothing to do now; it expires on a clock, so it is a recurring
  item rather than a one-off.
- **Testing track** — internal testing is the Play analogue of TestFlight
  Internal, and is the right place for the first install.

---

## 3. What is genuinely not ready, ranked

Everything here is from the audit on 2026-09-15 and is verified, not assumed.

| | state | needs |
|---|---|---|
| **Edge-to-edge** | **no handling anywhere** | a running app |
| **Deep links** | only `MAIN`/`LAUNCHER` | a decision + hosted `assetlinks.json` |
| **Release signing** | absent | an upload key (§2b) |
| **AAB build** | builds a debug APK | a gradle task (§2a) |
| **FCM push** | **absent — CRASHED the app until guarded 2026-09-15** | a Firebase app |
| Launcher icon | ~~stock template~~ **done 2026-09-15** | — |
| Back button | handler exists, never exercised | a running app |
| Splash | correct, cream `#fdfaf1` | — |
| Permissions | 7 declared, test-enforced | — |
| Billing gate | covers Android already | — |

### Edge-to-edge is the one to be afraid of

`grep` across `android/app/src/` for `EdgeToEdge`, `fitsSystemWindows`,
`WindowInsets`, `setDecorFitsSystemWindows` and
`windowOptOutEdgeToEdgeEnforcement` returns **nothing**. `MainActivity` is a bare
`BridgeActivity` with an empty body. `styles.xml` sets
`android:background="@null"` on `AppTheme.NoActionBar` and says nothing about
insets.

`targetSdkVersion = 36`, and Android **enforces** edge-to-edge from API 35. So
the WebView draws under the status and navigation bars, with no opt-out and no
explicit inset propagation. Whether `env(safe-area-inset-*)` resolves in
Capacitor's Android WebView is the open question.

This is the same shape as iOS F2 — `viewport-fit=cover` missing, every safe-area
inset resolving to 0, 62pt of dead space and a `fixed` overlay that could not
reach the top. That one cost a day. The geometry harness in
`ios/UITests/Geometry.swift` is the shape of the check to copy, and
`docs/ios-qa-results.md` F2 is the fix to read before starting.

**Do not guess this one from the source.** It needs a running app.

### Deep links are more broken than "not looked at"

`AndroidManifest.xml` has exactly one `intent-filter` and it is `MAIN` /
`LAUNCHER`. No `https` App Link filter, no custom scheme. So **tapping a link to
app.houndstack.com opens the browser, not the app** — which matters for a
product that emails invoice and portal links.

Push taps are unaffected: `initPushDeepLinks` routes from the payload in JS, so
they work with no intent filter at all. That is why `docs/android-generated.md`
was right that push "may work" and silent about web links — the two are
different mechanisms and only one of them is missing.

Adding the filter requires a `assetlinks.json` hosted at
`https://app.houndstack.com/.well-known/assetlinks.json` carrying the signing
certificate fingerprint — so it depends on §2b being done first, and it is a
decision about link behaviour as much as a manifest change.

---

## 4. Before you press Publish

- [ ] A Play Console account exists and the app is created.
- [ ] Upload key generated and stored **outside the repo directory**.
- [ ] `bundleRelease` produces a signed `.aab`.
- [x] **Done 2026-09-15.** The app has run on an emulator and edge-to-edge is
      measured, not assumed: the window is edge-to-edge, Capacitor insets the
      WebView to 839dp of a 915dp screen, and `MobileTabBar` sits 75.8dp clear
      of the gesture bar with every control over the 44px floor.
- [ ] Data safety form completed.
- [ ] IARC content rating questionnaire completed.
- [ ] Privacy policy URL in the listing.
- [x] **Done 2026-09-15.** Launcher icon is the hound-in-H at all five
      densities, scaled into the 72dp zone adaptive icons actually guarantee and
      padded with `#fdfaf1`. Verified on a launcher, not just in file sizes.
- [ ] Internal testing track install verified on a real handset.

Screenshots: Play's requirements differ from Apple's in sizes and counts, and
`tests/viewports/app-store-screenshots.spec.ts` already produces images under
`APPLE_SIZES=1`. It has not been extended to Play's sizes, and should be before
anyone assembles a listing by hand.
