/**
 * The design system carries the 44px floor. Most of this app is not the design
 * system.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `wide-things-that-set-the-width-of-the-page.test.ts` pins the floor on
 * `ui/input.tsx`, `ui/select.tsx` and `ui/checkbox.tsx`, and is correct about
 * all three. It says nothing about a `<select>` written as plain HTML, and
 * this app has 97 of those across 36 files, plus 30 raw `<input
 * type="checkbox">` across 19. Every one was between 16px and 40px on a phone.
 *
 * Found by sweeping every authenticated route the signed-in sweep does not
 * list, at 430px — thirty-four findings across nine pages, of which five were
 * raw selects and raw checkboxes on three different pages.
 *
 * ── WHY THE FIX IS ONE CSS RULE AND NOT 127 CLASS ATTRIBUTES ──────────────
 *
 * Sizing them one at a time fixes the ones that happened to be measured. There
 * is no component to fix, because a raw `<select>` is not a component — so the
 * floor goes in `@layer base`, keyed on the element, where it also reaches the
 * pages nobody has opened yet. A utility class on any individual control still
 * wins, because a class beats an element selector.
 *
 * The checkbox half needs a different mechanism and this file asserts that
 * too, because the obvious version is wrong in a way that looks right:
 *
 *   - Growing the box makes a 44px CHECKBOX, which is not what the rule asks
 *     for and is visibly wrong. `ui/checkbox.tsx` uses an out-of-flow
 *     `::before` and leaves the square at 16px.
 *   - That trick is unavailable on a raw input: browsers do not generate
 *     pseudo-elements for replaced elements, so `input::before` renders
 *     nothing and the fix would be invisible while reading as done.
 *   - So the LABEL is the target — activating a label activates its control,
 *     which is browser behaviour and is already what rules.ts measures.
 *   - And a bare `min-height` on a label does nothing at all, because a
 *     `<label>` is inline by default and inline boxes ignore it.
 *
 * Each of those four is a plausible wrong answer, so each has an assertion.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The one block in styles.css that carries the floor, isolated so a rule
 *  written for some other purpose elsewhere cannot satisfy these. */
function touchFloor(): string {
  const css = read("src/styles.css");
  const at = css.indexOf("THE 44px FLOOR");
  expect(at, "the touch floor block is gone from styles.css").toBeGreaterThan(-1);
  const open = css.indexOf("@media (pointer: coarse), (max-width: 767px) {", at);
  expect(open, "the floor block no longer opens with the touch media query").toBeGreaterThan(-1);
  // Balance braces from the media query to its close.
  let depth = 0;
  let i = css.indexOf("{", open);
  const start = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  return css.slice(start, i + 1);
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const countAcross = (re: RegExp) => {
  let n = 0;
  let files = 0;
  for (const f of tsxFiles(join(root, "src"))) {
    const hits = (readFileSync(f, "utf8").match(re) || []).length;
    if (hits) {
      n += hits;
      files++;
    }
  }
  return { n, files };
};

describe("the raw controls the design system never sees", () => {
  it("there are still enough of them for this to be worth a base rule", () => {
    // If these ever drop to near zero the codebase migrated to the components
    // and this rule can go. Until then the base rule is doing real work, and
    // a count near zero here would mean the scan broke rather than that the
    // problem was solved.
    const selects = countAcross(/<select[\s>]/g);
    const boxes = countAcross(/type="checkbox"/g);
    expect(selects.n).toBeGreaterThan(50);
    expect(selects.files).toBeGreaterThan(20);
    expect(boxes.n).toBeGreaterThan(15);
  });

  it("gives every raw select the floor, on touch", () => {
    const block = touchFloor();
    expect(block).toMatch(/(^|[\s{,])select\s*\{[^}]*min-height:\s*2\.75rem/m);
  });

  it("gives the label the floor for a checkbox, not the box", () => {
    const block = touchFloor();
    // The label, because it is the thing a browser lets you tap.
    expect(block).toMatch(/label:has\(>\s*input\[type="checkbox"\]\)/);
    expect(block).toMatch(/label:has\(>\s*input\[type="radio"\]\)/);
    // NOT the input itself — a 44px checkbox is the wrong fix and looks it.
    expect(block).not.toMatch(/(^|[\s{,])input\[type="checkbox"\]\s*\{[^}]*min-height/m);
    // NOT a pseudo-element on the input, which renders nothing on a replaced
    // element and would read as done while doing nothing.
    expect(block).not.toMatch(/input[^{,]*::(before|after)/);
  });

  it("makes the label a box, since min-height does nothing to an inline one", () => {
    const block = touchFloor();
    const rule = block.slice(block.indexOf("label:has"));
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toMatch(/min-height:\s*2\.75rem/);
  });

  it("scopes it to touch rather than to a width", () => {
    // Every iPad is 744px or wider and all of it is touch — the reason
    // src/styles.css defines a `touch:` variant instead of using `max-md:`.
    // A plain CSS rule cannot use the variant, so it spells out the same
    // condition, and both clauses have to be there: the pointer test alone
    // misses a narrow desktop window, which is the exact bug recorded above
    // the variant's own definition.
    const css = read("src/styles.css");
    const at = css.indexOf("THE 44px FLOOR");
    const block = css.slice(at, at + 3000);
    expect(block).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\)/);
  });
});

describe("the twenty-nine buttons that had to be sized in place", () => {
  const cases: [string, string, number][] = [
    // Three submit buttons at 36px — including the only way to connect
    // QuickBooks or Xero at all.
    ["src/routes/_authenticated/settings.accounting.tsx", "px-3 py-2", 3],
    // Twelve month toggles at 34px, in a four-column grid on a phone.
    ["src/routes/_authenticated/settings.deep-clean.tsx", "px-2 py-1.5", 1],
    // The two tabs that switch the whole page, at 28px.
    ["src/routes/_authenticated/settings.promotions.tsx", "px-3 py-1", 2],
    // The 7/30/90-day range on the business advisor, at 24px. It renders on
    // /analytics and on the dashboard, so one fix covers both.
    ["src/components/BusinessAdvisor.tsx", "px-2.5 py-1", 1],
    // The review queue's status filter, at 24px.
    ["src/routes/_authenticated/review.tsx", "px-3 py-1", 1],
    // The concerns status filter. This one had ALREADY been noticed and
    // fixed -- with `max-md:px-4 max-md:py-2`, a guess about width standing
    // in for a fact about input. Every iPad is 744px+ and all touch, so the
    // fix switched itself off on the device that needed it most, and even
    // below 768 it only reached 38px.
    ["src/routes/_authenticated/concerns.tsx", "rounded-full", 1],
  ];

  for (const [file, marker, count] of cases) {
    it(`sizes the controls in ${file.split("/").pop()}`, () => {
      const src = read(file);
      const sized = (src.match(/touch:min-h-11/g) || []).length;
      expect(sized, `${file} lost its touch sizing`).toBeGreaterThanOrEqual(count);
      // The marker is the padding that made them small; it is still there,
      // which is the point — the fix is a floor, not a re-style.
      expect(src).toContain(marker);
    });
  }

  it("uses the pointer variant everywhere, not a width guess", () => {
    for (const [file] of cases) {
      expect(read(file), `${file} sizes by width instead of by pointer`).not.toMatch(
        /max-md:min-h-11/,
      );
    }
  });
});
