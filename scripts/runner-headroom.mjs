// What the machine had left, on whichever machine this is.
//
// ── WHY THIS STOPPED BEING FOUR LINES OF BASH ─────────────────────────────
//
// The step this replaces was `shell: bash`, above a comment asserting that
// Git Bash is on the PATH "because actions/checkout needs it". That was a
// reasonable belief and it is false. Measured on DESKTOP-JUC6SL1 on
// 2026-09-18:
//
//     ##[error]bash: command not found
//
// Git IS installed there -- the runner logs reference
// `C:\Program Files\Git\usr\bin\tar.exe` -- but `bash` is not on the PATH the
// runner invokes steps with. So the step would have failed outright on
// Windows, and because it carries `continue-on-error` and exits zero, it
// would have failed GREEN: the check whose entire purpose is to put a number
// in the log, silently putting nothing there.
//
// That is why this is worth a file. The job is about to become able to run on
// either machine, and a diagnostic that only works on one of them is worse
// than none, because its silence is indistinguishable from good news.
//
// ── WHAT IT REPORTS, AND WHY SWAP SPECIFICALLY ────────────────────────────
//
// Node exposes total and free memory and the load average, but NOT swap, and
// swap is the number that matters here. On 2026-09-15 this runner was at 94%
// swap with a load average of 59-73 on 8 cores, and that one condition
// produced eight failures in a day that all looked like code: five viewport
// specs timing out and three builds dying with `Bus error: 10`. Vite and
// esbuild read through mmap, and when the kernel cannot back a mapped page --
// which is what an exhausted swap file means -- the access raises SIGBUS
// rather than ENOMEM. "Built in 9.24s" followed by "Bus error: 10" is that.
//
// So swap is read per platform: `sysctl vm.swapusage` on darwin,
// /proc/meminfo on linux, and on win32 the pagefile via `wmic`, falling back
// to saying it could not be read. An unread number and a healthy one must not
// look alike, which is the same rule this repo applies to its test tallies.
//
// It never fails the build. The condition is not caused by the diff, so
// blocking the diff on it would add a failure mode to a machine that already
// manufactures them. What is worth having is the number IN THE LOG, so the
// next unexplained timeout is an explained one.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";

const GiB = 1024 ** 3;
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

function quiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** @returns {{usedMB:number,totalMB:number}|null} */
function swap() {
  if (platform() === "darwin") {
    // vm.swapusage: total = 13312.00M  used = 12476.50M  free = 835.50M
    const out = quiet("sysctl", ["-n", "vm.swapusage"]);
    const total = out && /total\s*=\s*([\d.]+)M/.exec(out);
    const used = out && /used\s*=\s*([\d.]+)M/.exec(out);
    return total && used ? { usedMB: +used[1], totalMB: +total[1] } : null;
  }
  if (platform() === "linux") {
    try {
      const mi = readFileSync("/proc/meminfo", "utf8");
      const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mi)?.[1] ?? 0);
      const totalMB = kb("SwapTotal") / 1024;
      return totalMB > 0 ? { usedMB: totalMB - kb("SwapFree") / 1024, totalMB } : null;
    } catch {
      return null;
    }
  }
  if (platform() === "win32") {
    // The pagefile is Windows' swap. `wmic` is deprecated but present on the
    // runner; if it is ever removed this returns null and says so, which is
    // the correct behaviour rather than a guess.
    const out = quiet("wmic", ["pagefile", "get", "AllocatedBaseSize,CurrentUsage", "/format:csv"]);
    const row = out?.split(/\r?\n/).find((l) => /,\d+,\d+\s*$/.test(l));
    const m = row && /,(\d+),(\d+)\s*$/.exec(row);
    return m ? { usedMB: +m[2], totalMB: +m[1] } : null;
  }
  return null;
}

const cores = cpus().length || "?";
// loadavg() is [0,0,0] on Windows -- the OS has no such metric. Report it as
// unavailable rather than as zero, which would read as an idle machine.
const load = platform() === "win32" ? "n/a" : loadavg()[0].toFixed(2);
const ramUsedGiB = ((totalmem() - freemem()) / GiB).toFixed(1);
const ramTotalGiB = (totalmem() / GiB).toFixed(1);

const s = swap();
const swapText = s
  ? `swap ${pct(s.usedMB, s.totalMB)}% used (${Math.round(s.usedMB)}M of ${Math.round(s.totalMB)}M)`
  : "swap could not be read on this platform";

console.log(`${swapText}, RAM ${ramUsedGiB} of ${ramTotalGiB} GiB, load ${load} on ${cores} cores`);

if (s && pct(s.usedMB, s.totalMB) >= 50) {
  console.log(
    `::warning title=Runner headroom::Swap is ${pct(s.usedMB, s.totalMB)}% full ` +
      `(${Math.round(s.usedMB)}M of ${Math.round(s.totalMB)}M), load ${load} on ${cores} cores. ` +
      `A SIGBUS, a timeout or a stability failure in this run is more likely to be the machine than the diff.`,
  );
} else if (!s) {
  console.log(
    "::notice title=Runner headroom::Swap was not readable here, so this run has no swap figure. " +
      "That is not the same as healthy.",
  );
}
