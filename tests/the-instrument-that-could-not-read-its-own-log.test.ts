// `scripts/windows-tally.mjs` is the only thing standing between a broken
// measurement and a wrong conclusion, so it gets tested like one.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// `windows-probe` runs the suite on the idle Windows runner and reports how
// much of it passes. The decision waiting on that number is whether to clear
// `UNIX_RUNNER` and move the forty-minute job off a Mac measured at 94% swap.
//
// That makes the FAILURE MODE asymmetric. A tally that under-reports failures
// is not a wrong number, it is a green light to move production CI onto a
// machine where the suite was never actually verified. Three runs in a row
// produced no number at all -- first `bash` was missing, then a reporter that
// vitest 4 removed -- and each time the script said "the run did not reach the
// point of counting" rather than "zero failures". That distinction is the
// whole value of it, and it is what these tests pin.
//
// ── THE ENCODING CASE IS THE DANGEROUS ONE ────────────────────────────────
//
// PowerShell's `>` does not write UTF-8. Windows PowerShell writes UTF-16LE,
// and a UTF-16 file read as UTF-8 does not throw and does not look obviously
// broken -- it comes back as the right characters with NULs between them. It
// simply matches no regex. A suite that ran perfectly would report as "no
// tally line", and the natural next move on seeing that three times is to
// assume the harness is fine and the platform is hopeless.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "windows-tally.mjs");
const dir = mkdtempSync(join(tmpdir(), "tally-"));

function run(file: string): string {
  return execFileSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
}

const PASSING = ["RUN  v4.1.10", " Test Files  270 passed | 3 skipped (273)", "      Tests  3638 passed (3677)", ""].join("\n");

const FAILING = [
  " FAIL  tests/hover-does-not-exist-on-a-touchscreen.test.ts > finds no control",
  'AssertionError: expected [ "src\\components/RouteMap.tsx" ] to equal [ "src/components/RouteMap.tsx" ]',
  " Test Files  1 failed | 269 passed (270)",
  "      Tests  2 failed | 3636 passed (3638)",
  "",
].join("\n");

function write(name: string, text: string, encoding: "utf8" | "utf16le", bom = false): string {
  const p = join(dir, name);
  const body = Buffer.from(text, encoding);
  writeFileSync(p, bom && encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body);
  return p;
}

describe("the tally can read a log its own shell wrote", () => {
  it("reads UTF-8", () => {
    expect(run(write("a.log", PASSING, "utf8"))).toContain("Test Files  270 passed");
  });

  it("reads UTF-16LE with a BOM, which is what PowerShell's > produces", () => {
    expect(run(write("b.log", PASSING, "utf16le", true))).toContain("Test Files  270 passed");
  });

  it("reads UTF-16LE with no BOM, inferred from NUL density", () => {
    // A redirect can be BOM-less, and this is the case a BOM check alone
    // misses: it decodes to something, so nothing errors, and the tally is
    // simply absent.
    expect(run(write("c.log", PASSING, "utf16le"))).toContain("Test Files  270 passed");
  });
});

describe("it never reports an absent measurement as a clean one", () => {
  it("says a missing log is not zero failures", () => {
    const out = run(join(dir, "does-not-exist.log"));
    expect(out).toMatch(/NOT zero failures/);
    expect(out).not.toMatch(/No failing files/);
  });

  it("says a log with no tally is not zero failures, and shows what it saw", () => {
    // The literal shape of all three wasted runs: output exists, the suite
    // never counted.
    const out = run(write("d.log", "bash: command not found\n", "utf8"));
    expect(out).toMatch(/NOT zero failures/);
    expect(out).not.toMatch(/No failing files/);
    expect(out).toContain("bash: command not found");
  });

  it("only says the pin can come off when a tally really shows zero failures", () => {
    expect(run(write("e.log", PASSING, "utf8"))).toMatch(/UNIX_RUNNER/);
    expect(run(write("f.log", FAILING, "utf8"))).not.toMatch(/UNIX_RUNNER/);
  });
});

describe("when there are failures it says which, and of what kind", () => {
  it("names the files rather than only counting them", () => {
    const out = run(write("g.log", FAILING, "utf8"));
    expect(out).toContain("1 test file(s) still failing");
    expect(out).toContain("tests/hover-does-not-exist-on-a-touchscreen.test.ts");
  });

  it("distinguishes a separator fault from a line-ending one", () => {
    // They look alike in a diff and have different fixes: one is a new place a
    // path became a string, the other is a working copy .gitattributes never
    // renormalised.
    expect(run(write("h.log", FAILING, "utf8"))).toMatch(/[1-9]\d* line\(s\) show mixed path separators/);
  });
});
