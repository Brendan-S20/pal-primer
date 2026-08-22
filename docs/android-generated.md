# Generating Android, and what it broke

2026-08-22. `npx cap add android` on a repo that had shipped iOS.

## What could not be checked, stated first

**There is no JDK and no Android SDK on this machine.** No Android Studio, no
bundled JBR, nothing under `~/Library/Android/sdk`, `/usr/libexec/java_home`
finds nothing. So the project was GENERATED and READ; it was never built, never
installed, and never run.

Everything below is either a static fact about the generated files or a claim
about what will happen on a device. The second kind is marked, and none of it
has been observed. `docs/ios-qa-results.md` is emphatic that "passed" and "not
run" must not blur together, and this is a whole platform in the second column.

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

`cap add` generates a manifest with `INTERNET` and nothing else. The Capacitor
plugin manifests in `node_modules` are **empty** — a bare `<manifest>` element,
checked rather than assumed — so nothing merges permissions in for you.

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
each naming the plugin, the permission, and the fact that the plugin's own
manifest is empty so nothing will merge it in.

It also pins `allowBackup="false"` and the presence of an app-level
`colors.xml`. It `skipIf`s when `android/` is absent, so a checkout without the
platform is not failed for not having it.

## Not done — and the honest list

**Unverifiable without a toolchain:**

- **Edge-to-edge.** `targetSdkVersion` is 36, and Android enforces edge-to-edge
  from API 35. The WebView will draw under the system bars, which is the exact
  class of fault the iOS pass spent a day on (`ios.contentInset`, 62pt of dead
  space, a `fixed` overlay that could not reach the top). Whether
  `env(safe-area-inset-*)` resolves in Capacitor's Android WebView, and whether
  the header and tab bar land correctly, is **unknown**. It is the first thing
  to check on a device, and the geometry harness in `ios/UITests/Geometry.swift`
  is the shape of the check to copy.
- Whether it compiles at all. The manifest and resource XML are well-formed
  (parsed), which is not the same as linking.

**Needs credentials or assets:**

- **No `google-services.json`.** FCM cannot register without it, so push is
  dead on Android in the same way it is dead on iOS without the APNs key. Same
  three-step shape: create the Firebase app, download the file, add the server
  key.
- The launcher icon and splash image are Capacitor's defaults.

**Not looked at:**

- Deep links. Push taps route from the payload in JS (`initPushDeepLinks`), so
  they may work with no intent filter, but no `https` App Link filter exists
  and nothing has been tested.
- The Android hardware back button has a handler in `src/lib/native.ts` and has
  never been exercised.
- Nothing has run at Android viewport sizes. The Apple sweep covers 320-1366,
  which brackets most Android phones and tablets, but "brackets" is not
  "measured".
