// "I was looking at the routes weeks and month calendar and it doesn't look
// pretty on the phone."
//
// It did not, and the reason was blunt: `ScheduleCalendar` contained no
// responsive breakpoint of any kind. One `grid-cols-7`, at every width, from a
// 1920px monitor down to a phone held in a driveway. The page around it has a
// mobile branch — `routes.tsx` swaps in `MobileDayList` below `md` — but only
// for `range === "today"`. Week and month fell through to the desktop grid
// unconditionally.
//
// ── WHY THE TWO RANGES GET DIFFERENT ANSWERS ──────────────────────────────
//
// A WEEK reflows to one column. Seven full-width rows carry exactly the same
// information as seven 45px columns, and a thumb can use them.
//
// A MONTH keeps its seven columns, because the shape of a month IS part of the
// information — which week a date falls in, where the empty stretches are.
// Thirty stacked rows would answer a question nobody asked and cost a very
// long scroll. So the month changes density instead: date and count, tap to
// open the day.
//
// ── THE MEASUREMENT THAT DECIDED THE MONTH CELL ───────────────────────────
//
// Keeping seven columns is only allowed if seven columns FIT, and the first
// attempt did not. At 320px, after the page and card padding, seven columns
// with gaps leave roughly 34px each, and the cell's own padding takes 12 of
// that. "MON 31 12" on one line needs more than twice what is left, so the
// grid would have pushed the page into horizontal scroll — the one thing
// CLAUDE.md rules out outright.
//
// Two changes bought the room: the weekday moved out of all thirty cells into
// a single column header the grid shares, and the count stacks under the date
// until there is space beside it. What remains in a phone-width month cell is
// a two-digit number over a two-digit number.
//
// ── WHAT ELSE THIS FILE PINS ──────────────────────────────────────────────
//
// The header row is derived from a hardcoded Monday, so it has to agree with
// the grid's own week start or every label sits over the wrong column. That is
// arithmetic, not markup, and it is checked as arithmetic below.
//
// And the footer used to read "Hover a visit for who and where". Hover does
// not exist on a touchscreen. On the device this board is most used from, that
// sentence described a gesture the reader could not make.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calendarWindow } from "@/components/schedule/ScheduleCalendar";

const root = join(import.meta.dirname, "..");

