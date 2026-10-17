// A shift left open is asked about, and flagged, never closed (QA row 22, #438).
//
// Shifts sat open for 19 to 24 hours and nothing said so: My Day drew nothing
// while a tech was on the clock, clocking out from it took three taps (More,
// Time clock, Clock out), and Timesheets showed the hours as if they had been
// worked. Now My Day asks once a shift has been open 12 hours, with Clock out
// beside the question, and Timesheets marks the shift (and any closed shift
// over 16 hours) as a possible missed clock-out. Nothing closes a shift for
// anyone.
//
// The same page showed a tech with a full week of visits as "0m" and "0":
// they had not clocked in, and the visit count is by the day each visit was
// completed, while My Day counts the visits scheduled on a day. The row now
// says "No clock-ins", and the visit column shows both counts and says which
// is which.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTimesheet,
  LONG_CLOSED_SHIFT_MINUTES,
  LONG_SHIFT_PROMPT_MINUTES,
  possibleMissedClockOut,
  shouldAskStillWorking,
  timesheetCsvRows,
  type ClockEntry,
} from "@/lib/time-clock";

const CHI = "America/Chicago";
const at = (iso: string) => Date.parse(iso);
const entry = (
  id: string,
  clock_in: string,
  clock_out: string | null,
  staff_id = "s1",
): ClockEntry => ({ id, staff_id, clock_in, clock_out });
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("when a shift is asked about", () => {
  it("asks at 12 hours open, and not before", () => {
    expect(LONG_SHIFT_PROMPT_MINUTES).toBe(12 * 60);
    const open = entry("e1", "2026-09-21T12:00:00Z", null);
    expect(shouldAskStillWorking(open, at("2026-09-21T23:59:00Z"))).toBe(false);
    expect(shouldAskStillWorking(open, at("2026-09-22T00:00:00Z"))).toBe(true);
    // The QA case: open 19 hours.
    expect(shouldAskStillWorking(open, at("2026-09-22T07:00:00Z"))).toBe(true);
  });

  it("never asks about a closed shift, or no shift", () => {
    expect(
      shouldAskStillWorking(entry("e1", "2026-09-21T00:00:00Z", "2026-09-21T23:00:00Z"), at("2026-09-22T00:00:00Z")),
    ).toBe(false);
    expect(shouldAskStillWorking(null, Date.now())).toBe(false);
  });

  it("flags open shifts from 12 hours and closed ones over 16", () => {
    expect(LONG_CLOSED_SHIFT_MINUTES).toBe(16 * 60);
    const now = at("2026-09-23T00:00:00Z");
    expect(possibleMissedClockOut(entry("a", "2026-09-22T11:00:00Z", null), now)).toBe(true);
    expect(possibleMissedClockOut(entry("b", "2026-09-22T13:00:00Z", null), now)).toBe(false);
    expect(possibleMissedClockOut(entry("c", "2026-09-21T13:00:00Z", "2026-09-22T05:00:00Z"), now)).toBe(false); // 16h exactly
    expect(possibleMissedClockOut(entry("d", "2026-09-21T13:00:00Z", "2026-09-22T05:01:00Z"), now)).toBe(true);
  });
});

describe("the timesheet", () => {
  const week = "2026-09-21"; // a Monday
  const staff = [
    { id: "s1", display_name: "Open Shift" },
    { id: "s2", display_name: "Never Clocked" },
  ];

  it("marks the day and the person of a possible missed clock-out, and writes it in the CSV", () => {
    const sheet = buildTimesheet({
      weekStart: week,
      tz: CHI,
      // Open since 7:00 Tuesday Chicago (12:00Z), read 20 hours later.
      now: at("2026-09-23T08:00:00Z"),
      staff,
      entries: [entry("e1", "2026-09-22T12:00:00Z", null)],
      visits: [],
    });
    const row = sheet.rows[0];
    expect(row.possibleMissedClockOuts).toBe(1);
    expect(row.days[1].possibleMissedClockOut).toBe(true); // Tuesday
    expect(row.days[2].possibleMissedClockOut).toBe(true); // ran into Wednesday
    expect(row.days[0].possibleMissedClockOut).toBe(false);
    const csv = timesheetCsvRows(sheet, CHI);
    expect(csv.filter((r) => r[7].includes("Possible missed clock-out")).length).toBe(2);
  });

  it("tells a person who never clocked in from one who worked 0 minutes, and counts their scheduled visits", () => {
    const sheet = buildTimesheet({
      weekStart: week,
      tz: CHI,
      now: at("2026-09-27T12:00:00Z"),
      staff,
      entries: [entry("e1", "2026-09-22T12:00:00Z", "2026-09-22T20:00:00Z")],
      visits: [{ assigned_staff_id: "s2", completed_at: "2026-09-23T15:00:00Z" }],
      scheduled: [
        { assigned_staff_id: "s2", scheduled_on: "2026-09-22" },
        { assigned_staff_id: "s2", scheduled_on: "2026-09-23" },
        { assigned_staff_id: "s2", scheduled_on: "2026-09-30" }, // next week
      ],
    });
    const [worked, never] = sheet.rows;
    expect(worked.clockedIn).toBe(true);
    expect(worked.possibleMissedClockOuts).toBe(0);
    expect(never.clockedIn).toBe(false);
    expect(never.visitsScheduled).toBe(2);
    expect(never.visitsCompleted).toBe(1);
  });
});

describe("the screens", () => {
  it("My Day draws the question, in the tech's language, with Clock out beside it", () => {
    const clock = read("src/components/TimeClock.tsx");
    const prompt = clock.slice(clock.indexOf("export function StillWorkingPrompt"));
    expect(prompt).toMatch(/t\("clock\.stillWorking", \{ count: hours \}\)/);
    expect(prompt).toMatch(/clock\.tap\("clock_out"\)/);
    expect(prompt).toMatch(/LONG_SHIFT_PROMPT_MINUTES/);
    expect(read("src/routes/_authenticated/my-day.tsx")).toMatch(/<StillWorkingPrompt \/>/);
  });

  it("Timesheets says No clock-ins and labels both visit counts", () => {
    const page = read("src/routes/_authenticated/timesheets.tsx");
    expect(page).toMatch(/No clock-ins/);
    expect(page).toMatch(/scheduled: data\.scheduled/);
    expect(page).toMatch(/possible missed clock-out/i);
    const fn = read("src/lib/time-clock.functions.ts");
    expect(fn).toMatch(/\.select\("assigned_staff_id, scheduled_on"\)/);
  });
});
