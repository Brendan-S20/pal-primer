# Generating Android, and what it broke

2026-08-22. `npx cap add android` on a repo that had shipped iOS.

## It builds — 2026-08-22

**BUILD SUCCESSFUL in 6m 27s**, 368 tasks. `android/build-debug.sh` reproduces
it; the toolchain notes are in its header.

The first pass of this document was written with no JDK and no Android SDK on
the machine, and said so at length. Both are installed now, entirely under
`$HOME` with no sudo:

- **JDK 21** via `brew install openjdk@21` — the FORMULA, deliberately. The
  cask writes to `/Library/Java/JavaVirtualMachines` and wants an admin
  password; the formula installs under `/opt/homebrew` and does not. AGP 8.13
  needs 17 as a floor and is happiest on 21.
- **SDK** — command-line tools unzipped to `~/Library/Android/sdk`, then
  `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`.

The APK is 11MB and carries all 375 files of the web bundle, including the
chunk that sets `viewport-fit=cover` at runtime — so the safe-area opt-in
reaches Android as well.

**It has now RUN — 2026-09-15.** This line used to say the app had never been
launched, on a device or an emulator, and that everything below about behaviour
was a claim. That is no longer true. See "The first run" at the end, which
supersedes the edge-to-edge entry in the honest list below.

## The good news first

**The App Store policy gate already covers Android.** `src/lib/app-store-billing.ts`
gates on `native` rather than `ios`, with a comment that says why:

> a rule that silently stops applying the moment `npx cap add android` runs

That is exactly what happened, and the rule held. `STORE_PLATFORMS` is
`{ios, android}`, so no HoundStack subscription can be bought inside the
Android binary either, and a tenant taking their own customer's money still
can. Nothing to do.

**The bundle is the right one.** `webDir` is `dist-native/client`, so Android
got the same native build as iOS — `viewport-fit=cover` and the native API
origin are both present. Checked by grepping the copied assets, because the
alternative (the hosted build ending up inside the binary) would have silently
undone the whole gating exercise.

**The generated `.gitignore` has the same discipline as iOS**: the copied web
assets and the generated `capacitor.config.json` are both excluded, so the
binary's contents cannot drift into version control.

## What was actually broken

### The manifest declares one permission and the app needs five

`cap add` generates a manifest with `INTERNET` and nothing else.

**A correction to the first version of this document.** It said every Capacitor
plugin manifest is empty, so nothing merges permissions in. That was an
overclaim: three were checked and the conclusion was drawn about all nine. The
build settled it — the APK's merged manifest contains `VIBRATE`,
`ACCESS_NETWORK_STATE`, `WAKE_LOCK` and `c2dm.RECEIVE`, none of which were
declared by hand. Two plugin manifests DO declare a permission
(`@capacitor/haptics` → VIBRATE, `@capacitor/network` → ACCESS_NETWORK_STATE),
and firebase-messaging contributes the other two transitively.

What is true, and is what matters: the three plugins whose features would fail
declare **nothing**.

| plugin | its own manifest declares |
|---|---|
| @capacitor/camera | *nothing* |
| @capacitor/geolocation | *nothing* |
| @capacitor/push-notifications | *nothing* |

Nine plugins are installed. Three need a permission. None had one.

| missing | plugin | what happens on a device |
|---|---|---|
| `CAMERA` | @capacitor/camera | completing a visit with a photo fails, in a yard, mid-job |
| `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` | @capacitor/geolocation | "locate me" on the route map fails |
| `POST_NOTIFICATIONS` | @capacitor/push-notifications | **silence** — see below |

`POST_NOTIFICATIONS` is the one to worry about. It has been required since
Android 13 (API 33) and this app targets 36. Without it, registration succeeds,
delivery succeeds, and nothing is ever shown. There is no error at any layer.
An app can look completely healthy and never notify anybody.

None of this breaks the build.

### The signed-in session was being backed up to Google Drive

`android:allowBackup` defaults to `true` in the generated manifest. The
WebView's localStorage holds the Supabase session — an access token AND a
refresh token for a live account — so the default copies a working session off
the device, into a Google account, and restores it onto whatever device signs
in next. On a debuggable build it is also readable over `adb backup`.

There is nothing to trade off here: this app keeps no local state worth
preserving across a reinstall. The session can be recreated by signing in, the
offline read cache is a cache, and the queue of pending field actions is
deliberately short-lived. Set to `false` with an explicit
`data_extraction_rules.xml` excluding every domain.

### The app was wearing Capacitor's colours

`styles.xml` references `@color/colorPrimary`, `colorPrimaryDark` and
`colorAccent`, and no `colors.xml` was generated.

