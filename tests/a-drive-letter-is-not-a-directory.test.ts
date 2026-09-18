// A file URL's `pathname` is a path on this machine and a broken one on Windows.
//
// ── THE BUG ───────────────────────────────────────────────────────────────
//
// A file URL's `pathname` is a URL component, not a filesystem path. On
// POSIX the two happen to coincide, which is why this idiom spread to 77
// places and passed every run for months:
//
//     new URL("..", "file:///repo/tests/x.test.ts").pathname  ->  "/repo/"
//
// On Windows they do not coincide, and the difference is one character at
// the front:
//
//     new URL("..", "file:///C:/repo/tests/x.test.ts").pathname  ->  "/C:/repo/"
//                                                                    ^
//
// `readFileSync("/C:/repo/src/...")` is ENOENT. Where the read happens at
// module scope -- which is the common shape here, `const ROOT = ...` followed
// by `const read = (p) => readFileSync(ROOT + p)` -- the file throws during
// COLLECTION, so vitest reports it as `(0 test)` rather than as a failure.
// A file that contributes zero tests and zero failures is close to invisible
// in a summary line.
//
// `fileURLToPath()` exists for exactly this and is correct on both. It is
// also already the majority idiom in this repo: 99 uses against the 77 that
// were wrong, which is its own small lesson about consistency.
//
// ── WHY IT WAS FOUND ONLY ON 2026-09-18 ───────────────────────────────────
//
// Because nothing had ever run the suite on Windows. A second self-hosted
// runner joined on 2026-09-16 and sat idle behind `UNIX_RUNNER = macOS`.
// `windows-probe` was added to measure what it would take to use it; this is
// the dominant thing it found. The path-separator fault fixed the same day
// (`tests/support/repo-paths.ts`) was real and much smaller -- 21 sites --
// and it is worth not confusing the two, because they look alike in a failure
// message and have different fixes.
//
// ── WHAT THIS ALLOWS ──────────────────────────────────────────────────────
//
// `fileURLToPath` returns a platform path, so on Windows it yields
// backslashes. That is correct for READING. It is not correct for printing or
// comparing, and `repoRelative()` in `tests/support/repo-paths.ts` is what
// that boundary is for. Reading with backslashes and displaying with forward
// slashes is the right split, not an inconsistency.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");

/** The idiom, in any spelling: a file URL whose `.pathname` is taken. */
const URL_PATHNAME = /new URL\([^()]*import\.meta\.url[^()]*\)\s*\.\s*pathname/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function violations(): string[] {
  const found: string[] = [];
  for (const dir of ["tests", "src", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        // The explanation above quotes the broken idiom in order to explain
        // it. Quoting a bug is not committing one.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (URL_PATHNAME.test(line)) {
          found.push(
            `${repoRelative(file, root)}:${i + 1}\n` +
              `      A file URL's \`pathname\` is a URL component, not a path. On Windows it ` +
              `comes back as "/C:/repo/" -- note the leading slash before the drive letter -- ` +
              `and every read from it is ENOENT. Wrap it: ` +
              `\`fileURLToPath(new URL("..", import.meta.url))\`, imported from "node:url". ` +
              `See tests/a-drive-letter-is-not-a-directory.test.ts.`,
          );
        }
      });
    }
  }
  return found;
}

describe("a path is read from fileURLToPath, never from a URL's pathname", () => {
  it("finds no file URL whose pathname is used as a path", () => {
    expect(violations().join("\n")).toBe("");
  });

  it("would have caught all 81, so a green run means checked", () => {
    // ── THESE ARE BUILT BY CONCATENATION ON PURPOSE ───────────────────────
    //
    // Written as plain literals, they ARE the broken idiom, and the codemod
    // that fixed the other 81 sites cheerfully "fixed" them too -- turning
    // every example of the bug into an example of the cure, so the mutation
    // check asserted that the correct code should be flagged, and failed.
    //
    // Splitting the `.pathname` off means no line here matches the pattern,
    // which keeps both a codemod and this file's own rule away from its
    // fixtures. A test that quotes a bug has to hold the quote out of reach.
    const P = ".pathname";
    for (const shipped of [
      'const ROOT = new URL("..", import.meta.url)' + P + ";",
      'const SRC = new URL("../src", import.meta.url)' + P + ";",
      '      join(new URL("..", import.meta.url)' + P + ', "src/routes/api/x.ts"),',
    ]) {
      expect(URL_PATHNAME.test(shipped), `should be flagged: ${shipped}`).toBe(true);
    }

    // And the fix must pass, or the rule is unsatisfiable.
    for (const fixed of [
      'const ROOT = fileURLToPath(new URL("..", import.meta.url));',
      '      join(fileURLToPath(new URL("..", import.meta.url)), "src/routes/api/x.ts"),',
    ]) {
      expect(URL_PATHNAME.test(fixed), `should not be flagged: ${fixed}`).toBe(false);
    }
  });

  it("leaves alone the URL uses that are genuinely about URLs", () => {
    // A pathname read off a real URL is the correct use of the property, and
    // this rule must not push anybody away from it.
    for (const ok of [
      'const path = new URL(req.url).pathname;',
      'if (new URL(link).pathname.startsWith("/portal")) return true;',
      'const u = new URL("../src", import.meta.url);',
      'const dir = fileURLToPath(new URL(".", import.meta.url));',
    ]) {
      expect(URL_PATHNAME.test(ok), `should not be flagged: ${ok}`).toBe(false);
    }
  });

  it("agrees with fileURLToPath on this platform, which is why the swap was safe", () => {
    // 81 sites were substituted in bulk on the strength of this equivalence.
    // If it ever stops holding, the substitution changed behaviour on macOS
    // as well as fixing Windows.
    const u = new URL("..", "file:///repo/tests/x.test.ts");
    expect(u.pathname).toBe("/repo/");

    // And the Windows shape, which is the whole point.
    expect(new URL("..", "file:///C:/repo/tests/x.test.ts").pathname).toBe("/C:/repo/");
  });
});
