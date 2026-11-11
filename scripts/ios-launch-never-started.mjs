// Did a failed launch fail because the SIMULATOR never started the app?
//
// scripts/ios-launch-smoke.sh retries a test class only when this says yes.
// It says yes only when both of these hold:
//
//   1. xcodebuild's log has one of the messages XCTest gives when the
//      simulator did not hand it a process, and
//   2. no HoundStack process started from that launch request to the test's
//      tear-down, per the simulator's own system log.
//
// A process that started and then hung or crashed is the app, and is never
// retried. A crash report fails the run separately in the script.
//
// The messages, each measured on the CI Mac:
//   - "Timed out attempting to launch app": fafea0e, c57e725, f1327ac8
//     (iPhone Duo 27.1, iPad 27.0, iPhone 17e 27.2).
//   - "kAXErrorServerNotFound": 7badccf (iPad Air 13-inch (M4), 26.5). The
//     process sat in dyld_sim until XCUITest gave up.
//   - "does not have a process ID": ee6f6cac (iPad (A16), 27.2, #726). Launch
//     5 of 5 was requested at 02:32:23; the last HoundStack process had
//     started at 02:32:12, for launch 4; XCUITest gave up at 02:34:16. Four
//     launches before it on the same simulator reached sign-in.
//
// A second fault, with its own proof (pageNeverCommitted below): the
// simulator started the app, the app served its page, and WebKit had not
// committed that page by the time XCTest gave up. Measured on the CI Mac
// (7d6274f7, iPhone 17e, iOS 26.5): dyld took 23 s to start HoundStack,
// WebKit's processes took 24 s more to launch, the app's scheme handler
// served the main document in 1 ms (21:16:51.730), and the main frame
// committed at 21:17:28.872, 0.3 s after the 60 s wait for the sign-in field
// ran out. On the same simulator, before and after, a commit took 1.5 s and
// five cold launches reached sign-in in about 6 s each. Before a commit no
// page script runs, so the web app had no chance to draw anything.
//
// Usage: node scripts/ios-launch-never-started.mjs <xcodebuild log> <process log>
// Prints why, and exits 0 when either fault is proven, 1 otherwise.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIMULATOR_NEVER_STARTED = [
  "Timed out attempting to launch app",
  "kAXErrorServerNotFound",
  "does not have a process ID",
];

const parseTime = (s) => {
  // "2026-11-09 02:31:39.946", local time on both sides, so read both the
  // same way and compare.
  const [d, t] = s.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, sec] = t.split(":");
  const [whole, frac = "0"] = sec.split(".");
  return new Date(
    y,
    mo - 1,
    da,
    Number(h),
    Number(mi),
    Number(whole),
    Number(frac.slice(0, 3).padEnd(3, "0")),
  ).getTime();
};

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const clockMs = (ms) => `${clock(ms)}.${String(new Date(ms).getMilliseconds()).padStart(3, "0")}`;

/**
 * @param {string} testLog   xcodebuild's output for one test class
 * @param {string} processLog `log show --style compact --predicate 'process == "HoundStack"'`
 * @returns {{ proven: boolean, why: string }}
 */
export function neverStarted(testLog, processLog) {
  const lines = testLog.split(/\r?\n/);
  const err = lines.findIndex((l) => SIMULATOR_NEVER_STARTED.some((m) => l.includes(m)));
  if (err < 0) return { proven: false, why: "no simulator-launch message in the log" };

  let launch = null;
  let start = null;
  for (let i = err - 1; i >= 0; i--) {
    const l = lines[i];
    const m = l.match(/t =\s+([\d.]+)s\s+Launch consulting\.thenorth\.houndstack/);
    if (m && launch === null) launch = Number(m[1]);
    const s = l.match(/Start Test at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/);
    if (s) {
      start = parseTime(s[1]);
      break;
    }
  }
  let end = null;
  for (const l of lines.slice(err)) {
    const m = l.match(/t =\s+([\d.]+)s Tear Down/);
    if (m) {
      end = Number(m[1]);
      break;
    }
  }
  if (start === null || launch === null || end === null) {
    return {
      proven: false,
      why: "could not find the launch request, the test start or the tear-down",
    };
  }

  const lo = start + (launch - 1) * 1000;
  const hi = start + end * 1000;
  const first = new Map();
  for (const l of processLog.split(/\r?\n/)) {
    const m = l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \S+ HoundStack\[(\d+)/);
    if (m && !first.has(m[2])) first.set(m[2], parseTime(m[1]));
  }
  const started = [...first.values()].filter((t) => t >= lo && t <= hi).length;
  return {
    proven: started === 0,
    why: `launch requested ${clock(lo + 1000)}, gave up ${clock(hi)}, HoundStack processes started in between: ${started}`,
  };
}

