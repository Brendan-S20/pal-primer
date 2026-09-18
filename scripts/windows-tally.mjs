// Read a vitest log and say, in one line, how far the suite got.
//
// ── WHY THIS IS A SCRIPT AND NOT FOUR LINES OF SHELL ──────────────────────
//
// It was four lines of shell, and they were `shell: bash`, and the Windows
// runner answered:
//
//     ##[error]bash: command not found
//
// Git Bash is not on that machine's PATH. The step never ran, `npm ci` never
// ran, the suite never ran, and the job reported `failure` for a reason that
// had nothing to do with the thing it was built to measure.
//
// Node is the one interpreter this job can rely on, because `setup-node` has
// just installed it and the suite needs it anyway. So the parsing lives here
// and the workflow step is a single portable `node scripts/windows-tally.mjs`.
//
// ── WHAT IT PRINTS, AND WHY IT DISTINGUISHES THREE OUTCOMES ───────────────
//
// "It failed" is what the red cross already says. The useful question is how
// far off we are, and the three answers need to look different in the log:
//
//   * a tally with failures  -> the number, and the first files by name
//   * a tally with none      -> the pin can come off; says so explicitly
//   * NO tally at all        -> the run did not reach the point of counting,
//     which is a different fact and must not be mistaken for zero failures.
//
// That last one is the case that produced this file.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/windows-tally.mjs <vitest-log>");
  process.exit(2);
}

let log = "";
try {
  log = readFileSync(path, "utf8");
} catch (err) {
  console.log(`::warning title=Windows suite::no log at ${path} (${err.code ?? "unreadable"}).`);
  console.log("The suite did not get far enough to write one. That is not zero failures.");
  process.exit(0);
}

const strip = (s) => s.replace(/\[[0-9;]*m/g, "");
const lines = strip(log).split(/\r?\n/);

const files = lines.filter((l) => /^\s*Test Files\s/.test(l)).pop();
const tests = lines.filter((l) => /^\s*Tests\s/.test(l)).pop();

if (!files) {
  console.log("::warning title=Windows suite::no tally line in the log.");
  console.log("The run did not reach the point of counting. Distinct from zero failures.");
  console.log("Last 30 lines:");
  console.log(lines.filter(Boolean).slice(-30).join("\n"));
  process.exit(0);
}

const failedFiles = Number(/(\d+)\s+failed/.exec(files)?.[1] ?? 0);
console.log(`::notice title=Windows suite::${files.trim()}${tests ? ` | ${tests.trim()}` : ""}`);

if (failedFiles === 0) {
  console.log("No failing files on Windows.");
  console.log("If this holds, this job has done its job: drop `continue-on-error` from");
  console.log("`windows-probe`, clear the `UNIX_RUNNER` variable, and let the long job");
  console.log("run on whichever machine is free.");
  process.exit(0);
}

// Name them. A count tells you whether it got better; the names tell you what
// to fix next, and whether they share one cause the way the path spelling did.
const named = [...new Set(lines.flatMap((l) => /(?:FAIL|❯|×)\s+(\S+\.test\.tsx?)/.exec(l)?.slice(1, 2) ?? []))];
console.log(`${failedFiles} test file(s) still failing on Windows.`);
if (named.length) {
  console.log("Files, deduplicated:");
  for (const f of named.slice(0, 40)) console.log(`  ${f}`);
  if (named.length > 40) console.log(`  ... and ${named.length - 40} more`);
}

// Separator faults and line-ending faults look alike in a diff and have
// different fixes, so say which one the log actually shows.
const sep = lines.filter((l) => /\\[A-Za-z0-9_.-]+\//.test(l)).length;
const crlf = lines.filter((l) => /\\r\\n|\r(?!\n)/.test(l)).length;
console.log(`Signals: ${sep} line(s) show mixed path separators, ${crlf} suggest CRLF.`);
console.log("Mixed separators mean a path became a string somewhere new: see");
console.log("tests/support/repo-paths.ts. CRLF means .gitattributes did not");
console.log("renormalise an existing working copy -- delete it and re-clone.");
