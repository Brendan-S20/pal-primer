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
import { neverStarted, SIMULATOR_NEVER_STARTED } from "../scripts/ios-launch-never-started.mjs";

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

  it("is named in the summary when it happened", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    expect(script).toMatch(
      /grep -qs "Timed out while opening the default app for a URL" "\$OUT\/\$slug"-launches\*\.log/,
    );
    expect(script).toMatch(/XCTest's link open timed out; the app still reached sign-in/);
  });
});
