#!/bin/bash
#
# Does the iOS app launch, on the newest Xcode and iOS this Mac has?
#
# ── WHY ───────────────────────────────────────────────────────────────────
#
# Issue #570: built with Xcode 27.1, the app crashed on every launch on iOS
# 27.1 (SIGTRAP in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption)
# because it had not adopted the scene lifecycle. Every check we had was green,
# because nothing launched the binary. Xcode Cloud archives it and stops; the
# XCUITest target needs a signed-in simulator and so never ran unattended.
#
# This builds the app for the simulator, makes a fresh iPhone and iPad on the
# newest iOS runtime installed, and runs ios/UITests/.../ColdLaunch.swift on
# each: five cold launches to the sign-in form, then a link from cold and a
# link while running. A fresh simulator has no session, which is what makes
# this runnable here at all.
#
# ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
#
# It proves whatever the newest INSTALLED Xcode and runtime are. If that is
# older than iOS 27 the run still passes and says so in the summary, loudly,
# because "launches on iOS 26" and "launches on iOS 27" must not read the
# same. It does not exercise a physical device, push tap routing (needs a
# session), or the folded and unfolded postures of a foldable, which simctl
# cannot set.
#
#   scripts/ios-launch-smoke.sh            # from the repo root, after
#                                          # build:native and cap sync ios
#
# Environment:
#   SMOKE_OUT       where results go (default: ios-launch-smoke/ in the repo)
#   SMOKE_XCODE     an Xcode.app to use instead of the newest one found
#   SMOKE_KEEP_SIMS keep the simulators afterwards (default: delete them)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SMOKE_OUT:-$ROOT/ios-launch-smoke}"
DD="$OUT/DerivedData"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.md"
: > "$SUMMARY"

say() { echo "$*" | tee -a "$SUMMARY"; }

if [ ! -f "$ROOT/ios/App/App/public/index.html" ]; then
  echo "::error::ios/App/App/public/index.html is missing. Run npm run build:native and npx cap sync ios first."
  exit 1
fi

# ── 1. The newest Xcode on this machine ────────────────────────────────────
#
# By version number rather than by name: hosted runners carry Xcode_26.1.app,
# Xcode_27.0_beta.app and an Xcode.app symlink side by side. DEVELOPER_DIR
# rather than `xcode-select -s`, so a self-hosted Mac with no passwordless
# sudo can run this too and nothing outlives the run.
if [ -n "${SMOKE_XCODE:-}" ]; then
  XCODE="$SMOKE_XCODE"
