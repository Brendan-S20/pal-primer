// Touch sizing has to hold in BOTH axes, and `md:` must not cancel it.
//
// ── WHAT THIS CAUGHT, AND HOW ─────────────────────────────────────────────
//
// A three-device QA sweep on 2026-08-23 measured, independently on an iPhone
// SE and an iPhone 16 Pro, that `size="sm"` buttons were 39-41pt WIDE. The
// height floor `touch:min-h-11` had been added; the width floor had not. So a
// short label ("All") or a bare glyph produced a control that was legal in one
// axis and not the other, and every existing check looked at height.
//
// The same sweep found the inverse on a tablet: `md:h-9 md:w-9` cancelling a
// 44pt box at 768px, on devices that are all touch and mostly wider than that.
// A phone in LANDSCAPE is 874px, so that one was never even iPad-specific.
//
// Both are mechanical. Neither was mechanically checked.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Comments say `md:min-h-0` while explaining the rule; only code counts. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

const files = tsxFiles(SRC).map((f) => ({ f, code: codeOnly(readFileSync(f, "utf8")) }));

describe("a touch size cannot be cancelled at a width breakpoint", () => {
  it("scans a real number of files, so a green run is not vacuous", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never lets a bare md: shrink a control below the touch floor", () => {
    // `md:h-9`, `md:min-h-0` and friends are fine when they are scoped to a
    // MOUSE (`md:mouse:`). Unscoped, they fire on every tablet and on a phone
    // held sideways, which is exactly where a finger still is.
    const CANCELS = /(?<!mouse:)\bmd:(min-h-0|h-[0-9]|w-[0-9]|min-h-[0-9]|min-w-[0-9])\b/;
    const offenders: string[] = [];
    for (const { f, code } of files) {
      code.split("\n").forEach((line, i) => {
        if (!CANCELS.test(line)) return;
        // Only a line that ALSO sets a touch floor is cancelling one. A
        // `md:h-9` on something that was never 44pt is just a size.
        if (!/\b(h-11|w-11|min-h-11|min-w-11|min-h-\[2\.75rem\])\b/.test(line)) return;
        offenders.push(`${repoRelative(f, ROOT)}:${i + 1}\n    ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      offenders,
      "these set a 44pt target and then cancel it at md:, which fires on every " +
        "tablet and on a phone in landscape. Scope the cancel to md:mouse:.",
    ).toEqual([]);
  });
});

describe("ui/button.tsx sizes a target in both axes", () => {
  const whole = readFileSync(resolve(SRC, "components/ui/button.tsx"), "utf8");

  /** ONLY the `size:` block. `variant:` has a `default:` key too, and matching
   *  the first `default:` in the file finds the colour, not the height — which
   *  is what the first draft of this test did, and it failed on a correct
   *  build. A test that reads the wrong lines is worse than no test. */
  const src = (() => {
    const at = whole.indexOf("size: {");
    expect(at, "no `size: {` block in ui/button.tsx — the parse has drifted").toBeGreaterThan(0);
    const depth = whole.indexOf("},", at);
    return whole.slice(at, depth);
  })();

  it("gives every size variant a touch height", () => {
    for (const v of ["default:", "sm:", "lg:", "icon:"]) {
      const line = src.split("\n").find((l) => l.trim().startsWith(v));
      expect(line, `no ${v} variant found — the parse has drifted`).toBeTruthy();
      expect(line, `button ${v} has no touch height`).toMatch(/touch:min-h-11/);
    }
  });

  it("gives sm and icon a touch WIDTH too", () => {
    // These are the two that render without a wide label: `icon` by
    // definition, and `sm` wherever it wraps a glyph or a short word. Measured
    // at 39-41pt before this, on two devices.
    for (const v of ["sm:", "icon:"]) {
      const line = src.split("\n").find((l) => l.trim().startsWith(v));
      expect(
        line,
        `button ${v} sets a touch height and no touch width — a glyph or a short ` +
          `label makes it legal in one axis and not the other`,
      ).toMatch(/touch:min-w-11/);
    }
  });
});
