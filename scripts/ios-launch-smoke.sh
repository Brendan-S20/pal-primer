#!/bin/bash
#
# Does the iOS app launch, on the newest Xcode and iOS this Mac has, and on
# the newest iOS 26.x runtime it has?
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
# one (section 2 says why those can differ), plus a fresh iPhone and iPad on
# the newest iOS 26.x runtime installed (#620), and runs
# ios/UITests/.../ColdLaunch.swift on each: five cold launches to the sign-in form, then a link from cold and a
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
# runtime. iOS 26.x is checked on its own because a pass on 27 says nothing
# about 26: #620 reported a black screen on iOS 26.5 while 27 launched. If no
# iOS 26.x runtime offering an iPhone and an iPad is installed, the run
# fails. It does not exercise a physical device, push tap routing (needs a
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
# Then the newest iOS 26.x runtime, phone and iPad both (#620: a black
# screen 3/3 on an iPhone 17e and an iPad Air on iOS 26.5). Preferred: the
# iPhone 17e and an iPad Air, the two devices #620 names, then the newest
# iPhone and the first iPad that runtime offers. Users stay on 26 after 27
# ships, and the App Store reviewer may too.
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
r26 = next((r for r in rts if r["version"].split(".")[0] == "26"), None)
if r26:
    phones26 = [t for t in types_of(r26) if t.get("productFamily") == "iPhone"]
    pads26 = [t for t in types_of(r26) if t.get("productFamily") == "iPad"]
    if phones26:
        take(r26, next((t for t in phones26 if t["name"] == "iPhone 17e"), phones26[-1]))
    if pads26:
        take(r26, next((t for t in pads26 if t["name"].startswith("iPad Air")), pads26[0]))
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

# #620's acceptance names iOS 26.x, phone and iPad. A run without both on a
# 26.x runtime is not a pass.
IOS26_LINES=$(echo "$DEVICE_LINES" | awk -F'\t' '$2 ~ /^26\./' || true)
if ! echo "$IOS26_LINES" | cut -f4 | grep -q '^iPhone' \
   || ! echo "$IOS26_LINES" | cut -f4 | grep -q '^iPad'; then
  say ""
  say "> **This run did not exercise iOS 26 on both an iPhone and an iPad.** Install an iOS 26.x simulator runtime (Xcode > Settings > Components)."
  echo "::error::No installed iOS 26.x simulator runtime gave both an iPhone and an iPad; #620 needs a launch on each."
  NO_IOS26=1
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