This looked like a build break and is not — worth recording, because the first
read of it was wrong. The `@capacitor/android` LIBRARY ships those three names
(`#3F51B5` indigo, `#FF4081` pink) and Android's resource merging resolves them
from there. So nothing fails; the app simply wears the framework's palette
everywhere the theme shows through, starting with the boot sequence.

Now `#fdfaf1` — the same cream as the iOS launch screen and the SplashScreen
plugin config — so the boot is one colour rather than three. `windowSplashScreenBackground`
is set too, because from API 31 the system draws the splash and ignores the
`android:background` the template sets, falling back to white.

## Enforced

`tests/an-android-app-that-could-not-use-the-camera.test.ts` walks the
installed plugins, and every one that needs a permission must have it declared.
Mutation-tested against the manifest `cap add` actually produced: 6 failures,
each naming the plugin and the permission.

It also pins `allowBackup="false"` and the presence of an app-level
`colors.xml`. It `skipIf`s when `android/` is absent, so a checkout without the
platform is not failed for not having it.

## Not done — and the honest list

**Unverifiable without a running device:**

- **Edge-to-edge — ANSWERED 2026-09-15, see "The first run".** This entry
  predicted the WebView would draw under the system bars and land the header and
  tab bar wrongly. It does not. Kept here, struck through rather than deleted,
  because the prediction was reasonable and the reason it was wrong is the
  useful part.

**Needs credentials or assets:**

- **No `google-services.json`. This CRASHED THE APP — see "The first run".**
  This entry used to say push was "dead on Android in the same way it is dead on
  iOS without the APNs key". That comparison was wrong, and the difference is
  the whole point: on iOS a missing APNs key means push quietly does not arrive.
  On Android a missing `google-services.json` meant the process died on launch
  for any user who granted the notification permission. Guarded 2026-09-15; the
  file is still needed for push to actually work. Same three-step shape: create
  the Firebase app, download the file, add the server key.
- ~~The launcher icon and splash image are Capacitor's defaults.~~ The splash
  was fixed on 2026-08-22 (see above). **The launcher icon was done on
  2026-09-15**: the hound-in-H from `public/pwa-512-maskable.png`, generated at
  all five densities. The mark is scaled to 72dp of the 108dp adaptive canvas
  and padded out with the same cream, because only that centre 72dp is
  guaranteed visible -- a full-bleed foreground is cropped differently by every
  launcher's mask. The background layer moved from the template's `#FFFFFF` to
  `#fdfaf1`, so the icon, the boot splash and the first screen are one colour.
  Verified on the emulator, not just in the file sizes.

**Not looked at:**

- Deep links. Push taps route from the payload in JS (`initPushDeepLinks`), so
  they may work with no intent filter, but no `https` App Link filter exists
  and nothing has been tested.
- The Android hardware back button has a handler in `src/lib/native.ts` and has
  never been exercised.
- Nothing has run at Android viewport sizes. The Apple sweep covers 320-1366,
  which brackets most Android phones and tablets, but "brackets" is not
  "measured".

---

# The first run — 2026-09-15

The app launched for the first time, on an emulator, and **it works**. No crash,
and it renders correctly: HoundStack branding, the sign-in card, and the Google,
Apple and Facebook buttons all present.

**Rig.** `sdkmanager "emulator" "system-images;android-36;google_apis;arm64-v8a"`
— **5.5GB** installed (1.2GB emulator, 4.3GB image), which is worth knowing
before anyone budgets the 1.5GB this was first estimated at. AVD `HoundStack-QA`,
Pixel 7 profile, Android 16 / SDK 36, 1080x2400 at density 420 (412x915dp),
**gesture navigation active**, no display cutout by default.

## Edge-to-edge: measured, and the prediction above was wrong

Measured over the WebView DevTools protocol rather than from a screenshot:
`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`, then
`Runtime.evaluate`. `env()` cannot be read directly, so a hidden `position:fixed`
element takes `padding: env(safe-area-inset-*)` and its computed padding is read
back.

| | |
|---|---|
| viewport meta in the Android bundle | `width=device-width, initial-scale=1, viewport-fit=cover` |
| `env(safe-area-inset-*)`, all four | **`0px`** |
| same, with a 48dp cutout active | **`0px`** |
| window frame (`dumpsys window`) | `[0,0][1080,2400]` — the whole display |
| window flags | `EDGE_TO_EDGE_ENFORCED`, `layoutInDisplayCutoutMode=always` |
| WebView `innerHeight` | **839dp in a 915dp screen** |

Two things follow, and they pull in opposite directions.

