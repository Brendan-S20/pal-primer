// The launch check blames the simulator only with proof (#726).
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// "The app launches on the newest Xcode" reported `iPad (A16) | 27.2 |
// FAILED` on main 054a4a28 while build 465 was in App Review, and the obvious
// reading was that #570's launch trap was back. It was not. In that run the
// same iPad passed five cold launches to sign-in and a link while running,
// with no crash report. The one failure was XCTest's own
// `XCUIDevice.system.open(url)`: "Timed out while opening the default app
// for a URL". The simulator took 64 s to spawn the app from the link; the app
// then connected its scene with the URL (UIOpenURLAction, in the
// `workspace:didCreateScene` call where Apple's trap fires), finished loading
// the page, and stayed up until the next test ended it. XCTest gave up 51 s
// after that.
//
// The other recent red runs on main and PRs are the same machine, not the
// app, each with zero crash reports:
//   - ee6f6cac, iPad (A16) 27.2: "does not have a process ID" on launch 5 of
//     5, with no HoundStack process from the request to the timeout. The
//     retry only knew two of XCTest's messages for that fault, so it never
//     retried.
//   - 8804c3eb and 1d1bb9b4: "Failed to terminate
//     consulting.thenorth.houndstack:<pid>", in the first test of ColdLaunch,
//     on the process the warm-up class's xcodebuild session had left
//     running.
//
// ── WHAT IS PINNED ────────────────────────────────────────────────────────
//
//   - the retry classifier, run on fixtures cut from those CI logs
//   - each class starts with the app stopped by simctl, not by a new XCTest
//     session killing the last one's process
//   - the cold-link test tolerates exactly that one XCTest timeout, and still
//     has to see the app in the foreground on the sign-in form
//   - the summary says when that happened, so a pass does not hide it

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOG_STALL_SECONDS,
  logStalled,
  neverStarted,
  pageNeverCommitted,
  simulatorFailedTheLaunch,
  SIMULATOR_NEVER_STARTED,
} from "../scripts/ios-launch-never-started.mjs";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const fixture = (name: string) => ({
  log: read(`tests/fixtures/ios-launch-smoke/${name}.log.txt`),
  processes: read(`tests/fixtures/ios-launch-smoke/${name}.processes.txt`),
});
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("a launch the simulator never started", () => {
  it("is still recognised from XCTest's timeout (8804c3eb, iPhone 17e, 27.2)", () => {
    const { log, processes } = fixture("8804c3eb-iphone-17e-timed-out");
    const r = neverStarted(log, processes);
    expect(r.proven).toBe(true);
    expect(r.why).toMatch(/HoundStack processes started in between: 0$/);
  });

  it("is recognised from 'does not have a process ID' (ee6f6cac, iPad (A16), 27.2)", () => {
    const { log, processes } = fixture("ee6f6cac-ipad-a16-no-process-id");
    expect(log).toMatch(/does not have a process ID/);
    const r = neverStarted(log, processes);
    expect(r.proven).toBe(true);
    expect(r.why).toMatch(/HoundStack processes started in between: 0$/);
  });

  it("is not claimed once a process started, whatever the message", () => {
    // The same log, with launch 5's process put back in the window: the app
    // ran, so whatever happened next is the app's and is never retried.
    const { log, processes } = fixture("ee6f6cac-ipad-a16-no-process-id");
    const withProcess = `${processes}2026-11-09 02:32:25.000 Df HoundStack[29300:0] started\n`;
    const r = neverStarted(log, withProcess);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/started in between: 1$/);
  });

  it("is not claimed for the cold-link timeout, where the app did start (054a4a28)", () => {
    const { log, processes } = fixture("054a4a28-ipad-a16-cold-link");
    expect(log).toMatch(/Timed out while opening the default app for a URL/);
    // The process started 64 s after the link and took it in scene-create.
    expect(processes).toMatch(/HoundStack\[35685:[0-9a-f]+\].*scene-create: UIOpenURLAction/);
    expect(processes).toMatch(/HoundStack\[35685:[0-9a-f]+\].*after the page load/);
    expect(neverStarted(log, processes).proven).toBe(false);
    // So the classifier does not list it; the test handles it (below).
    expect(SIMULATOR_NEVER_STARTED.some((m) => log.includes(m))).toBe(false);
  });

  it("is what the smoke script asks before every retry", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    const check = script.slice(
      script.indexOf("never_started() {"),
      script.indexOf("run_class() {"),
    );
    expect(check).toMatch(
      /node "\$ROOT\/scripts\/ios-launch-never-started\.mjs" "\$1" "\$1\.processes\.txt"/,
    );
    // One list of messages, in the module, not a second copy in a grep.
    expect(check).not.toMatch(/Timed out attempting to launch app/);
  });
});