# Did a failed run die because the SIMULATOR never started the app?
#
# Measured on the CI Mac (fafea0e, c57e725): "Failed to launch
# consulting.thenorth.houndstack: Timed out attempting to launch app", on
# the iPhone Duo (27.1) and the iPad (27.0), with no HoundStack process in
# the system log anywhere between the launch request and the timeout, 33 to
# 85 s; the next process appeared only after the test had given up. Waiting
# for the old process to exit first did not prevent it. docs/ios-build.md
# records the same message with this app before scenes. No app code ran, so
# it says nothing about the app.
#
# The same fault can surface as a different message. Measured on the CI Mac
# (7badccf, iPad Air 13-inch (M4), iOS 26.5, fourth simulator of the run):
# the second warm-up launch was requested at 19:17:05; its process was
# sampled at 19:19:08 still inside dyld_sim, in __mmap of the shared cache,
# with a 336K footprint; XCUITest gave up at 19:19:43.6 with "Error getting
# main window kAXErrorServerNotFound"; the process logged its first line at
# 19:19:43.850, then made its web view and painted sign-in. The first
# warm-up launch on that simulator had painted in 7 s. No app code ran
# while the screen waited, so it says nothing about the app either.
#
# Exit 0 only when that is provably what happened: the log has one of those
# messages AND no HoundStack process started from the failed launch request
# to the test's tear-down. A process that started and then hung is the app, and is
# never retried.
never_started() {  # $1 xcodebuild log, $2 udid
  grep -qE "Timed out attempting to launch app|kAXErrorServerNotFound" "$1" || return 1
  xcrun simctl spawn "$2" log show --last 30m --style compact \
    --predicate 'process == "HoundStack"' > "$1.processes.txt" 2>/dev/null < /dev/null || return 1
  python3 -I - "$1" "$1.processes.txt" <<'PY'
import re, sys
from datetime import datetime, timedelta
lines = open(sys.argv[1], errors="replace").read().splitlines()
err = next(i for i, l in enumerate(lines)
           if "Timed out attempting to launch app" in l or "kAXErrorServerNotFound" in l)
start = launch = None
for l in reversed(lines[:err]):
    m = re.search(r"t =\s+([\d.]+)s\s+Launch consulting\.thenorth\.houndstack", l)
    if m and launch is None:
        launch = float(m.group(1))
    m = re.search(r"Start Test at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)", l)
    if m:
        start = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S.%f")
        break
end = next((float(m.group(1)) for l in lines[err:]
            for m in [re.search(r"t =\s+([\d.]+)s Tear Down", l)] if m), None)
if start is None or launch is None or end is None:
    sys.exit(1)
lo, hi = start + timedelta(seconds=launch - 1), start + timedelta(seconds=end)
first = {}
for l in open(sys.argv[2], errors="replace"):
    m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \S+ HoundStack\[(\d+)", l)
    if m:
        first.setdefault(m.group(2), datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S.%f"))
started = [p for p, t in first.items() if lo <= t <= hi]
print(f"launch requested {lo + timedelta(seconds=1):%H:%M:%S}, gave up {hi:%H:%M:%S}, HoundStack processes started in between: {len(started)}")
sys.exit(0 if not started else 1)
PY
}

# One test class on this device. A launch that has not painted after 150s
# is stuck, not slow (2026-10-28: the web content process waited forever on
# a synchronous prompt; bf2d1af removed that). Simulator processes are
# ordinary processes on this Mac, so `sample` keeps where each was waiting.
run_class() {  # $1 class, $2 result name
  xcodebuild test-without-building \
      -project "$ROOT/ios/UITests/UITests.xcodeproj" -scheme HoundStackUITests \
      -destination "id=$udid" -derivedDataPath "$DD/tests" \
      -resultBundlePath "$OUT/$slug-$2.xcresult" \
      -only-testing:"HoundStackUITests/$1" \
      CODE_SIGNING_ALLOWED=NO > "$OUT/$slug-$2.log" 2>&1 < /dev/null &
  local test_pid=$!
  (
    sleep 150
    kill -0 "$test_pid" 2>/dev/null || exit 0
    for p in $(pgrep -f 'com.apple.WebKit.WebContent|HoundStack.app/HoundStack' || true); do
      ps -p "$p" -o command= 2>/dev/null | grep -q CoreSimulator || continue
      sample "$p" 3 -file "$OUT/$slug-$2-stuck-$p.sample.txt" > /dev/null 2>&1 || true
    done
  ) &
  local sampler_pid=$!
  local status=0
  wait "$test_pid" || status=1
  kill "$sampler_pid" 2>/dev/null || true
  return "$status"
}

# Runs a class; retries it, at most twice, only when never_started proves
# the simulator, not the app, failed the launch. Each retry first reboots
# the simulator (docs/ios-build.md: "xcrun simctl shutdown <UDID> && xcrun
# simctl boot <UDID> clears it") and waits a little longer than the last.
# Each retry is named in the summary, and every attempt's log and result
# bundle are kept.
attempt_class() {  # $1 class, $2 result name
  local run="$2" why tries
  run_class "$1" "$run" && return 0
  tail -60 "$OUT/$slug-$run.log"
  for tries in 1 2; do
    why=$(never_started "$OUT/$slug-$run.log" "$udid") || return 1
    echo "::warning::$name: the simulator never started the app in $1 ($why). Rebooting it and retrying $1 ($tries of 2)."
    retried="$retried $1"
    say_later "  - $name, $1: the simulator never started the app ($why); rebooted the simulator and retried ($tries of 2)"
    xcrun simctl shutdown "$udid" > /dev/null 2>&1 || true
    sleep $((tries * 10))
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b > /dev/null
    run="$2-retry$tries"
    run_class "$1" "$run" && return 0
    tail -60 "$OUT/$slug-$run.log"
  done
  return 1
}

notes=""
say_later() { notes="$notes$1"$'\n'; }

# fd 3, not stdin: xcodebuild and simctl read stdin, and the first run lost
# every device after the first to them.
while IFS=$'\t' read -r runtime runtime_version type name <&3; do
  [ -n "$type" ] || continue
  # The runtime is in the name: the same device can run on 27 and on 26.
  slug=$(echo "$name-iOS-$runtime_version" | tr -c 'A-Za-z0-9\n' '-')
  echo "--- $name (iOS $runtime_version)"
  udid=$(xcrun simctl create "HS launch smoke $name iOS $runtime_version" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl install "$udid" "$APP"

  # Warm it up and sample late (docs/ios-build.md, "Automated device
  # tests"): ColdLaunchWarmUp waits for the sign-in form itself, up to 300s
  # per launch, before the timed ColdLaunch checks. A page that never
  # paints still fails.
  result="passed"
  retried=""
  if ! attempt_class ColdLaunchWarmUp warmup; then
    result="FAILED (warm-up: never reached sign-in)"
  elif ! attempt_class ColdLaunch launches; then
    result="FAILED"
  fi
  [ -z "$retried" ] || [ "$result" != "passed" ] || result="passed (retried after the simulator did not start the app:$retried)"

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

  case "$result" in passed*) ;; *) failed=1 ;; esac
  say "| $name | $runtime_version | $result |"
done 3< <(echo "$DEVICE_LINES")

if [ -n "$notes" ]; then
  say ""
  say "**Launches the simulator never started** (no HoundStack process from the launch request to the timeout, so no app code ran; the simulator was rebooted and the class retried, at most twice; a process that started and then hung is never retried):"
  printf '%s' "$notes" | while IFS= read -r line; do say "$line"; done
fi

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
# or never ran an iPad, or a gate for #620 that never ran iOS 26 on a phone
# and an iPad, must not read green.
[ -z "${NO_IPAD:-}" ] || failed=1
[ -z "${NO_IOS26:-}" ] || failed=1
[ -z "${OLD_RUNTIME:-}" ] || failed=1

[ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
exit "$failed"