else
  XCODE=$(python3 -I -c '
import glob, plistlib
best = None
for app in glob.glob("/Applications/Xcode*.app"):
    try:
        with open(app + "/Contents/Info.plist", "rb") as f:
            v = plistlib.load(f)["CFBundleShortVersionString"]
        key = [int(x) for x in v.split(".")]
    except Exception:
        continue
    if best is None or key > best[0]:
        best = (key, app)
print(best[1] if best else "")
')
fi
if [ -z "$XCODE" ]; then
  echo "::error::no Xcode found under /Applications"
  exit 1
fi
export DEVELOPER_DIR="$XCODE/Contents/Developer"

say "## iOS launch smoke"
say ""
say "- Xcode: \`$(xcodebuild -version | tr '\n' ' ')\` ($XCODE)"

# ── 2. The newest iOS runtime, and the devices to try ──────────────────────
#
# Preferred iPhones, in order: a foldable (iPhone Duo, the device #570 was
# confirmed on), the iPhone 17e (the issue names it), then the newest iPhone
# the runtime offers. One iPad, because an iPad launch is a different
# window size from the first frame.
picks=$(xcrun simctl list runtimes -j | python3 -I -c '
import json, sys
rts = [r for r in json.load(sys.stdin)["runtimes"]
       if r.get("platform") == "iOS" and r.get("isAvailable")]
if not rts:
    sys.exit("no available iOS simulator runtime")
key = lambda r: [int(x) for x in r["version"].split(".")]
rt = max(rts, key=key)
types = rt.get("supportedDeviceTypes", [])
phones = [t for t in types if t.get("productFamily") == "iPhone"]
pads = [t for t in types if t.get("productFamily") == "iPad"]
chosen = []
def take(t):
    if t and t not in chosen:
        chosen.append(t)
take(next((t for t in phones if "Duo" in t["name"]), None))
take(next((t for t in phones if t["name"] == "iPhone 17e"), None))
if not chosen and phones:
    take(phones[-1])
take(next((t for t in pads if t["name"].startswith("iPad (")), pads[0] if pads else None))
print(rt["identifier"] + "\t" + rt["version"])
for t in chosen:
    print(t["identifier"] + "\t" + t["name"])
')
RUNTIME=$(echo "$picks" | head -1 | cut -f1)
DEVICES=$(echo "$picks" | tail -n +2 | cut -f2 | paste -sd, - | sed 's/,/, /g')
IOS_VERSION=$(echo "$picks" | head -1 | cut -f2)
say "- iOS runtime: $IOS_VERSION ($RUNTIME)"
say "- Devices picked: ${DEVICES:-none}"

IOS_MAJOR="${IOS_VERSION%%.*}"
if [ "$IOS_MAJOR" -lt 27 ]; then
  say ""
  say "> **This run did not exercise iOS 27.** The newest runtime on this machine is iOS $IOS_VERSION. #570 crashed on iOS 27.1 only, so a pass here says nothing about it."
  echo "::warning::iOS launch smoke ran on iOS $IOS_VERSION, not iOS 27. It does not prove #570 is fixed."
fi

# ── 3. Build once ──────────────────────────────────────────────────────────
#
# Debug, so Capacitor writes the web page's console to the system log
# (loggingBehavior "debug"): the first run on iOS 27.1 had three launches
# reach a window and an EMPTY web view, and a Release build says nothing
# about why. The scene adoption this guards is the same in both
# configurations. Built for the generic simulator so one build installs on
# every device below.
echo "--- building the app"
xcodebuild -project "$ROOT/ios/App/App.xcodeproj" -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DD/app" CODE_SIGNING_ALLOWED=NO build \
  > "$OUT/build-app.log" 2>&1 || { tail -80 "$OUT/build-app.log"; echo "::error::app build failed"; exit 1; }
APP=$(find "$DD/app/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name '*.app' | head -1)
[ -n "$APP" ] || { echo "::error::no .app in the build products"; exit 1; }

echo "--- building the UI tests"
xcodebuild build-for-testing -project "$ROOT/ios/UITests/UITests.xcodeproj" \
  -scheme HoundStackUITests -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DD/tests" CODE_SIGNING_ALLOWED=NO \
  > "$OUT/build-tests.log" 2>&1 || { tail -80 "$OUT/build-tests.log"; echo "::error::UI test build failed"; exit 1; }

# ── 4. Each device ─────────────────────────────────────────────────────────
say ""
say "| Device | Result |"
say "|---|---|"
failed=0
marker="$OUT/.started"
touch "$marker"

# fd 3, not stdin: xcodebuild and simctl read stdin, and the first run lost
# every device after the first to them.
while IFS=$'\t' read -r type name <&3; do
  [ -n "$type" ] || continue
  slug=$(echo "$name" | tr -c 'A-Za-z0-9\n' '-')
  echo "--- $name"
  udid=$(xcrun simctl create "HS launch smoke $name" "$type" "$RUNTIME")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl install "$udid" "$APP"

  # Warm it up and sample late (docs/ios-build.md, "Automated device
  # tests"). The first launches after a boot were measured taking over a
  # minute to paint the same page later launches paint in five seconds, so
  # a fixed sleep is not enough: ColdLaunchWarmUp waits for the sign-in form
  # itself, up to 300s per launch. A page that never paints still fails.
  result="passed"
  if ! xcodebuild test-without-building \
      -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
      -destination "id=$udid" -derivedDataPath "$DD/tests" \
      -resultBundlePath "$OUT/$slug-warmup.xcresult" \
      -only-testing:HoundStackUITests/ColdLaunchWarmUp \
      CODE_SIGNING_ALLOWED=NO > "$OUT/$slug-warmup.log" 2>&1; then
    result="FAILED (warm-up: never reached sign-in)"
    tail -60 "$OUT/$slug-warmup.log"
  elif ! xcodebuild test-without-building \
      -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
      -destination "id=$udid" -derivedDataPath "$DD/tests" \
      -resultBundlePath "$OUT/$slug.xcresult" \
      -only-testing:HoundStackUITests/ColdLaunch \
      CODE_SIGNING_ALLOWED=NO > "$OUT/$slug.log" 2>&1; then
    result="FAILED"
    tail -60 "$OUT/$slug.log"
  fi

  xcrun simctl io "$udid" screenshot "$OUT/$slug.png" > /dev/null 2>&1 || true
  # What the app, its web view and WebKit's processes said, for a launch
  # that reached a window and painted nothing.
  xcrun simctl spawn "$udid" log show --last 30m --style compact --info --debug \
    --predicate 'process == "HoundStack" OR process BEGINSWITH "com.apple.WebKit"' \
    > "$OUT/$slug.oslog.txt" 2>&1 < /dev/null || true
  if [ -z "${SMOKE_KEEP_SIMS:-}" ]; then
    xcrun simctl shutdown "$udid" > /dev/null 2>&1 || true
    xcrun simctl delete "$udid" > /dev/null 2>&1 || true
  fi

  [ "$result" = "passed" ] || failed=1
  say "| $name | $result |"
done 3< <(echo "$picks" | tail -n +2)

# ── 5. Any crash, even one a test recovered from ───────────────────────────
#
# Simulator crash reports land on the host. A launch that crashes and is
# relaunched by the next attempt must not pass quietly.
crashes=$(find "$HOME/Library/Logs/DiagnosticReports" -newer "$marker" \
  \( -name 'HoundStack*' -o -name 'com.apple.WebKit*' \) 2>/dev/null || true)
if [ -n "$crashes" ]; then
  failed=1
  mkdir -p "$OUT/crashes"
  echo "$crashes" | while read -r f; do cp "$f" "$OUT/crashes/"; done
  say ""
  say "**Crash reports from this run:**"
  echo "$crashes" | while read -r f; do say "- $(basename "$f")"; done
fi

[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
exit "$failed"
