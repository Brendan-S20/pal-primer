// A grid column will not shrink below its content, and nobody had told it to.
//
// ── THE MECHANISM, WHICH IS THE WHOLE POINT ───────────────────────────────
//
// A grid item's `min-width` computes to `auto`, not `0`. So a column is never
// laid out narrower than its content's min-content width, however narrow the
// grid is. On /clients/:id at 360px both columns of SummaryTab's
// `grid gap-6 lg:grid-cols-[3fr_2fr]` were measured at **569px** — the page
// was 585px wide and seven controls sat off the side of the screen.
//
// This is the same fault CLAUDE.md describes for flex items:
//
//     "A flex item is never laid out narrower than its own content unless it
//      is allowed to be — `min-w-0` on the item, or an overflow other than
//      `visible`."
//
// and `tests/a-flex-row-as-wide-as-its-longest-word.test.ts` enforces it —
// but that file is, in its own words, "deliberately silent on … grids". So
// this class of fault had no coverage at all, in either half of the suite:
// the parser does not look at grids, and the browser could not reach these
// pages until the signed-in sweep was built on 2026-08-19.
//
// ── WHY THE FIX WAS NOT WHERE IT LOOKED ───────────────────────────────────
//
// Worth recording, because the first attempt was wrong. The sweep reported
// nine controls off the side of /clients/:id, and the DOM said a
// `div.flex items-center gap-2` was 485px inside a 286px parent — the header's
// five-button action row. That row was genuinely unable to wrap and it was
// genuinely fixed. It was not the cause: the page stayed 585px afterwards,
// because the row was overflowing a container that was ALREADY too wide.
//
// The textarea "at x=37..564", the note tabs and Add note were never faults of
// their own either. They are `w-full` children of a card filling an over-wide
// column, so they were reported at the width they were given.
//
// The lesson for the next reader: a list of off-side controls is a list of
// SYMPTOMS. Find the outermost element wider than the viewport — the one whose
// parent still fits — and fix that. Everything below it is downstream.
//
// ── VERIFIED BY MEASUREMENT, NOT BY READING ───────────────────────────────
//
//   /clients/:id  @360   585px → 360px     @768  849px → 768px
//   /dashboard    @360   503px → 360px
//
// and the signed-in sweep went from 21 failing surface/width combinations to
// 18. /dashboard was not on the brief; it turned up carrying the identical
// fault in `grid gap-4 max-md:order-1 lg:grid-cols-3`, and a one-word fix
// found by the same measurement was not worth leaving undone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("the columns that were 569px inside a 360px phone", () => {
  const summary = codeOnly(read("src/components/client-detail/SummaryTab.tsx"));

  it("both of SummaryTab's grid columns can shrink", () => {
    // Both, not one: the right column carries the notes panel and the left the
    // alerts, and either alone holds the page open.
    const cols = summary.match(/<div className="min-w-0 space-y-6">/g) ?? [];
    expect(cols, "SummaryTab's two grid columns must both carry min-w-0").toHaveLength(2);
    // And no column may go back to the version that could not shrink.
    expect(summary).not.toMatch(/<div className="space-y-6">/);
  });

  it("the grid they sit in is still the two-column desktop layout", () => {
    // The cheap wrong fix is to delete the grid. min-w-0 keeps the desktop
    // layout exactly as designed and only changes what happens below `lg`.
    expect(summary).toMatch(/grid gap-6 lg:grid-cols-\[3fr_2fr\]/);
  });
});

describe("the dashboard's map row, which had the same fault", () => {
  const dash = codeOnly(read("src/routes/_authenticated/dashboard.tsx"));

  it("both children of the map grid can shrink", () => {
    expect(dash).toMatch(/<div className="min-w-0 rounded-lg border bg-card p-4 max-md:order-2 lg:col-span-2">/);
    expect(dash).toMatch(/<div className="min-w-0 space-y-4 max-md:order-1">/);
  });
});

describe("the header action row, which was a real fault but not the cause", () => {
  const header = codeOnly(read("src/components/client-detail/ClientHeader.tsx"));

  it("wraps rather than hiding the two actions a phone needs most", () => {
    // Call and Navigate are what this page is for from a driveway. Collapsing
    // them into the More menu below `md` would fit the phone by taking away
    // the phone's reason to be here.
    expect(header).toMatch(/<div className="flex flex-wrap items-center gap-2">/);
    expect(header).toMatch(/Navigate/);
    expect(header).toMatch(/> Call$/m);
  });

  it("and its More button reaches the touch floor", () => {
    expect(header).toMatch(/className="h-11 w-11 p-0"/);
  });
});

describe("controls that were only as tall as their text", () => {
  it("SummaryTab's three jump links have a real hit area", () => {
    const summary = codeOnly(read("src/components/client-detail/SummaryTab.tsx"));
    const links =
      summary.match(/className="mt-2 inline-flex min-h-11 items-center text-xs text-primary hover:underline"/g) ??
      [];
    expect(links, "View all visits / Manage services / View properties").toHaveLength(3);
  });

  it("the inline Review link grows its target without moving the sentence", () => {
    // The awkward one: it sits INSIDE a sentence, so a min-height would push
    // the line apart. Padding grows the hit area; the negative margin takes
    // the growth back out of the layout.
    const summary = codeOnly(read("src/components/client-detail/SummaryTab.tsx"));
    expect(summary).toMatch(/className="ml-1\.5 inline-block py-3 -my-3 text-primary underline/);
  });

  it("the note audience tabs are sized like the control they are", () => {
    const notes = codeOnly(read("src/components/client-detail/NotesPanel.tsx"));
    expect(notes).toMatch(/inline-flex min-h-11 items-center rounded-md px-2\.5 py-1 text-xs font-medium/);
  });
});