**First, the good news.** The viewport meta IS correct in the Android bundle, so
the `IS_NATIVE_BUNDLE` gating in `src/routes/__root.tsx` reaches Android as
intended. And although the *window* is genuinely edge-to-edge, the *WebView* is
inset by 76dp — Capacitor 8 applies the system-bar insets to the WebView
container rather than exposing them to CSS. So `env() = 0` is the **correct**
value: the content never enters the unsafe region. Nothing sits under the
gesture bar, nothing is unreachable. **This is not a bug.**

**Second, the part to worry about.** Every `pb-[env(safe-area-inset-bottom)]` in
`src/` — the tab bar, the sheets, the lightbox, `PublicShell` — contributes
exactly nothing on Android. The layout is correct *only* because Capacitor
insets the container. If that behaviour changes, or somebody sets a different
`layoutInDisplayCutoutMode`, those rules become load-bearing and are already
zero — **and the class-list tests still pass, because the class IS there.**

That is precisely the trap the comment at `src/routes/__root.tsx:89` describes
for iOS, arriving on Android by a different mechanism. On iOS the fix was to add
`viewport-fit=cover`; here the tag is already present and the insets are zero
anyway, which is a failure mode that same comment does not cover.

## What this run did NOT establish

- **The cutout case is not settled.** The 76dp gap did not change when a 48dp
  cutout was enabled and verified active
  (`DisplayCutout{insets=Rect(0, 126 - 0, 0)}`). Either the inset is robust or
  the app did not re-layout — `insetsChanged=false`. Do not quote this as proof
  that notched devices are fine.
- **`MobileTabBar` was never seen.** Reaching it needs a signed-in session, and
  no credentials were used. The tab bar is the single most important surface for
  this question and it remains unobserved.
- Deep links, the hardware back button, and FCM are all untouched by this run.

## Three things that will bite the next person

- **The build fails after `npm ci`.** Gradle caches references to
  `node_modules/@capacitor/*/android/build`, which `npm ci` deletes:
  `Failed to create MD5 hash for file '.../id-to-file.tab' as it does not exist`.
  Fix: `./gradlew --stop`, then remove `android/build`, `android/app/build` and
  every `node_modules/@capacitor/*/android/build`.
- **A timed-out `adb` call kills the emulator.** If an `adb` invocation is killed
  mid-start it leaves the daemon broken and the emulator dies with
  `Unable to connect to adb daemon on port: 5037`. Start
  `adb -a server nodaemon` as a persistent process *before* launching.
- **`monkey` cannot launch this app.** `monkey -p consulting.thenorth.houndstack
  -c android.intent.category.LAUNCHER 1` exits `-5` even though the package is
  installed. `am start -n consulting.thenorth.houndstack/.MainActivity` works.

## The crash the first run found — 2026-09-15

Granting the notification permission **killed the app**, deterministically.

```
FATAL EXCEPTION: CapacitorPlugins
Caused by: java.lang.IllegalStateException: Default FirebaseApp is not
  initialized in this process consulting.thenorth.houndstack.
    at com.google.firebase.messaging.FirebaseMessaging.getInstance
    at com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin.register:103
```

`registerPushNotifications()` asks for the permission, and on `granted` calls
`PushNotifications.register()`. That reaches `FirebaseMessaging.getInstance()`,
which throws because there is no `google-services.json`.

**Three things about it are worth keeping.**

**It cannot be caught in TypeScript.** The exception is raised on the native
`CapacitorPlugins` thread, so `await PushNotifications.register()` never
rejects. A `try/catch` around it does nothing — checked, not assumed.

**It lands only on users who say yes.** Deny the permission and
`registerPushNotifications` returns at the `perm.receive !== "granted"` check
before `register()` is reached. So the failure mode selects for the users who
agreed to notifications, and an emulator with the permission denied looks
perfectly healthy.

**Nothing in the suite could have seen it.** 3,625 unit tests, a typecheck and
four browser sweeps all pass with this present, because it is a native crash in
a plugin the web bundle never loads. It took running the app.

### The guard

`FCM_CONFIGURED` in `src/lib/native-build.ts`, defined by `vite.config.ts` from
whether `android/app/google-services.json` exists at build time.
`registerPushNotifications` returns early on Android when it is false, and says
so in the console rather than failing silently.

It maintains itself: drop the real `google-services.json` into `android/app/`
and push registration switches back on at the next build with no code change.
iOS is deliberately not gated — it reaches APNs without Firebase.

Verified on the emulator under the conditions that crashed: permission granted,
**0** fatal exceptions where there was reliably 1, app alive and focused.

**This is a guard, not the fix.** Push still does not work on Android and will
not until the Firebase config exists.

## Also verified in that run

- **The hardware back button works as documented.** At the navigation root it
  minimizes rather than exiting: process alive, pid unchanged, focus to the
  launcher. `src/lib/native.ts` promised "never exit-blast the WebView" and it
  does not. Previously listed as "has a handler and has never been exercised".
