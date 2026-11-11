#!/bin/bash
#
# What Xcode actually signs each configuration with, measured on a Mac
# (#854, #855; #757 / #579).
#
# ── WHY ───────────────────────────────────────────────────────────────────
#
# Xcode Cloud's "Archive - iOS" failed at "Exporting for App Store / Ad Hoc
# Distribution" once #847 let it compile. The Tap to Pay on iPhone entitlement
# (com.apple.developer.proximity-reader.payment.acceptance) is granted for
# development only, so a distribution profile cannot carry it. Release now signs
# with App/App.Release.entitlements, which leaves it out.
#
# tests/release-entitlements-carry-only-what-apple-approved.test.ts checks the
# FILES. This checks what Xcode RESOLVES from them: it builds each
# configuration, reads the entitlements Xcode processed for the product, and
# fails unless Release has no proximity-reader key and Debug still has it, and
# unless Info.plist's HSTapToPayEntitled says the same. It then archives
# Release for a device, as Xcode Cloud does, with signing off.
#
# ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
#
# It does not export. An App Store or Ad Hoc export needs the team's
# distribution certificate and a distribution profile, which live with Xcode
# Cloud and not on this Mac. Only an Xcode Cloud run (or a person's Xcode
# signed in to the team) can show "Exporting for App Store Distribution"
# succeeding. The simulator builds are signed "to run locally" (-), which
# makes Xcode process the entitlements file without a profile.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${CHECK_OUT:-$ROOT/ios-release-entitlements}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.md"
: > "$SUMMARY"
say() { echo "$*"; echo "$*" >> "$SUMMARY"; }

KEY="com.apple.developer.proximity-reader.payment.acceptance"
PROJECT="$ROOT/ios/App/App.xcodeproj"

say "## Entitlements Xcode resolves, per configuration"
say ""
say "- Xcode: \`$(xcodebuild -version | tr '\n' ' ')\`"
say "- Commit: \`$(git -C "$ROOT" rev-parse HEAD)\`"
say ""

fail=0
for CONFIG in Debug Release; do
  DD="$OUT/DerivedData-$CONFIG"
  LOG="$OUT/build-$CONFIG.log"
  echo "--- building $CONFIG for the simulator (log: $LOG)"
  if ! xcodebuild -project "$PROJECT" -scheme App -configuration "$CONFIG" \
      -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$DD" \
      CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
      build > "$LOG" 2>&1 < /dev/null; then
    tail -40 "$LOG"
    say "- **$CONFIG: the build failed.** See build-$CONFIG.log."
    fail=1
    continue
  fi

  APP="$(find "$DD/Build/Products" -maxdepth 2 -name 'HoundStack.app' -type d | head -1)"
  XCENT="$(find "$DD/Build/Intermediates.noindex" -name 'HoundStack.app*.xcent' -type f | sort)"
  if [ -z "$APP" ] || [ -z "$XCENT" ]; then
    say "- **$CONFIG: no app or no processed entitlements found**, so nothing was measured."
    fail=1
    continue
  fi

  ENT="$OUT/entitlements-$CONFIG.txt"
  {
    for f in $XCENT; do echo "== $(basename "$f")"; plutil -p "$f"; done
    echo "== codesign -d --entitlements"
    codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - 2>/dev/null || true
  } > "$ENT"
  cat "$ENT"

  FLAG="$(/usr/libexec/PlistBuddy -c 'Print :HSTapToPayEntitled' "$APP/Info.plist" 2>/dev/null || echo missing)"
  SIGNED_WITH="$(xcodebuild -project "$PROJECT" -target App -configuration "$CONFIG" -showBuildSettings 2>/dev/null \
    | awk -F' = ' '/ CODE_SIGN_ENTITLEMENTS = /{print $2; exit}')"

  if grep -q "$KEY" "$ENT"; then HAS=yes; else HAS=no; fi
  if [ "$CONFIG" = Debug ]; then WANT_KEY=yes; WANT_FLAG=YES; else WANT_KEY=no; WANT_FLAG=NO; fi

  status="ok"
  [ "$HAS" = "$WANT_KEY" ] || status="WRONG"
  [ "$FLAG" = "$WANT_FLAG" ] || status="WRONG"
  [ "$status" = ok ] || fail=1
  say "- $CONFIG: signs with \`$SIGNED_WITH\`; proximity-reader key: **$HAS** (want $WANT_KEY); Info.plist HSTapToPayEntitled: **$FLAG** (want $WANT_FLAG). $status"
done

echo "--- archiving Release for a device, signing off (log: $OUT/archive-Release.log)"
if xcodebuild archive -project "$PROJECT" -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$OUT/HoundStack.xcarchive" \
    -derivedDataPath "$OUT/DerivedData-archive" CODE_SIGNING_ALLOWED=NO \
    > "$OUT/archive-Release.log" 2>&1 < /dev/null; then
  say "- Release device archive (unsigned): **succeeded**."
else
  tail -40 "$OUT/archive-Release.log"
  say "- **Release device archive (unsigned): failed.** See archive-Release.log."
  fail=1
fi

say ""
say "Export was not attempted: it needs the team's distribution signing, which only Xcode Cloud has."

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$fail"
