# Tap to Pay is kept out of Release until Apple approves distribution

Refs #579 (Tap to Pay on the phone) and #757 (the change that shipped it).

## What happened

#757 added `com.apple.developer.proximity-reader.payment.acceptance` to
`ios/App/App/App.entitlements`, which both build configurations signed with.
Apple granted the Tap to Pay on iPhone entitlement for **development only**
(case 23404969). Distribution is a separate, later approval, so no
distribution provisioning profile can include it.

Once #847 let the Xcode Cloud archive compile, "HoundStack | Archive to
TestFlight | Archive - iOS" failed at the step after it, on main `97693805`,
`8ddfcc2c` and `41b87d70`:

    Exporting for App Store Distribution failed.
    Exporting for Ad Hoc Distribution failed.

The archive built and both distribution exports failed. The other keys in the
file (push, associated domains, Sign in with Apple) are standard capabilities
that a distribution profile carries. #757 is the only commit to touch the file
since then, and the Tap to Pay key is the only one Apple limited to
development. The export log itself (an App Store Connect artifact) was not
readable from the repo, so this cause is inferred from that evidence, not read
from the log.

## How it is set up now

| Configuration                                                  | Signs with                     | `HS_TAP_TO_PAY_ENTITLED` | Tap to Pay |
| -------------------------------------------------------------- | ------------------------------ | ------------------------ | ---------- |
| Debug (development builds, a phone run from Xcode)             | `App/App.entitlements`         | `YES`                    | on         |
| Release (every archive, so Xcode Cloud, TestFlight, App Store) | `App/App.Release.entitlements` | `NO`                     | hidden     |

`App.Release.entitlements` is `App.entitlements` without the Tap to Pay key.
`Info.plist` carries the build setting as `HSTapToPayEntitled`;
`HSBridgeViewController.swift` reads it and sets
`window.__HS_TAP_TO_PAY_ENTITLED__` before any page script runs;
`tapToPayEntitled()` (`src/lib/tap-to-pay-entitlement.ts`) reads that, and
`TapToPayButton` draws nothing on an iPhone where it is not `true`. A Release
build therefore never shows a button whose first SDK call would fail. Android
is unaffected.

New Tap to Pay surfaces (the announcement, the Settings card and the launch
warm-up from #841) should check `tapToPayEntitled(Capacitor.getPlatform())`
the same way.

`tests/release-entitlements-carry-only-what-apple-approved.test.ts` is the CI
guard. It checks that:

- Release's entitlements hold only keys on `APPROVED_FOR_DISTRIBUTION`;
- Release matches Debug, value for value, apart from the `DEVELOPMENT_ONLY`
  keys;
- `HS_TAP_TO_PAY_ENTITLED` agrees with the file each configuration signs with;
- the flag reaches the page and the button reads it.

A new capability therefore has to be added to `APPROVED_FOR_DISTRIBUTION` on
purpose before Release may ask for it.

## Turning it back on in Release, once Apple approves distribution

1. Confirm in the Apple Developer portal that the app ID's Tap to Pay on
   iPhone capability is approved for **distribution**, not only development.
2. Add the key to `ios/App/App/App.Release.entitlements`:

       <key>com.apple.developer.proximity-reader.payment.acceptance</key>
       <true/>

   (or point Release's `CODE_SIGN_ENTITLEMENTS` back at `App/App.entitlements`
   and delete the Release file).

3. In `ios/App/App.xcodeproj/project.pbxproj`, set Release's
   `HS_TAP_TO_PAY_ENTITLED = YES;`.
4. In the guard test, move the key from `DEVELOPMENT_ONLY` to
   `APPROVED_FOR_DISTRIBUTION`.
5. Run an Xcode Cloud archive and check that both exports succeed before
   relying on it. Xcode Cloud's automatic signing regenerates the
   distribution profile; a profile cached elsewhere may need regenerating.

Steps 2 to 4 belong in one commit. The guard fails if any one of them is
missing.
