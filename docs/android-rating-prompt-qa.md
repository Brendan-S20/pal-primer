# Android: QA for the in-app rating prompt (FakeReviewManager)

Issue #521. The rating prompt itself is #508/#518; its rules are in
`src/lib/rating-prompt.ts`, the native wrapper in
`src/lib/rating-prompt-native.ts`.

## Why this exists

On Android the prompt calls Play's `ReviewManager` through
`@capacitor-community/in-app-review`. Play only shows its review sheet to an
app **installed from Play**, and applies its own quota on top. A debug build,
a sideloaded APK or an emulator gets nothing. The call succeeds and no sheet
appears. So on a QA phone, "the prompt fired" and "the prompt did not fire"
look exactly the same.

Play ships a stand-in for this: `FakeReviewManager`, which runs the same two
calls (`requestReviewFlow()`, then `launchReviewFlow()`) and never shows UI.
A debug build can now use it, with a toast at the moment the real sheet would
appear.

## What changes, and what does not

| Build                                              | What the prompt calls                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Release (Play, `bundleRelease`, `assembleRelease`) | The real `ReviewManager` via `@capacitor-community/in-app-review`. **Unchanged.**                |
| iOS, any build                                     | The real `SKStoreReviewController`. **Unchanged.**                                               |
| Debug, default (no flag)                           | The real plugin, same as release. **Unchanged.**                                                 |
| Debug with `-Phoundstack.fakeReview=on`            | `FakeReviewManager`, plus a toast "the Play review sheet would appear now (#n)".                 |
| Debug with `-Phoundstack.fakeReview=fail`          | A manager whose request always fails, plus a toast "request_failed (swallowed, app carries on)". |

The eligibility rules are the same in every row. The flag changes only what
happens once the rules have already said "ask".

How release is kept out of it, and what checks each part:

- The plugin (`FakeReviewPlugin`), the class that registers it
  (`FakeReviewInstaller`), `FailingReviewManager` and `ReviewFlow` live in
  `android/app/src/debug/` only. Release does not compile them.
- They are registered by a `<provider>` in `android/app/src/debug/AndroidManifest.xml`,
  which only the debug variant merges. `MainActivity` is untouched.
- `BuildConfig.FAKE_REVIEW_MANAGER` is the literal `"off"` for release,
  whatever the property says. In debug it defaults to `"off"`, and any value
  other than `off`, `on` or `fail` stops the build.
- The JS picks the fake only when `Capacitor.isPluginAvailable("HoundStackFakeReview")`
  is true on Android, which is only ever the case in a debug APK built with
  the flag. There is no web-bundle setting to forget to turn off.
- `tests/the-fake-review-manager-stays-out-of-release.test.ts` (vitest)
  checks all of the above from source. `.github/workflows/android-unit-tests.yml`
  builds a release APK and fails if any of those classes is in it.

## Running it on a phone or emulator

You need JDK 21 and the Android SDK (see the header of `android/build-debug.sh`).

```bash
npm run build:native
```

```bash
npx cap sync android
```

```bash
cd android && ./gradlew assembleDebug -Phoundstack.fakeReview=on
```

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`HOUNDSTACK_FAKE_REVIEW=on` in the environment does the same thing as the
`-P` flag. Use `=fail` to check the failure path. `android/build-debug.sh`
passes extra arguments to Gradle, so
`android/build-debug.sh assembleDebug -Phoundstack.fakeReview=on` works too.
Gradle bakes the flag in at build time, so switching modes means a rebuild.

### Getting the prompt to fire

The flag does not skip any rule. To see the toast, sign in as someone the
rules would ask:

- an **owner** or **office manager** in an org with **at least one paid invoice**, or
- a **technician** with **at least 10 completed visits**,
- **never a dispatcher**, never an `@demo.test` account,
- on the **second or later launch** (a cold start; coming back from the
  background does not count as a new session),
- on a **calm screen** (`/dashboard`, or the My Day list) with nothing open
  over it, settled for 2 seconds or brought back to the foreground,
- not prompted in the last **120 days**, and not already prompted on this app
  version.

The once-per-launch, 120-day and per-version memory is kept on the device
under `rating_prompt:<userId>`. To ask again, clear the app's storage
(`adb shell pm clear consulting.thenorth.houndstack`) and sign in again.
That counts as a first launch, so cold-start the app once more.

### What you should see

- `=on`: a toast reading _"FakeReviewManager: the Play review sheet would
  appear now (#1)"_ exactly once. It does not come back on later foregrounds
  or calm screens in the same launch, or on later launches within 120 days.
- `=fail`: a toast reading _"FakeReviewManager: request_failed (swallowed, app
  carries on)"_. The app keeps working, nothing is recorded as prompted, and
  the prompt is not retried until the next launch.
- Logcat has `[rating-prompt] skipped …` for any attempt that did not
  launch (`adb logcat | grep rating-prompt`).

From a WebView console (`chrome://inspect`) you can read the counters:

```js
await Capacitor.Plugins.HoundStackFakeReview.getStats();
// { requested, launched, failed, lastOutcome, mode }
```

### The "Rate HoundStack" link

Settings > Preferences > Rate HoundStack always opens
`https://play.google.com/store/apps/details?id=consulting.thenorth.houndstack`,
in every build, with or without the flag. On a device without Play it opens in
a browser. vitest checks that the URL's `id` matches `applicationId` in
`android/app/build.gradle`, and the instrumented test checks it against the
installed package.

## Tests

| What                                                                                                                                                                                  | Where                                                                    | Needs                    | In CI                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ | ----------------------------- |
| Rules (roles, counts, cap, calm screens)                                                                                                                                              | `tests/rating-prompt.test.ts`                                            | nothing                  | yes (vitest)                  |
| Release cannot contain the fake; the JS picks the fake only when it is registered, and only on Android; a failed fake request is swallowed; the Play URL matches `applicationId`      | `tests/the-fake-review-manager-stays-out-of-release.test.ts`             | nothing                  | yes (vitest)                  |
| Request then launch exactly once each with `FakeReviewManager`; a failed or throwing request is swallowed and never launches; a stale ReviewInfo fails without throwing; flag parsing | `android/app/src/testDebug/.../ReviewFlowTest.java`                      | JDK + SDK, **no device** | yes: `android-unit-tests.yml` |
| Release APK has none of the debug review classes                                                                                                                                      | `android-unit-tests.yml`, last step                                      | JDK + SDK                | yes                           |
| The same flow on a real runtime, main-thread listeners, installed package id                                                                                                          | `android/app/src/androidTest/.../FakeReviewManagerInstrumentedTest.java` | **a device or emulator** | no                            |

Run the JVM tests locally:

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

Run the instrumented test with a device or emulator attached:

```bash
cd android && ./gradlew :app:connectedDebugAndroidTest
```

Use the `:app:` prefix. Without it, Gradle also runs
`capacitor-cordova-android-plugins`' own androidTest build, which fails on a
duplicate-Kotlin-stdlib clash in that generated module. That failure has
nothing to do with this work.

## What this does not prove

- That Play shows the sheet. Nothing can, short of a build installed from a
  Play track (internal testing counts), and even then Play's quota may
  decide to show nothing. Neither store reports whether a sheet appeared.
- Anything about iOS. The iOS equivalent is the always-shown sheet in a
  development build from Xcode (see the header of `tests/rating-prompt.test.ts`).