// main 7d6274f7 (#854), iOS launch run 42940607915: iPhone 17e, iOS 26.5,
// testALinkWhileRunningKeepsTheAppUp, "before the link: no email field, so
// the sign-in form never rendered". The same app code had passed all four
// simulators on #854's own pull request run (42931415913, 4935fda, identical
// ios/, src/ and scripts/), and five cold launches on the same simulator
// reached sign-in right after it. The process log shows why: dyld took 23 s,
// WebKit's processes 24 s more, the app served its page in 1 ms, and the
// main frame committed 0.3 s after XCTest gave up. The fixture is the CI
// log, filtered to those lines and otherwise unchanged.
describe("a page the app served and WebKit had not committed", () => {
  const { log, processes } = fixture("7d6274f7-iphone-17e-page-never-committed");

  it("is recognised, and says when each thing happened", () => {
    const r = pageNeverCommitted(log, processes);
    expect(r.proven).toBe(true);
    expect(r.why).toBe(
      "HoundStack[91976] served its page at 21:16:51.730; WebKit had not committed it when XCTest gave up at 21:17:28.569 (committed 21:17:28.872), so no page script ran",
    );
    // And it is what the script's single entry point answers.
    expect(simulatorFailedTheLaunch(log, processes)).toEqual(r);
    // The older proof does not claim it: a process did start.
    expect(neverStarted(log, processes).proven).toBe(false);
  });

  it("is not claimed once the page committed before XCTest gave up", () => {
    // The page reached the web view and still drew no sign-in form: the app.
    const early = processes.replace(
      "2026-11-10 21:17:28.872 Df HoundStack[91976",
      "2026-11-10 21:17:20.000 Df HoundStack[91976",
    );
    expect(early).not.toBe(processes);
    const r = pageNeverCommitted(log, early);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/committed at 21:17:20\.000, before the give-up/);
    expect(simulatorFailedTheLaunch(log, early).proven).toBe(false);
  });

  it("is not claimed when the app never served its page", () => {
    const unserved = processes
      .split("\n")
      .filter(
        (l) =>
          !(l.includes("HoundStack[91976") && l.includes("WebURLSchemeTaskProxy::didComplete")),
      )
      .join("\n");
    expect(unserved).not.toBe(processes);
    const r = pageNeverCommitted(log, unserved);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/never served its page/);
  });

  it("is not claimed for a second process in the window", () => {
    const two = `${processes}2026-11-10 21:17:00.000 Df HoundStack[99999:0] started\n`;
    expect(pageNeverCommitted(log, two).proven).toBe(false);
  });

  it("is not claimed for any other failure", () => {
    const other = log.replace(
      "no email field, so the sign-in form never rendered",
      "a text field but no Continue button, so this is not /auth",
    );
    expect(other).not.toBe(log);
    expect(simulatorFailedTheLaunch(other, processes).proven).toBe(false);
  });

  it("names the assertion ColdLaunch.swift actually fails with", () => {
    const swift = read("ios/UITests/HoundStackUITests/ColdLaunch.swift");
    expect(swift).toContain('"\\(when): no email field, so the sign-in form never rendered"');
  });
});

