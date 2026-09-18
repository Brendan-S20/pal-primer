// A 1x1 invisible label pulled /clients 663px sideways.
//
// ── THE MECHANISM, WHICH IS THE WHOLE POINT ───────────────────────────────
//
// `/clients` at 768px measured 1431px of horizontal scroll, and the table
// causing it was ALREADY inside `<div className="overflow-x-auto">` — which is
// exactly what CLAUDE.md prescribes and what
// `wide-things-that-set-the-width-of-the-page.test.ts` enforces. That test was
// green. The scroll container measured 464px wide with `overflow-x: auto`, so
// it was clipping correctly. Every ancestor fitted the viewport.
//
// The culprit was one element:
//
//     <span class="sr-only">Actions</span>   position: absolute, 1x1, at x=1430
//
// the screen-reader label on the table's Actions column header. Tailwind's
// `sr-only` is `position: absolute`, and **overflow clipping does not apply to
// an absolutely-positioned descendant whose containing block is outside the
// scroller**. The wrapper was `position: static`, so it was not that
// containing block — the span's containing block was further up, outside the
// clip, and the span escaped and extended the document by 663px.
//
// Confirmed rather than reasoned: setting `documentElement.scrollLeft = 9999`
// moved the page to 663, so the scroll was real and not an artefact of how
// scrollWidth is computed.
//
// ── THE FIX ALREADY EXISTED, ON THE PRIMITIVE ─────────────────────────────
//
// `ui/table.tsx` wraps its table in `relative w-full overflow-auto`. The
// `relative` is what makes the scroller the containing block, so nothing
// inside can escape it. Twenty-two hand-rolled wrappers across the app copied
// the `overflow-x-auto` and not the `relative`.
//
// That is the third time in this batch the same shape has turned up: the fix
// was in the repo, on one of two places, and the other had drifted. The
// sidebar trigger (platform shell had it, tenant shell did not) and this.
//
// ── WHY A STATIC TEST ─────────────────────────────────────────────────────
//
// The browser sweep found this once, on one page, because that page happened
// to have an `sr-only` inside a table. Twenty of the other twenty-two wrappers
// have no absolutely-positioned descendant TODAY and are silently one
// `sr-only`, one tooltip or one `absolute` badge away from the same fault.
// A parser cannot see the escape, but it can see the missing `relative` — and
// that is the cheap half of the pair CLAUDE.md describes.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("a horizontal scroll container must be able to contain what it scrolls", () => {
  it("every hand-rolled scroller around a table is also `relative`", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("overflow-x-auto") || !line.includes("<div")) return;
        if (line.includes("relative")) return;
        // Only wrappers that actually wrap a table: a scroller around a row of
        // pills has nothing positioned inside it to escape, and demanding
        // `relative` everywhere would be a rule nobody believes.
        const wrapsTable = lines.slice(i + 1, i + 4).some((l) => l.includes("<table"));
        if (wrapsTable) offenders.push(`${repoRelative(file, ROOT)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "an `overflow-x-auto` wrapper that is `position: static` does not contain " +
        "absolutely-positioned descendants — an `sr-only` label inside the table " +
        "escapes the clip and scrolls the whole page. Add `relative`, as " +
        "ui/table.tsx already does.",
    ).toEqual([]);
  });

  it("and the primitive everyone should have copied still has it", () => {
    // If this ever loses `relative`, the rule above is enforcing a convention
    // its own reference implementation no longer follows.
    expect(readFileSync(join(ROOT, "src/components/ui/table.tsx"), "utf8")).toMatch(
      /className="relative w-full overflow-auto"/,
    );
  });
});