/** The assertion ColdLaunch.swift's assertOnSignIn fails with. */
export const SIGN_IN_NEVER_RENDERED = "so the sign-in form never rendered";

/**
 * The app started and served its page, and WebKit had not committed the
 * main frame when XCTest gave up waiting for sign-in. Proven only when all
 * of these hold, between the launch request and the moment XCTest gave up:
 *
 *   1. the failure is assertOnSignIn's "never rendered", and nothing else;
 *   2. exactly one HoundStack process started (the launch that was asked
 *      for);
 *   3. that process started loading the main document and its scheme
 *      handler completed a task after that, so the app served the page;
 *   4. no main-frame commit (FrameLoader::transitionToCommitted
 *      isMainFrame=1) from that process.
 *
 * A page that committed and then drew nothing, or a scheme handler that
 * never answered, is the app's, and is never claimed here.
 *
 * @param {string} testLog
 * @param {string} processLog
 * @returns {{ proven: boolean, why: string }}
 */
export function pageNeverCommitted(testLog, processLog) {
  const lines = testLog.split(/\r?\n/);
  const err = lines.findIndex((l) => l.includes("error:") && l.includes(SIGN_IN_NEVER_RENDERED));
  if (err < 0) return { proven: false, why: "no sign-in-never-rendered failure in the log" };

  let gaveUp = null;
  let launch = null;
  let start = null;
  for (let i = err - 1; i >= 0; i--) {
    const l = lines[i];
    const t = l.match(/t =\s+([\d.]+)s\s/);
    if (t && gaveUp === null) gaveUp = Number(t[1]);
    const m = l.match(/t =\s+([\d.]+)s\s+Launch consulting\.thenorth\.houndstack/);
    if (m && launch === null) launch = Number(m[1]);
    const s = l.match(/Start Test at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/);
    if (s) {
      start = parseTime(s[1]);
      break;
    }
  }
  if (start === null || launch === null || gaveUp === null) {
    return {
      proven: false,
      why: "could not find the launch request, the test start or when it gave up",
    };
  }

  const lo = start + (launch - 1) * 1000;
  const hi = start + gaveUp * 1000;
  /** @type {Map<string, { at: number, text: string }[]>} */
  const byPid = new Map();
  for (const l of processLog.split(/\r?\n/)) {
    const m = l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \S+\s+HoundStack\[(\d+)/);
    if (!m) continue;
    if (!byPid.has(m[2])) byPid.set(m[2], []);
    byPid.get(m[2]).push({ at: parseTime(m[1]), text: l });
  }
  const started = [...byPid].filter(([, ls]) => ls[0].at >= lo && ls[0].at <= hi);
  if (started.length !== 1) {
    return {
      proven: false,
      why: `HoundStack processes started between the launch request and the give-up: ${started.length}, not 1`,
    };
  }
  const [pid, own] = started[0];
  const inWindow = own.filter((x) => x.at <= hi);
  const mainLoad = inWindow.find((x) =>
    /isMainFrame=1\] DocumentLoader::startLoadingMainResource/.test(x.text),
  );
  const served =
    mainLoad &&
    inWindow.find((x) => x.at >= mainLoad.at && /WebURLSchemeTaskProxy::didComplete/.test(x.text));
  const isCommit = (x) => /isMainFrame=1\] FrameLoader::transitionToCommitted/.test(x.text);
  const committed = inWindow.find(isCommit);
  if (!mainLoad || !served) {
    return { proven: false, why: `HoundStack[${pid}] never served its page before ${clockMs(hi)}` };
  }
  if (committed) {
    return {
      proven: false,
      why: `HoundStack[${pid}]'s page committed at ${clockMs(committed.at)}, before the give-up at ${clockMs(hi)}`,
    };
  }
  const late = own.find((x) => x.at > hi && isCommit(x));
  return {
    proven: true,
    why: `HoundStack[${pid}] served its page at ${clockMs(served.at)}; WebKit had not committed it when XCTest gave up at ${clockMs(hi)}${late ? ` (committed ${clockMs(late.at)})` : ""}, so no page script ran`,
  };
}

/**
 * Either fault, proven. The smoke script retries a class only when this
 * says so.
 *
 * @param {string} testLog
 * @param {string} processLog
 * @returns {{ proven: boolean, why: string }}
 */
export function simulatorFailedTheLaunch(testLog, processLog) {
  const a = neverStarted(testLog, processLog);
  if (a.proven) return a;
  const b = pageNeverCommitted(testLog, processLog);
  if (b.proven) return b;
  return { proven: false, why: `${a.why}; ${b.why}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [testLog, processLog] = process.argv.slice(2);
  const r = simulatorFailedTheLaunch(
    readFileSync(testLog, "utf8"),
    readFileSync(processLog, "utf8"),
  );
  console.log(r.why);
  process.exit(r.proven ? 0 : 1);
}
