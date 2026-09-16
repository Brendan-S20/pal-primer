// Touch-target SIZING is spelled `touch:`, never `max-md:`.
//
// This is the fifth of the mechanically-checked rules, and unlike the other
// four it is a ratchet rather than a cleanup: there are zero violations in
// `src/` as this lands. It exists because the rule was already learned once,
// already fixed once, and then quietly broken again by a file written after
// the fix.
//
// ── THE HISTORY, BECAUSE IT IS THE WHOLE ARGUMENT ─────────────────────────
//
// 2026-08-21, `docs/ipad-was-never-measured.md`: a browser sweep reported
// 382 passed / 0 failed on iPad-sized viewports while emulating a MOUSE, and
// the same code failed 105 of them the moment touch was turned on. Every
// failure was at 820px and up. The cause was one idiom used everywhere —
// `max-md:min-h-11`, "grow the target below 768px" — which is a guess about
// WIDTH standing in for a fact about INPUT, and is wrong on exactly one class
// of device: the iPad, which is 744px or wider in portrait and up to 1366 in
// landscape, all of it touch.
//
// `#115` fixed it properly, with a variant in `src/styles.css` rather than 85
// edits:
//
//     @custom-variant touch {
//       @media (pointer: coarse), (max-width: 767px) { @slot; }
//     }
//
// A strict superset of `max-md:` — nothing below 768px changed, and iPads
// simply stopped being excluded.
//
// 2026-09-13, `#207` added a new control to `/routes` and spelled its touch
// floor `max-md:min-h-11`, the spelling the variant had just replaced. Two
// route-plausibility warning buttons then rendered 16.0px tall on every iPad
// size and in iPhone landscape, and nothing caught it for two days — the
// default sweep only asks for 44px at or below 768px, so it agreed the page
// was fine. It took `APPLE_SIZES=1`, which sets `hasTouch` and measures at
// 820 / 844 / 1024 / 1180 / 1366, to see it. Fixed in `30f49fc`.
//
// A comment above that class list argued the `max-md:` was deliberate,
// "because the sweep measures by width, not by pointer type". That was true of
// the default sweep and false under APPLE_SIZES, and the comment named
// `touch:` before talking itself out of it. Which is the real lesson: the
// knowledge was written down, in the file, next to the bug, and still did not
// prevent it. A grep does.
//
// ── WHAT COUNTS AS A VIOLATION ────────────────────────────────────────────
//
// Only `max-md:` applied to a SIZE that exists to clear the 44px floor:
// heights and widths of 11 (2.75rem = 44px) and 12 (3rem = 48px).
//
// Everything else `max-md:` does is left alone, deliberately and by design:
//
//   * LAYOUT — `max-md:flex-col`, `max-md:hidden`, `max-md:block`,
//     `max-md:bottom-[...]`. These are genuinely about width. A narrow window
//     on a desktop is still narrow, mouse or not, and `styles.css` keeps the
//     width clause for exactly that reason.
//   * HOVER ESCAPES — `tests/hover-does-not-exist-on-a-touchscreen.test.ts`
//     REQUIRES a `max-md:` escape on a `group-hover:` reveal. Flagging those
//     would set the two rules against each other, and the hover rule is right:
//     it argues at length that width is a worse proxy in theory and a better
//     one in practice for deciding whether to SHOW a control.
//
// So: show-or-hide may key on width. How big a thing is for a finger may not.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** `max-md:` on a size that only exists to reach the touch floor. `size-11`
 *  is included because it sets both dimensions at once and is the same claim. */
const WIDTH_GATED_TOUCH_SIZE = /\bmax-md:(?:min-h|min-w|h|w|size)-1[12]\b/;

function violations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      // The explanatory comment in styles.css quotes the old spelling in order
      // to explain why it is wrong. Quoting a bug is not committing one.
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;
      const m = line.match(WIDTH_GATED_TOUCH_SIZE);
      if (m) {
        found.push(
          `${file.slice(root.length + 1)}:${i + 1}  ${m[0]}\n` +
            `      A finger is the same size on an iPad as on a phone. Use ` +
            `\`touch:\` — it is \`(pointer: coarse), (max-width: 767px)\`, a strict ` +
            `superset of \`max-md:\`, so nothing below 768px changes and iPads ` +
            `stop being excluded. See src/styles.css and docs/ipad-was-never-measured.md.`,
        );
      }
    });
  }
  return found;
}

describe("touch sizing keys on the pointer, not on the viewport width", () => {
  it("finds no control whose 44px floor switches off on an iPad", () => {
    expect(violations().join("\n")).toBe("");
  });

  it("would have caught the one that shipped, so a green run means checked", () => {
    // Mutation check against the exact class list from #207, which produced
    // two 16.0px buttons at 820 / 844 / 1024 / 1180 / 1366. Without this the
    // test above proves only that the regex compiled.
    const shipped =
      'className="flex w-full items-center text-left text-xs text-destructive ' +
      'underline-offset-2 hover:underline max-md:min-h-11 max-md:py-1"';
    expect(WIDTH_GATED_TOUCH_SIZE.test(shipped)).toBe(true);

    // And the fix must pass, or the rule is unsatisfiable.
    const fixed = shipped.replace("max-md:min-h-11 max-md:py-1", "touch:min-h-11 touch:py-1");
    expect(WIDTH_GATED_TOUCH_SIZE.test(fixed)).toBe(false);
  });

  it("leaves width-based layout and hover escapes alone", () => {
    // Each of these is a legitimate use of max-md: that this rule must not
    // break. The hover ones are REQUIRED by
    // tests/hover-does-not-exist-on-a-touchscreen.test.ts.
    for (const ok of [
      'className="max-md:flex-col gap-2"',
      'className="hidden max-md:block"',
      'className="group-hover:flex max-md:flex"',
      'className="max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))]"',
      'className="max-md:w-full"',
      'className="max-md:h-auto"',
      'className="max-md:py-1"',
    ]) {
      expect(WIDTH_GATED_TOUCH_SIZE.test(ok), `${ok} should not be flagged`).toBe(false);
    }
  });

  it("still has the variant it is pointing everybody at", () => {
    // The advice in the failure message is only good while this exists.
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    expect(css).toMatch(/@custom-variant\s+touch\b/);
    expect(css).toMatch(/pointer:\s*coarse/);
  });
});
