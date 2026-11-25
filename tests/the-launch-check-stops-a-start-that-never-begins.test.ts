// The launch check stops an xcodebuild that never starts a test (#1038).
//
// Run 45517831660 (head 27dcd899) was cancelled at the 2 h 30 min limit. On
// iPad Air 13-inch (M4), iOS 26.5, xcodebuild started the warm-up class at
// 20:40:38 and XCTest's first test case started at 21:32:48: 3130 s later,
// for a test body of 277 s. Nothing says why. Every healthy start in the same
// run took 15 to 126 s. scripts/ios-launch-smoke.sh now stops an xcodebuild
// that has started NO test case within START_BOUND seconds (600 by default),
// and treats it as a simulator failure under the same two-retry cap and
// reboot. Once any "Test Case ... started" line exists it never fires.
//
// The script is not run here (it needs simulators). Its run_class,
// attempt_class and simulator_failed are cut out of it and run in bash
// against a fake xcodebuild.
//
// Second: logStalled sorted its list of logged seconds, so one stray line
// from another day ("2026-11-25 00:36:15" between two 2026-11-24 19:46:45
// lines, in the run above) moved to the end and read as the log covering a
// truncated test, and the gap before it as silence.

import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logStalled } from "../scripts/ios-launch-never-started.mjs";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const script = read("scripts/ios-launch-smoke.sh");
const functions = script.slice(
  script.indexOf("# Why the simulator, not the app, failed this run of a class"),
  script.indexOf("while IFS=$'\\t' read -r runtime runtime_version type name"),
);

const FAKE = `#!/bin/bash
# fake xcodebuild: FAKE_MODE decides; FAKE_DIR/count counts invocations.
n=$(( $(cat "$FAKE_DIR/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_DIR/count"
echo "Command line invocation:"
echo "    xcodebuild test-without-building"
mode="$FAKE_MODE"
[ "$mode" != "hang-first" ] || { [ "$n" -eq 1 ] && mode=hang || mode=pass; }
trap 'exit 143' TERM
case "$mode" in
  hang) while :; do sleep 0.1; done ;;
  pass) echo "Test Case '-[HoundStackUITests.ColdLaunch testX]' started."; echo "Test Case '-[HoundStackUITests.ColdLaunch testX]' passed (1.0 seconds)."; exit 0 ;;
  slow-pass) echo "Test Case '-[HoundStackUITests.ColdLaunch testX]' started."; sleep 3; echo "passed"; exit 0 ;;
  slow-fail) echo "Test Case '-[HoundStackUITests.ColdLaunch testX]' started."; sleep 3; echo "error: the app hung"; exit 65 ;;
  late-start) sleep 0.3; echo "Test Case '-[HoundStackUITests.ColdLaunch testX]' started."; sleep 2.5; echo "error: the app hung"; exit 65 ;;
esac
`;

function run(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "hang-bound-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "xcodebuild"), FAKE);
  chmodSync(join(bin, "xcodebuild"), 0o755);
  writeFileSync(join(bin, "xcrun"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(bin, "xcrun"), 0o755);
  const harness = `
exec > "${dir}/out" 2>&1
set -euo pipefail
OUT="${dir}"; DD="${dir}/dd"; ROOT="${root}"; slug=fake; name=Fake; udid=U
RELEASE_SIGNED_IN=""; START_BOUND=1; START_POLL=0.1; retried=""
stop_app() { :; }
pgrep() { :; }
sample() { :; }
tail() { :; }
never_started() { echo "no proof"; return 1; }
sleep() { case "$1" in 10|20) command sleep 0.05 ;; *) command sleep "$1" ;; esac; }
${functions}
rc=0; attempt_class ColdLaunch launches || rc=$?
echo "RC=$rc"; echo "RETRIED=$retried"; printf 'NOTES<<\\n%s>>\\n' "$notes"
`;
  const t0 = Date.now();
  const r = spawnSync("bash", ["-c", harness], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_DIR: dir },
    encoding: "utf8",
    timeout: 60_000,
  });
  const count = Number(readFileSync(join(dir, "count"), "utf8"));
  return {
    out: readFileSync(join(dir, "out"), "utf8") + r.stderr,
    count,
    seconds: (Date.now() - t0) / 1000,
    dir,
  };
}