// main 08b2568e, iOS launch run 45342136372: iPhone 17e, iOS 27.2,
// testColdLaunchReachesSignInFiveTimes, "Failed to get matching snapshots:
// Timed out while evaluating UI query" on launch 2 of 5, after launch 1
// reached sign-in in 6 s. The watchdog's sample of the app, 28 s into the
// silence, had its main thread inside XCTest's accessibility query waiting on
// logd (firehose_buffer_tracepoint_reserve_wait_for_chunks_from_logd), with
// none of the app's own frames on it. The log and process fixtures are the
// CI files filtered to the failing test and to each process's first line.
// The seconds fixture is cut from the job's oslog.txt, which holds HoundStack
// and WebKit's processes only; the script cuts it from every process, which
// can only make a silence shorter, never longer.
describe("a launch that failed while the simulator's logd had stalled", () => {
  const name = "45342136372-iphone-17e-log-stalled";
  const { log, processes } = fixture(name);
  const seconds = read(`tests/fixtures/ios-launch-smoke/${name}.log-seconds.txt`);

  it("is recognised, and names the silence", () => {
    const r = logStalled(log, seconds);
    expect(r.proven).toBe(true);
    expect(r.why).toBe(
      "the simulator's log stalled during every failed test; testColdLaunchReachesSignInFiveTimes: nothing in the simulator logged from 02:50:52 to 02:55:41 (289 s)",
    );
    expect(simulatorFailedTheLaunch(log, processes, seconds)).toEqual(r);
    // Neither older proof claims it: the app started, and the failure is
    // XCTest's query, not the sign-in assertion.
    expect(neverStarted(log, processes).proven).toBe(false);
    expect(pageNeverCommitted(log, processes).proven).toBe(false);
  });

  it("is not claimed when every second of the test has a line from some process", () => {
    const busy: string[] = [];
    for (let t = Date.UTC(2026, 10, 24, 2, 46); t < Date.UTC(2026, 10, 24, 2, 57); t += 1000) {
      busy.push(new Date(t).toISOString().replace("T", " ").slice(0, 19));
    }
    const r = logStalled(log, busy.join("\n"));
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/longest silence from every process was 0 s/);
    expect(simulatorFailedTheLaunch(log, processes, busy.join("\n")).proven).toBe(false);
  });

  it("is not claimed for a silence under the threshold", () => {
    // Fill the stall with a line every LOG_STALL_SECONDS - 1 seconds.
    const extra: string[] = [];
    for (let s = 0; s < 6 * 60; s += LOG_STALL_SECONDS - 1) {
      const t = Date.UTC(2026, 10, 24, 2, 49, 51) + s * 1000;
      extra.push(new Date(t).toISOString().replace("T", " ").slice(0, 19));
    }
    expect(logStalled(log, `${seconds}\n${extra.join("\n")}`).proven).toBe(false);
  });

  it("reads nothing into a log that is empty or does not reach the tear-down", () => {
    expect(logStalled(log, "").proven).toBe(false);
    expect(simulatorFailedTheLaunch(log, processes).proven).toBe(false);
    const truncated = seconds
      .split("\n")
      .filter((l) => l < "2026-11-24 02:50:00")
      .join("\n");
    const r = logStalled(log, truncated);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/does not cover every failed test/);
  });

  it("needs a silence in EVERY failed test of the class", () => {
    // A second failed test, after the log recovered and kept logging: a
    // failure there is not the stall's, so the class is not retried on it.
    const second = [
      "Test Case '-[HoundStackUITests.ColdLaunch testALinkWhileRunningKeepsTheAppUp]' started.",
      "    t =     0.00s Start Test at 2026-11-24 02:55:50.000",
      "/x/ColdLaunch.swift:152: error: -[HoundStackUITests.ColdLaunch testALinkWhileRunningKeepsTheAppUp] : before the link: no email field, so the sign-in form never rendered",
      "    t =    65.00s Tear Down",
      "Test Case '-[HoundStackUITests.ColdLaunch testALinkWhileRunningKeepsTheAppUp]' failed (65.100 seconds).",
    ].join("\n");
    const busyAfter: string[] = [];
    for (let s = 0; s < 120; s++) {
      const t = Date.UTC(2026, 10, 24, 2, 55, 45) + s * 1000;
      busyAfter.push(new Date(t).toISOString().replace("T", " ").slice(0, 19));
    }
    const r = logStalled(`${log}\n${second}`, `${seconds}\n${busyAfter.join("\n")}`);
    expect(r.proven).toBe(false);
    expect(r.why).toMatch(/^testALinkWhileRunningKeepsTheAppUp: the longest silence/);
  });

  it("is given an unfiltered log by the smoke script", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    const check = script.slice(script.indexOf("never_started() {"), script.indexOf("stop_app() {"));
    // Every process: no --predicate on the second log show.
    expect(check).toMatch(
      /xcrun simctl spawn "\$2" log show --last 30m --style compact 2>\/dev\/null < \/dev\/null/,
    );
    expect(check).toMatch(/> "\$1\.log-seconds\.txt"/);
    expect(check).toMatch(
      /ios-launch-never-started\.mjs" "\$1" "\$1\.processes\.txt" "\$1\.log-seconds\.txt"/,
    );
    // And a crash still fails the run, retried or not.
    expect(script).toMatch(
      /crashes=\$\(find "\$HOME\/Library\/Logs\/DiagnosticReports" -newer "\$marker"/,
    );
  });
});

