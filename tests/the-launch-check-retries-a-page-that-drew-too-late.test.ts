// Run 46089204153 attempt 2 on #1071 (e5633f2f, version numbers only),
// iPhone 17e, iOS 27.2, ColdLaunch launch 2 of 5: "no email field, so the
// sign-in form never rendered". The app served its page, WebKit committed it
// 30.4 s later, and it first drew 0.5 s after XCTest gave up. The older rule
// stops at "committed before the give-up", so the class was never retried.
//
// The fixture is that test's part of the xcodebuild log, and pid 6397's lines
// the rule reads (XCTest query result addresses removed).

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  neverStarted,
  pageDrewAfterXCTestStoppedLooking,
  pageNeverCommitted,
  simulatorFailedTheLaunch,
} from "../scripts/ios-launch-never-started.mjs";

const root = join(import.meta.dirname, "..");
const base = "tests/fixtures/ios-launch-smoke/46089204153-iphone-17e-committed-too-late";
const log = readFileSync(join(root, `${base}.log.txt`), "utf8");
const processes = readFileSync(join(root, `${base}.processes.txt`), "utf8");

const lines = processes.trimEnd().split("\n");
const without = (pattern: RegExp) => lines.filter((l) => !pattern.test(l)).join("\n");
// Move the one line matching `pattern` to another time of day, keeping order.
const moved = (pattern: RegExp, time: string) => {
  expect(lines.filter((l) => pattern.test(l))).toHaveLength(1);
  return lines
    .map((l) => (pattern.test(l) ? l.replace(/\d\d:\d\d:\d\d\.\d{3}/, time) : l))
    .sort((a, b) => a.slice(0, 23).localeCompare(b.slice(0, 23)))
    .join("\n");
};
const COMMIT = /FrameLoader::transitionToCommitted/;
const DREW = /first visually non-empty layout milestone on the main frame/;
const refused = (testLog: string, processLog: string, why: RegExp) => {
  const r = pageDrewAfterXCTestStoppedLooking(testLog, processLog);
  expect(r.proven).toBe(false);
  expect(r.why).toMatch(why);
  expect(simulatorFailedTheLaunch(testLog, processLog).proven).toBe(false);
};

describe("a page WebKit committed too late for XCTest to see drawn", () => {
  it("is proven on run 46089204153's lines, which the older rules refuse", () => {
    expect(neverStarted(log, processes).proven).toBe(false);
    expect(pageNeverCommitted(log, processes).proven).toBe(false);
    expect(simulatorFailedTheLaunch(log, processes)).toEqual({
      proven: true,
      why: "HoundStack[6397] served its page at 21:38:54.878; WebKit committed it 30.4 s later, with the app still answering XCTest; it first drew at 21:39:42.292, after XCTest's last look at 21:39:37.838",
    });
  });

  it("makes the command the smoke script runs exit 0", () => {
    const out = execFileSync(
      "node",
      ["scripts/ios-launch-never-started.mjs", `${base}.log.txt`, `${base}.processes.txt`],
      { cwd: root, encoding: "utf8" },
    );
    expect(out).toMatch(/committed it 30\.4 s later/);
  });
});

describe("a real non-render, crash or hang still fails", () => {
  it("fails a page that committed and drew nothing", () => {
    refused(log, without(DREW), /committed and drew nothing/);
  });

  it("fails a page that drew while XCTest was still looking (no email field on it)", () => {
    refused(log, moved(DREW, "21:39:30.000"), /while XCTest was still looking/);
  });

  it("fails a page that only drew long after the give-up", () => {
    refused(log, moved(DREW, "21:39:55.000"), /after XCTest gave up/);
  });

  it("fails an app that stopped answering before the commit", () => {
    const hung = without(/ 21:39:(0\d|1\d)\.\d+ .*Replying to query/);
    refused(log, hung, /did not answer XCTest for/);
    refused(log, without(/Replying to query/), /did not answer XCTest for 30\.4 s/);
  });

  it("fails a page committed promptly", () => {
    refused(log, moved(COMMIT, "21:39:00.000"), /not late/);
  });

  it("fails a page that had 20 s or more after its commit", () => {
    refused(log, moved(COMMIT, "21:39:21.000"), /had 20\.8 s after its commit/);
  });

  it("fails a terminated web content process", () => {
    const crashed = `${processes.trimEnd()}\n2026-11-27 21:39:30.000 Df HoundStack[6397:1] WebPageProxy::processDidTerminate: reason=Crash\n`;
    refused(log, crashed, /terminated web content process/);
  });

  it("fails when a second app process started", () => {
    const two = `${processes.trimEnd()}\n2026-11-27 21:38:40.000 Df HoundStack[7000:0] started\n`;
    refused(log, two, /processes started in the window: 2/);
  });

  it("fails when anything else in the class failed too", () => {
    const [error] = log.split("\n").filter((l) => /: error: -\[/.test(l));
    const other = error.replace(/XCTAssertTrue failed.*$/, "XCTAssertTrue failed - something else");
    refused(`${log}\n${other}\n`, processes, /not exactly one failure/);
  });

  it("fails any other assertion on the same timeline", () => {
    const other = log.replace(
      "no email field, so the sign-in form never rendered",
      "a text field but no Continue button, so this is not /auth",
    );
    refused(other, processes, /not exactly one failure/);
  });
});