describe("an xcodebuild that starts no test case", () => {
  it("is stopped before the tests, named, rebooted and retried once, then passes", () => {
    const r = run("hang-first");
    expect(r.out).toMatch(/RC=0/);
    expect(r.count).toBe(2);
    expect(r.out).toMatch(/RETRIED= ColdLaunch/);
    expect(r.out).toMatch(
      /xcodebuild started no test case in 1 s .*; rebooted the simulator and retried \(1 of 2\)/,
    );
    expect(r.out).toMatch(/ColdLaunch: the simulator, not the app/);
    expect(r.seconds).toBeLessThan(20);
  });

  it("still FAILS when every attempt hangs, after exactly the original run and two retries", () => {
    const r = run("hang");
    expect(r.out).toMatch(/RC=1/);
    expect(r.count).toBe(3);
    expect(r.out).toMatch(/\(1 of 2\)/);
    expect(r.out).toMatch(/\(2 of 2\)/);
    expect(r.out).not.toMatch(/\(3 of 2\)/);
    expect(r.out).toMatch(/RETRIED= ColdLaunch ColdLaunch/);
  });

  it("is never stopped once a test case has started, however slow after that", () => {
    const pass = run("slow-pass");
    expect(pass.out).toMatch(/RC=0/);
    expect(pass.count).toBe(1);
    expect(pass.out).not.toMatch(/no test case/);
    // A failure after the start is the app's: no retry, and no claim.
    const fail = run("slow-fail");
    expect(fail.out).toMatch(/RC=1/);
    expect(fail.count).toBe(1);
    expect(fail.out).toMatch(/RETRIED=\n/);
    expect(fail.out).not.toMatch(/no test case/);
  });

  it("is not stopped when the first test case starts just inside the bound", () => {
    // Started at 0.3 s of a 1 s bound, then ran 2.5 s past it: the app's.
    const r = run("late-start");
    expect(r.out).toMatch(/RC=1/);
    expect(r.count).toBe(1);
    expect(r.out).not.toMatch(/no test case/);
  });

  it("leaves the retry cap, the reboot, the naming and the crash check as they were", () => {
    const attempt = script.slice(script.indexOf("attempt_class() {"), script.indexOf('notes=""'));
    expect(attempt).toMatch(/for tries in 1 2; do/);
    expect(attempt).toMatch(/simulator_failed "\$OUT\/\$slug-\$run\.log" "\$udid"/);
    expect(attempt).toMatch(/retried="\$retried \$1"/);
    expect(attempt).toMatch(/xcrun simctl shutdown/);
    expect(script).toMatch(
      /crashes=\$\(find "\$HOME\/Library\/Logs\/DiagnosticReports" -newer "\$marker"/,
    );
    expect(script).toMatch(/START_BOUND="\$\{SMOKE_START_BOUND_SECONDS:-600\}"/);
  });
});

describe("logStalled and a stray line in the list of logged seconds", () => {
  const name = "45342136372-iphone-17e-log-stalled";
  const log = read(`tests/fixtures/ios-launch-smoke/${name}.log.txt`);
  const seconds = read(`tests/fixtures/ios-launch-smoke/${name}.log-seconds.txt`);
  const stray = "2026-11-25 00:36:15";

  it("does not read a truncated log plus a stray later line as silence", () => {
    const lines = seconds.split("\n").filter((l) => l && l < "2026-11-24 02:50:00");
    const mid = lines.length - 3;
    const withStray = [...lines.slice(0, mid), stray, ...lines.slice(mid)].join("\n");
    const r = logStalled(log, withStray);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/does not cover every failed test/);
  });

  it("still proves the stall from the full log with the stray line in it", () => {
    const all = seconds.split("\n").filter(Boolean);
    const withStray = [...all.slice(0, 100), stray, ...all.slice(100)].join("\n");
    expect(logStalled(log, withStray).proven).toBe(true);
    expect(logStalled(log, withStray).why).toBe(logStalled(log, seconds).why);
  });

  it("drops two or more ADJACENT stray seconds too, on a truncated log", () => {
    const lines = seconds.split("\n").filter((l) => l && l < "2026-11-24 02:50:00");
    const mid = lines.length - 3;
    const strays = ["2026-11-25 00:36:15", "2026-11-25 00:36:16", "2026-11-25 00:36:17"];
    const withStrays = [...lines.slice(0, mid), ...strays, ...lines.slice(mid)].join("\n");
    const r = logStalled(log, withStrays);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/does not cover every failed test/);
  });
});

describe("the script around the bound", () => {
  it("keeps each comment with its function and names the bound from START_BOUND", () => {
    expect(script.indexOf("simulator_failed() {")).toBeLessThan(
      script.indexOf("# The cold link reached the app (#962)"),
    );
    expect(script.indexOf("# The cold link reached the app (#962)")).toBeLessThan(
      script.indexOf("cold_link_reached_the_app() {"),
    );
    expect(script).toMatch(/xcodebuild ran \$START_BOUND s without starting any test case/);
    expect(script).not.toMatch(/xcodebuild ran 600 s/);
  });
});