describe("the stuck-launch watchdog is quiet unless it fires", () => {
  it("is reaped with its job notice discarded", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    const runClass = script.slice(
      script.indexOf("run_class() {"),
      script.indexOf("attempt_class() {"),
    );
    expect(runClass).toMatch(
      /\{ kill "\$sampler_pid" && wait "\$sampler_pid"; \} 2>\/dev\/null \|\| true/,
    );
  });
});

describe("each test class starts with the app stopped", () => {
  it("stops the app with simctl before xcodebuild starts a new session", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    const runClass = script.slice(
      script.indexOf("run_class() {"),
      script.indexOf("attempt_class() {"),
    );
    const stop = runClass.indexOf('stop_app "$udid"');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(runClass.indexOf("xcodebuild test-without-building"));
    const stopApp = script.slice(script.indexOf("stop_app() {"));
    expect(stopApp).toMatch(/xcrun simctl terminate "\$1" consulting\.thenorth\.houndstack/);
    // And waits until launchd agrees it is gone, rather than a fixed sleep.
    expect(stopApp).toMatch(/launchctl list/);
  });
});

describe("the cold-link test judges the app, not XCTest's open call", () => {
  const swift = codeOnly(read("ios/UITests/HoundStackUITests/ColdLaunch.swift"));
  const openLink = swift.slice(
    swift.indexOf("private func openLink()"),
    swift.indexOf("private func assertOnSignIn"),
  );

  it("expects only the one timeout, and only around the open call", () => {
    expect(openLink).toMatch(/XCTExpectFailure\(/);
    expect(openLink).toMatch(/isStrict = false/);
    expect(openLink).toMatch(
      /issueMatcher = \{ \$0\.compactDescription\.contains\("Timed out while opening the default app for a URL"\) \}/,
    );
    // The block form, so nothing after the open call is covered by it.
    expect(openLink).toMatch(
      /XCTExpectFailure\("[^"]*", options: options\) \{\s*XCUIDevice\.shared\.system\.open\(link\)\s*\}/,
    );
    // continueAfterFailure is restored once the open call returns.
    expect(openLink).toMatch(
      /continueAfterFailure = true[\s\S]*system\.open\(link\)[\s\S]*continueAfterFailure = carryOn/,
    );
  });

  it("still needs the app in the foreground on sign-in after a cold link", () => {
    const test = swift.slice(
      swift.indexOf("func testALinkThatLaunchesTheAppLandsOnSignIn()"),
      swift.indexOf("func testALinkWhileRunningKeepsTheAppUp()"),
    );
    expect(test.indexOf("openLink()")).toBeLessThan(test.indexOf("wait(for: .runningForeground"));
    expect(test).toMatch(/assertOnSignIn\(app, "after a cold link"\)/);
  });

  // #962: on iPad (A16), iOS 27.2, the link brought the app up and active in
  // 4 s and XCTest's foreground wait never saw it, because nothing had
  // attached XCTest to a process SpringBoard started. activate() attaches;
  // the script then proves the link, not activate(), started the app.
  it("attaches XCTest to the process the link started before judging it", () => {
    const test = swift.slice(
      swift.indexOf("func testALinkThatLaunchesTheAppLandsOnSignIn()"),
      swift.indexOf("func testALinkWhileRunningKeepsTheAppUp()"),
    );
    const open = test.indexOf("openLink()");
    const attach = test.indexOf("app.activate()");
    expect(attach).toBeGreaterThan(open);
    expect(attach).toBeLessThan(test.indexOf("wait(for: .runningForeground"));
    // Not launch(): that terminates first, which would end the very process
    // the link started and turn this into a plain cold launch.
    expect(test).not.toMatch(/\.launch\(\)/);
  });

  it("fails the device when the cold link never reached the app", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    const fn = script.slice(script.indexOf("cold_link_reached_the_app() {"));
    expect(fn).toMatch(/eventMessage CONTAINS "scene-create: UIOpenURLAction"/);
    // Captured, not `| grep -q`, which pipefail can fail with SIGPIPE.
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/\|\s*grep -q/);
    expect(script).toMatch(
      /elif ! attempt_class ColdLaunch launches; then\s*result="FAILED"\s*elif ! cold_link_reached_the_app "\$udid"; then\s*result="FAILED \(the cold link never reached the app/,
    );
  });

  it("is named in the summary when it happened", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    expect(script).toMatch(
      /grep -qs "Timed out while opening the default app for a URL" "\$OUT\/\$slug"-launches\*\.log/,
    );
    expect(script).toMatch(/XCTest's link open timed out; the app still reached sign-in/);
  });
});
