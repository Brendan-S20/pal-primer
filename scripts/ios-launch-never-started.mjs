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
// Usage: node scripts/ios-launch-never-started.mjs <xcodebuild log> <process log>
// Prints why, and exits 0 when proven, 1 otherwise.

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [testLog, processLog] = process.argv.slice(2);
  const r = neverStarted(readFileSync(testLog, "utf8"), readFileSync(processLog, "utf8"));
  console.log(r.why);
  process.exit(r.proven ? 0 : 1);
}
