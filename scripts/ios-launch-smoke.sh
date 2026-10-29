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
# This builds the app for the simulator, makes a fresh iPhone on the newest
# iOS runtime installed and a fresh iPad on the newest runtime that offers
# one (section 2 says why those can differ), and runs
# ios/UITests/.../ColdLaunch.swift on
# each: five cold launches to the sign-in form, then a link from cold and a
# link while running. A fresh simulator has no session, which is what makes
# this runnable here at all.
#
# ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
#
# It proves whatever the newest INSTALLED Xcode and runtimes are. If the
# newest runtime is older than iOS 27 the run fails and says so in the
# summary, because "launches on iOS 26" and "launches on iOS 27" must not
# read the same. The iPad can be one minor version behind the phones when
# the newest runtime ships without iPads; the summary names each device's
# runtime. It does not exercise a physical device, push tap routing (needs a
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

# ── 2. The runtimes, and the devices to try ────────────────────────────────
#
# Phones run on the NEWEST iOS runtime, which is the one #570 is about.
# Preferred, in order: a foldable (iPhone Duo, the device #570 was confirmed
# on), the iPhone 17e (the issue names it), then the newest iPhone that
# runtime offers.
#
# The iPad runs on the newest runtime that offers an iPad at all, which is
# not always the newest runtime: Apple's iOS 27.1 simulator runtime
# (24A94425) shipped with one device type, the iPhone Duo, while iOS 27.0
# offers 29 iPads. One iPad, because an iPad launch is a different window
# size from the first frame. No runtime with an iPad still fails the run.
#
# Every device type each runtime offers goes into device-types.txt, with
# counts in the summary, so "the runtime had none" and "the picker missed
# it" read differently. Types come from `simctl list devicetypes` (which
# carries productFamily) narrowed to the identifiers each runtime supports.
xcrun simctl list devicetypes -j > "$OUT/devicetypes.json"
picks=$(xcrun simctl list runtimes -j | python3 -I -c '
import json, sys
rts = [r for r in json.load(sys.stdin)["runtimes"]
       if r.get("platform") == "iOS" and r.get("isAvailable")]
if not rts:
    sys.exit("no available iOS simulator runtime")
rts.sort(key=lambda r: [int(x) for x in r["version"].split(".")], reverse=True)
with open(sys.argv[1]) as f:
    known = {t["identifier"]: t for t in json.load(f)["devicetypes"]}
def types_of(rt):
    return [dict(known.get(t["identifier"], {}), **t) for t in rt.get("supportedDeviceTypes", [])]
with open(sys.argv[2], "w") as f:
    for rt in rts:
        for t in types_of(rt):
            f.write(rt["version"] + "\t" + t.get("productFamily", "?") + "\t" + t["name"] + "\t" + t["identifier"] + "\n")
newest = rts[0]
phones = [t for t in types_of(newest) if t.get("productFamily") == "iPhone"]
chosen = []
def take(rt, t):
    if t and (rt, t["identifier"]) not in [(r, c["identifier"]) for r, c in chosen]:
        chosen.append((rt, t))
take(newest, next((t for t in phones if "Duo" in t["name"]), None))
take(newest, next((t for t in phones if t["name"] == "iPhone 17e"), None))
if not chosen and phones:
    take(newest, phones[-1])
for rt in rts:
    pads = [t for t in types_of(rt) if t.get("productFamily") == "iPad"]
    if pads:
        take(rt, next((t for t in pads if t["name"].startswith("iPad (")), pads[0]))
        break
print("NEWEST\t" + newest["identifier"] + "\t" + newest["version"])
for rt, t in chosen:
    print(rt["identifier"] + "\t" + rt["version"] + "\t" + t["identifier"] + "\t" + t["name"])
' "$OUT/devicetypes.json" "$OUT/device-types.txt")
RUNTIME=$(echo "$picks" | grep '^NEWEST' | cut -f2)
IOS_VERSION=$(echo "$picks" | grep '^NEWEST' | cut -f3)
DEVICE_LINES=$(echo "$picks" | grep -v '^NEWEST' || true)
say "- Newest iOS runtime: $IOS_VERSION ($RUNTIME)"
say "- Devices picked: $(echo "$DEVICE_LINES" | awk -F'\t' 'NF { printf "%s%s on iOS %s", sep, $4, $2; sep=", " }')"
# device-types.txt is written newest runtime first.
for v in $(awk -F'\t' '!seen[$1]++ { print $1 }' "$OUT/device-types.txt"); do
  say "- iOS $v offers $(awk -F'\t' -v v="$v" '$1==v && $2=="iPhone"' "$OUT/device-types.txt" | grep -c . || true) iPhone and $(awk -F'\t' -v v="$v" '$1==v && $2=="iPad"' "$OUT/device-types.txt" | grep -c . || true) iPad device types"
done

# #570's acceptance names an iPad. A run that cannot make one is not a pass.
if ! echo "$DEVICE_LINES" | cut -f4 | grep -q '^iPad'; then
  say ""
  say "> **No iOS runtime on this Mac offers an iPad.** Install one (Xcode > Settings > Components)."
  echo "::error::No installed iOS simulator runtime offers an iPad device type; #570 needs an iPad launch."
  NO_IPAD=1
fi

IOS_MAJOR="${IOS_VERSION%%.*}"
if [ "$IOS_MAJOR" -lt 27 ]; then
  say ""
  say "> **This run did not exercise iOS 27.** The newest runtime on this machine is iOS $IOS_VERSION. #570 crashed on iOS 27.1 only, so a pass here says nothing about it."
  echo "::error::iOS launch smoke ran on iOS $IOS_VERSION, not iOS 27. It does not prove #570 is fixed."
  OLD_RUNTIME=1
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
say "| Device | iOS | Result |"
say "|---|---|---|"
failed=0
marker="$OUT/.started"
touch "$marker"

# fd 3, not stdin: xcodebuild and simctl read stdin, and the first run lost
# every device after the first to them.
while IFS=$'\t' read -r runtime runtime_version type name <&3; do
  [ -n "$type" ] || continue
  slug=$(echo "$name" | tr -c 'A-Za-z0-9\n' '-')
  echo "--- $name (iOS $runtime_version)"
  udid=$(xcrun simctl create "HS launch smoke $name" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl install "$udid" "$APP"

  # Warm it up and sample late (docs/ios-build.md, "Automated device
  # tests"). The first launches after a boot were measured taking over a
  # minute to paint the same page later launches paint in five seconds, so
  # a fixed sleep is not enough: ColdLaunchWarmUp waits for the sign-in form
  # itself, up to 300s per launch. A page that never paints still fails.
  #
  # A launch that has not painted after 150s is not slow, it is stuck: on
  # 2026-10-28 one committed index.html and then its web content process
  # logged nothing for 300s, with the app, the scene and WebKit's network
  # process all healthy. Simulator processes are ordinary processes on this
  # Mac, so `sample` can say where that one's main thread is waiting.
  result="passed"
  xcodebuild test-without-building \
      -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
      -destination "id=$udid" -derivedDataPath "$DD/tests" \
      -resultBundlePath "$OUT/$slug-warmup.xcresult" \
      -only-testing:HoundStackUITests/ColdLaunchWarmUp \
      CODE_SIGNING_ALLOWED=NO > "$OUT/$slug-warmup.log" 2>&1 < /dev/null &
  warm_pid=$!
  (
    sleep 150
    kill -0 "$warm_pid" 2>/dev/null || exit 0
    for p in $(pgrep -f 'com.apple.WebKit.WebContent|HoundStack.app/HoundStack' || true); do
      ps -p "$p" -o command= 2>/dev/null | grep -q CoreSimulator || continue
      sample "$p" 3 -file "$OUT/$slug-stuck-$p.sample.txt" > /dev/null 2>&1 || true
    done
  ) &
  sampler_pid=$!
  if ! wait "$warm_pid"; then
    result="FAILED (warm-up: never reached sign-in)"
    tail -60 "$OUT/$slug-warmup.log"
    wait "$sampler_pid" 2>/dev/null || true
  elif ! xcodebuild test-without-building \
      -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
      -destination "id=$udid" -derivedDataPath "$DD/tests" \
      -resultBundlePath "$OUT/$slug.xcresult" \
      -only-testing:HoundStackUITests/ColdLaunch \
      CODE_SIGNING_ALLOWED=NO > "$OUT/$slug.log" 2>&1; then
    result="FAILED"
    tail -60 "$OUT/$slug.log"
  fi
  kill "$sampler_pid" 2>/dev/null || true

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
  say "| $name | $runtime_version | $result |"
done 3< <(echo "$DEVICE_LINES")

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

# Measured what it could, then fails: a gate for #570 that never ran iOS 27,
# or never ran an iPad, must not read green.
[ -z "${NO_IPAD:-}" ] || failed=1
[ -z "${OLD_RUNTIME:-}" ] || failed=1

[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
exit "$failed"