/** Lazy on purpose. Resolving a read in a `describe` body throws at import
 *  time when the file is stashed, and vitest reports "no tests" instead of the
 *  failures — which reads as a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comment lines stripped. The component now carries a long comment explaining
 *  the layout it replaced, quoting the old `grid-cols-7` and the old hover
 *  sentence, so `not.toMatch` against raw source would fail on the account of
 *  the fix rather than on the defect.
 *
 *  The `{@literal /}* … *{@literal /}` pass is not decoration: the hover
 *  sentence is explained in a JSX comment inside the returned markup, and a
 *  line-prefix filter alone leaves every line of it in place — which is
 *  exactly how the first run of this file "caught" a defect that was not
 *  there. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const calendar = () => codeOnly(read("src/components/schedule/ScheduleCalendar.tsx"));

describe("a week reflows, a month condenses", () => {
  it("gives the week one column below md and seven above it", () => {
    const src = calendar();
    expect(src).toMatch(/grid-cols-1 md:grid-cols-7/);
    // Hiding weekends is a five-column week, and it needs the same treatment —
    // five 63px columns is not meaningfully better than seven 45px ones.
    expect(src).toMatch(/grid-cols-1 md:grid-cols-5/);
  });

  it("does not reflow the month, because a month's shape is the point", () => {
    const src = calendar();
    // The month branch of `gridCls`: bare column counts, no `grid-cols-1`
    // fallback. Written as a check on the ternary rather than on the file so
    // that adding `grid-cols-1` to the WEEK branch cannot satisfy it.
    //
    // Anchored from `const gridCls` forward — `VisitChip` has its own
    // `return (` earlier in the file, and searching from zero produced an
    // empty slice that then matched nothing and passed nothing.
    const start = src.indexOf("const gridCls");
    expect(start).toBeGreaterThan(0);
    const ternary = src.slice(start, src.indexOf("return (", start));
    const monthBranch = ternary.slice(0, ternary.indexOf(": cols === 5"));
    expect(monthBranch).toMatch(/grid-cols-7/);
    expect(monthBranch).toMatch(/grid-cols-5/);
    expect(monthBranch).not.toMatch(/grid-cols-1/);
  });

  it("never lets a cell claim seven rems of height on a phone", () => {
    const src = calendar();
    // 7rem × 30 month cells is a page that scrolls for a long time to show
    // information the cells are too narrow to carry. Every occurrence has to
    // be behind `md:`; an unqualified one is the regression.
    const heights = [...src.matchAll(/(md:)?min-h-\[7rem\]/g)];
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h[1]).toBe("md:");
  });

  it("hides the month's chips only below md, where the day is one tap away", () => {
    const src = calendar();
    // The chips are hidden on a phone, which is only defensible because the
    // date button opens that day's board. If the chip container were hidden
    // unconditionally the month would carry no visit detail at any width.
    expect(src).toMatch(/isMonth \? "hidden md:flex" : "flex"/);
  });
});

describe("the date is a target a thumb can hit", () => {
  it("gives both ranges a 44px date button below md", () => {
    const src = calendar();
    const button = src.slice(src.indexOf("onClick={() => onPickDay(d)}"));
    const cls = button.slice(0, button.indexOf("title="));
    // 2.75rem is 44px. Both branches of the isMonth ternary carry it, and both
    // release it at md where a pointer is doing the work.
    expect([...cls.matchAll(/min-h-\[2\.75rem\]/g)]).toHaveLength(2);
    // `md:mouse:min-h-0`, not `md:min-h-0`. The compact desktop row is wanted
    // on a wide screen WITH A MOUSE; an iPad is wide and has a finger, and the
    // bare `md:` cancel put this control back to 40px on every one of them.
    expect(cls).toMatch(/md:mouse:min-h-0/);
  });
});

describe("the month header row and the grid agree about where the week starts", () => {
  it("builds its labels from a Monday", () => {
    // The labels come from `new Date(2024, 0, 1 + i)`. If that date is not a
    // Monday every label sits over the wrong column, and nothing on screen
    // says so — the dates are still right, so it reads as a real calendar.
    expect(new Date(2024, 0, 1).getDay()).toBe(1);
    expect(calendar()).toMatch(/new Date\(2024, 0, 1 \+ i\)/);
  });

  it("agrees with the grid's own leading blanks", () => {
    // `calendarWindow` decides which column the 1st lands in. Header labels
    // start at Monday, so a month starting on a Wednesday must leave exactly
    // two blanks. October 2025 starts on a Wednesday.
    expect(calendarWindow("2025-10-14", "month").leadingBlanks).toBe(2);
    // And a month starting on a Sunday leaves six, not zero — Sunday is the
    // END of this grid's week, which is the case an off-by-one gets wrong.
    expect(calendarWindow("2026-02-10", "month").leadingBlanks).toBe(6);
    // A week never has blanks at all; it starts on its own Monday.
    expect(calendarWindow("2025-10-14", "week").leadingBlanks).toBe(0);
    expect(new Date(`${calendarWindow("2025-10-14", "week").from}T00:00:00`).getDay()).toBe(1);
  });

  it("keeps the weekday out of the month's cells", () => {
    const src = calendar();
    // The whole reason seven columns fit at 320px. If the per-cell weekday
    // comes back, the cell needs about twice the width it has.
    expect(src).toMatch(/\{!isMonth && \(\s*<span className="text-3xs uppercase/);
    expect(src).toMatch(/WEEKDAY_LABELS/);
  });

  it("headers the same number of columns the grid draws", () => {
    const src = calendar();
    // Both the header row and the month grid derive their count from `cols`,
    // so hiding weekends narrows them together. Five labels over seven columns
    // would misalign the entire month. A hardcoded `grid-cols-7` on the header
    // is the regression this catches, so the assertion is that the header's
    // own className branches on `cols` — not merely that "grid-cols-7" appears
    // somewhere near it.
    const header = src.slice(src.indexOf("{isMonth && ("));
    expect(header.slice(0, header.indexOf("</div>"))).toMatch(
      /cols === 5 \? "grid-cols-5" : "grid-cols-7"/,
    );
    expect(src).toMatch(/hideWeekends \? WEEKDAY_LABELS\.slice\(0, 5\) : WEEKDAY_LABELS/);
  });
});

describe("the footer does not promise a gesture a phone cannot make", () => {
  it("no longer tells the reader to hover", () => {
    // CLAUDE.md: nothing important is hover-only. The hover card is a
    // shortcut, not the only route — tapping a chip opens the visit — so the
    // fix is to the sentence, not to the card.
    expect(calendar()).not.toMatch(/Hover a visit/i);
  });

  it("points at the two things that work with a finger", () => {
    const src = calendar();
    expect(src).toMatch(/Open a visit for who\s+and where, or the date for that day/);
  });
});

describe("the calendar reaches the phone at all", () => {
  const routes = () => codeOnly(read("src/routes/_authenticated/routes.tsx"));

  it("is not wrapped in a desktop-only container", () => {
    const src = routes();
    const at = src.indexOf("<ScheduleCalendar");
    expect(at).toBeGreaterThan(0);
    // The page hides things from phones with `max-md:hidden` and shows the
    // `MobileDayList` with `md:hidden`. If a future edit puts the calendar
    // behind the former, this whole file becomes decorative: the component
    // would be perfectly responsive and never rendered at a phone width.
    const enclosing = src.slice(Math.max(0, at - 600), at);
    expect(enclosing.slice(enclosing.lastIndexOf("<div"))).not.toMatch(/max-md:hidden/);
  });

  it("still renders the calendar for every non-today range", () => {
    // Not `range === "week"`. Guarding on the ranges rather than on the
    // viewport is what keeps a phone from getting a blank panel on month.
    expect(routes()).toMatch(/\{range !== "today" && \(/);
  });
});
