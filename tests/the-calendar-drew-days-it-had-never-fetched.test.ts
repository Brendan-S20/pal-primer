// The schedule page fetched "selected day + 6" (week) or "+ 29" (month) while
// the grid drew from the Monday of that week, or the 1st of that month. Pick
// any day that isn't the start of its own window and the leading cells fall
// outside the query.
//
// With the old aggregate cells that read as quiet days. With per-visit chips it
// reads as days on which nobody is working — a dispatcher's cue to go and fill
// them, for work that is already booked.
//
// `calendarWindow` is now the single definition of the window: the page fetches
// from it and the calendar draws from it, so they cannot disagree.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calendarWindow } from "../src/components/schedule/ScheduleCalendar";

const ROOT = join(import.meta.dirname, "..");

describe("the fetched window is the drawn window", () => {
  it("starts a week on the Monday on or before the selected day", () => {
    // 2026-08-06 is a Thursday. The week it belongs to starts Monday the 3rd —
    // three days BEFORE the day that was previously used as the query start.
    const { from, to, days } = calendarWindow("2026-08-06", "week");
    expect(from).toBe("2026-08-03");
    expect(to).toBe("2026-08-09");
    expect(days).toHaveLength(7);
    expect(from < "2026-08-06").toBe(true);
  });

  it("starts a month on the 1st, not on the selected day", () => {
    const { from, to, days } = calendarWindow("2026-08-20", "month");
    expect(from).toBe("2026-08-01");
    expect(to).toBe("2026-08-31");
    expect(days).toHaveLength(31);
  });

  it("covers every drawn day, including the leading ones", () => {
    // The property that actually matters: no cell the grid renders may fall
    // outside [from, to].
    for (const day of ["2026-08-06", "2026-02-11", "2026-12-31", "2026-03-01"]) {
      for (const range of ["week", "month"] as const) {
        const { from, to, days } = calendarWindow(day, range);
        for (const d of days) {
          expect(d >= from, `${d} before window start ${from} (${day}/${range})`).toBe(true);
          expect(d <= to, `${d} after window end ${to} (${day}/${range})`).toBe(true);
        }
      }
    }
  });

  it("aligns month leading blanks to Monday", () => {
    // 2026-08-01 is a Saturday, so a Monday-aligned grid needs 5 blanks.
    expect(calendarWindow("2026-08-15", "month").leadingBlanks).toBe(5);
    // 2026-06-01 is a Monday — no blanks.
    expect(calendarWindow("2026-06-15", "month").leadingBlanks).toBe(0);
  });

  it("survives a month boundary without drifting into the next month", () => {
    const { days } = calendarWindow("2026-02-15", "month");
    expect(days[0]).toBe("2026-02-01");
    expect(days[days.length - 1]).toBe("2026-02-28");
    expect(days.every((d) => d.startsWith("2026-02"))).toBe(true);
  });
});

describe("the page fetches from that one definition", () => {
  const routes = readFileSync(join(ROOT, "src/routes/_authenticated/routes.tsx"), "utf8");
  const code = routes.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("derives the query window from calendarWindow", () => {
    expect(code).toMatch(/calendarWindow\(day,\s*range === "month" \? "month" : "week"\)/);
  });

  it("no longer builds the window by adding 6 or 29 days", () => {
    // The old shape: `d.setDate(d.getDate() + (range === "week" ? 6 : 29))`.
    expect(code).not.toMatch(/setDate\(\s*d\.getDate\(\)\s*\+\s*\(\s*range/);
  });

  it("queries on the window, not on the selected day", () => {
    expect(code).toMatch(/queryKey:\s*\["visits",\s*rangeStart,\s*rangeEnd\]/);
  });
});

describe("the calendar and the map show the same visits", () => {
  const routes = readFileSync(join(ROOT, "src/routes/_authenticated/routes.tsx"), "utf8");
  const code = routes.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("passes the filtered list to both panes", () => {
    // Two panes over one window showing different subsets would be worse than
    // one pane.
    expect(code).toMatch(/visits=\{shownVisits as any\}/); // calendar
    expect(code).toMatch(/visits=\{shownVisits\}/); // map
  });

  it("does not filter the drag-and-drop board", () => {
    // `persistColumn` writes the sequence for a whole lane from what it can
    // see. A filtered lane silently drops the hidden stops out of the ordering.
    const board = code.slice(code.indexOf("<DndContext"));
    expect(board).not.toMatch(/shownVisits/);
  });
});
