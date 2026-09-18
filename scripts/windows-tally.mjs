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

const jsonPath = process.argv[2];
const path = process.argv[3];
if (!jsonPath || !path) {
  console.error("usage: node scripts/windows-tally.mjs <vitest-json> <vitest-log>");
  process.exit(2);
}

/**
 * Decode the log whatever the shell wrote it as.
 *
 * PowerShell's `>` does not write UTF-8. Windows PowerShell writes UTF-16LE,
 * and a UTF-16 file read as UTF-8 comes back as readable-looking characters
 * separated by NULs -- so it does not throw, does not look obviously wrong in
 * a truncated dump, and matches no regex this script has. It would report "no
 * tally line" on a suite that ran perfectly.
 *
 * Detected by BOM first, then by NUL density, because a redirect can be
 * BOM-less. `Buffer` is used rather than `readFileSync(path, "utf8")` for
 * exactly this reason.
 */
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString("utf16le"), how: "utf16le (BOM)" };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: buf.swap16().toString("utf16le"), how: "utf16be (BOM)" };
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  const nuls = sample.filter((b) => b === 0).length;
  if (sample.length > 16 && nuls / sample.length > 0.25) {
    return { text: buf.toString("utf16le"), how: "utf16le (no BOM, inferred from NUL density)" };
  }
  return { text: buf.toString("utf8"), how: "utf8" };
}

/** Emit a multi-line annotation, so the diagnosis is readable without the
 *  run log -- which GitHub withholds until every job in the run finishes. */
function annotate(level, title, body) {
  console.log(`::${level} title=${title}::${String(body).replace(/\r?\n/g, "%0A")}`);
}

// ── PREFER THE JSON, BECAUSE THE TEXT LOG IS NOT TRUSTWORTHY HERE ────────
//
// The text log is produced by `npm test > win.log 2>&1`, and on the Windows
// runner that came back as 4,169 characters -- roughly the last forty lines
// of a run with thousands of tests. Whatever truncates it (a reporter that
// rewrites lines, PowerShell's handling of a native command's stream), the
// consequence is that the summary vitest prints at the END is the part most
// likely to be missing. Scraping it for a tally was always fragile and was
// wrong on three consecutive runs.
//
// `--reporter=json --outputFile.json=` is written by vitest itself, straight
// to a file, with no shell redirection in the path. No encoding surprise, no
// truncation, and exact counts instead of a parsed sentence.
//
// The text log is still passed in, and still used, for the DIAGNOSTIC tail
// when something went wrong. Structured for the number, human-readable for
// the reason.
try {
  const j = JSON.parse(readFileSync(jsonPath, "utf8"));
  const failedTests = j.numFailedTests ?? 0;
  const failedSuites = j.numFailedTestSuites ?? 0;
  const line = `Test Files ${j.numTotalTestSuites - failedSuites} passed, ${failedSuites} failed | Tests ${j.numPassedTests ?? 0} passed, ${failedTests} failed`;
  console.log(`::notice title=Windows suite::${line}`);

  if (failedSuites === 0 && failedTests === 0) {
    console.log("No failing files on Windows.");
    console.log("If this holds, this job has done its job: drop `continue-on-error` from");
    console.log("`windows-probe`, clear the `UNIX_RUNNER` variable, and let the long job");
    console.log("run on whichever machine is free.");
    process.exit(0);
  }

  const failing = (j.testResults ?? []).filter((r) => r.status === "failed");
  console.log(`${failedSuites} file(s) and ${failedTests} test(s) failing on Windows.`);
  for (const r of failing.slice(0, 40)) {
    console.log(`  ${r.name ?? "(unnamed)"}`);
    const msgs = (r.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const m of msgs.slice(0, 2)) {
      console.log(`      ${(m.failureMessages ?? [])[0]?.split("\n")[0] ?? m.title ?? ""}`.slice(0, 220));
    }
  }
  if (failing.length > 40) console.log(`  ... and ${failing.length - 40} more`);
  process.exit(0);
} catch (err) {
  if (err?.code !== "ENOENT") {
    console.log(`::warning title=Windows suite::json at ${jsonPath} unreadable (${err.message}); falling back to the text log.`);
  } else {
    console.log(`::warning title=Windows suite::no json at ${jsonPath}; vitest did not get far enough to write one. Falling back to the text log.`);
  }
}

let log = "";
let encoding = "utf8";
try {
  const buf = readFileSync(path);
  const d = decode(buf);
  log = d.text;
  encoding = d.how;
} catch (err) {
  annotate("warning", "Windows suite", `no log at ${path} (${err.code ?? "unreadable"}).\nThe suite did not get far enough to write one. That is NOT zero failures.`);
  process.exit(0);
}

const strip = (s) => s.replace(/\[[0-9;]*m/g, "");
const lines = strip(log).split(/\r?\n/);

const files = lines.filter((l) => /^\s*Test Files\s/.test(l)).pop();
const tests = lines.filter((l) => /^\s*Tests\s/.test(l)).pop();

if (!files) {
  const tail = lines.filter(Boolean).slice(-24).join("\n");
  annotate(
    "warning",
    "Windows suite",
    `no tally line. The run did not reach the point of counting, which is NOT zero failures.\n` +
      `log bytes: ${log.length}, decoded as: ${encoding}\n--- last lines ---\n${tail}`,
  );
  console.log(`decoded as: ${encoding}`);
  console.log(tail);
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
