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
// A third fault, with its own proof (logStalled below): the simulator's
// logging daemon stopped taking log lines, and every process that tried to
// log waited on it. Measured on the CI Mac (main 08b2568e, iOS launch run
// 45342136372, iPhone 17e, iOS 27.2): launch 1 of 5 reached sign-in in 6 s;
// on launch 2 nothing in the simulator, not the app, not WebKit's GPU or
// network processes, logged a line from 02:49:51 to 02:55:41. The app was
// sampled at 02:50:19 with its main thread inside XCTest's own accessibility
// query, in os_signpost, in firehose_buffer_tracepoint_reserve_wait_for_
// chunks_from_logd: waiting for logd. No frame of the app's own code was
// on that stack. XCTest gave up at 02:55:42 with "Failed to get matching
// snapshots: Timed out while evaluating UI query". The scheduled run before
// it (45306699837) failed four tests on two iOS 27.2 simulators with "does
// not have a process ID" while each app process sat idle in its run loop,
// and every one of those tests had a silence of 64 to 94 s in the same log.
// Both iOS 26.5 simulators, in both runs, had no silence over 20 s.
//
// Usage: node scripts/ios-launch-never-started.mjs <xcodebuild log> <process log> [<log seconds>]
//
// <log seconds> is one line per second in which ANY process in the
// simulator logged, "YYYY-MM-DD HH:MM:SS" (the script cuts it from an
// unfiltered `log show --style compact`). Without it the third fault is
// never claimed.
//
// Prints why, and exits 0 when any of the faults is proven, 1 otherwise.

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

/** Seconds of silence from every process that count as a stalled logd. */
export const LOG_STALL_SECONDS = 60;

/** `log show --last 30m`: no two lines of one log are farther apart than this. */
const LOG_WINDOW_MS = 30 * 60 * 1000;

/**
 * Every failed test in the class failed while the simulator's logging was
 * stalled. Proven only when all of these hold:
 *
 *   1. the log names at least one failed test case, and each one has a
 *      start time and a tear-down;
 *   2. the seconds list has a line at or before the earliest start and at
 *      or after the latest tear-down, so an empty or truncated `log show`
 *      can never read as silence;
 *   3. inside EVERY failed test's window, from its start to its tear-down,
 *      there are LOG_STALL_SECONDS or more in a row in which no process in
 *      the simulator logged anything.
 *
 * Not one process, every process: an app that hangs stops its own lines,
 * not SpringBoard's, WebKit's or XCTest's. It says nothing about crashes;
 * the smoke script fails the run on any crash report whatever this says,
 * and a retry that fails again is still a failure.
 *
 * @param {string} testLog
 * @param {string} logSeconds
 * @returns {{ proven: boolean, why: string }}
 */
export function logStalled(testLog, logSeconds) {
  /** @type {{ name: string, start: number | null, end: number | null }[]} */
  const failed = [];
  /** @type {{ name: string, start: number | null, end: number | null } | null} */
  let cur = null;
  for (const l of testLog.split(/\r?\n/)) {
    const c = l.match(/^Test Case '-\[\S+ (\w+)\]' (started|passed|failed)/);
    if (c && c[2] === "started") {
      cur = { name: c[1], start: null, end: null };
      continue;
    }
    if (c && cur) {
      if (c[2] === "failed") failed.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const s = l.match(/Start Test at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/);
    if (s) cur.start = parseTime(s[1]);
    const t = l.match(/t =\s+([\d.]+)s Tear Down/);
    if (t && cur.start !== null) cur.end = cur.start + Number(t[1]) * 1000;
  }
  if (failed.length === 0) return { proven: false, why: "no failed test case in the log" };
  const unclear = failed.find((f) => f.start === null || f.end === null);
  if (unclear) {
    return { proven: false, why: `${unclear.name}: no start time or no tear-down in the log` };
  }

  const stamped = logSeconds
    .split(/\r?\n/)
    .map((l) => l.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/))
    .filter(Boolean)
    .map((m) => parseTime(`${m[1]}.000`));
  // A line from another time can sit in this list: run 45517831660, retry 1
  // of iPhone 17e 27.2, has "2026-11-25 00:36:15" between two 2026-11-24
  // 19:46:45 lines. Sorted, it lands at the end, where it reads as the log
  // covering a truncated test, and the gap before it as silence. `log show
  // --last 30m` cannot span more than LOG_WINDOW_MS, so a line farther than
  // that from every neighbour it has is not from this log and is dropped.
  const seconds = stamped
    .filter((t, i) => {
      const near = [stamped[i - 1], stamped[i + 1]].filter((n) => n !== undefined);
      return near.length === 0 || near.some((n) => Math.abs(t - n) <= LOG_WINDOW_MS);
    })
    .sort((a, b) => a - b);
  const lo = Math.min(...failed.map((f) => f.start));
  const hi = Math.max(...failed.map((f) => f.end));
  // A logged second covers [t, t + 1 s).
  if (seconds.length === 0 || seconds[0] > lo || seconds[seconds.length - 1] + 1000 < hi) {
    return {
      proven: false,
      why: "the simulator's log does not cover every failed test, so silence cannot be read from it",
    };
  }

  const found = [];
  for (const f of failed) {
    const points = [f.start, ...seconds.filter((t) => t > f.start && t < f.end), f.end];
    let best = { from: f.start, to: f.start };
    for (let i = 1; i < points.length; i++) {
      // From the end of the last logged second to the next one.
      const from = i === 1 ? points[0] : points[i - 1] + 1000;
      if (points[i] - from > best.to - best.from) best = { from, to: points[i] };
    }
    const gap = Math.round((best.to - best.from) / 1000);
    if (gap < LOG_STALL_SECONDS) {
      return {
        proven: false,
        why: `${f.name}: the longest silence from every process was ${gap} s, under ${LOG_STALL_SECONDS} s`,
      };
    }
    found.push(
      `${f.name}: nothing in the simulator logged from ${clock(best.from)} to ${clock(best.to)} (${gap} s)`,
    );
  }
  return {
    proven: true,
    why: `the simulator's log stalled during every failed test; ${found.join("; ")}`,
  };
}

/**
 * Any of the faults, proven. The smoke script retries a class only when this
 * says so.
 *
 * @param {string} testLog
 * @param {string} processLog
 * @param {string} [logSeconds]
 * @returns {{ proven: boolean, why: string }}
 */
export function simulatorFailedTheLaunch(testLog, processLog, logSeconds = "") {
  const a = neverStarted(testLog, processLog);
  if (a.proven) return a;
  const b = pageNeverCommitted(testLog, processLog);
  if (b.proven) return b;
  const c = logStalled(testLog, logSeconds);
  if (c.proven) return c;
  return { proven: false, why: `${a.why}; ${b.why}; ${c.why}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [testLog, processLog, logSeconds] = process.argv.slice(2);
  const r = simulatorFailedTheLaunch(
    readFileSync(testLog, "utf8"),
    readFileSync(processLog, "utf8"),
    logSeconds ? readFileSync(logSeconds, "utf8") : "",
  );
  console.log(r.why);
  process.exit(r.proven ? 0 : 1);
}
