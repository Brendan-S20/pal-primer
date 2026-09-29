// Nobody was on the clock, because there was no clock.
//
// The arithmetic behind the time clock, pinned. A timesheet is money: an hour
// put on the wrong day moves overtime between weeks, and an hour lost on the
// night the clocks go back is an hour somebody is not paid for. Every case
// below is one of those, stated as the day and the hours a person would
// expect to see, on the org's clock, whatever machine runs this suite.

import { describe, expect, it } from "vitest";
import {
  addDays,
  buildTimesheet,
  formatDuration,
  hoursDecimal,
  minutesBetween,
  minutesOnDay,
  mondayOf,
  orgLocalStamp,
  orgMidnight,
  orgTimeInputValue,
  orgWallTimeToInstant,
  OVERTIME_THRESHOLD_MINUTES,
  splitByOrgDay,
  timesheetCsvRows,
  weekDays,
  type ClockEntry,
} from "@/lib/time-clock";
import {
  clockCollision,
  holdClockUntilRefetched,
  queuedClockTaps,
  withQueuedClock,
} from "@/lib/offline/queued-clock-state";
import type { PendingAction } from "@/lib/offline/queue";

const CHI = "America/Chicago";
const at = (iso: string) => Date.parse(iso);
const entry = (
  id: string,
  clock_in: string,
  clock_out: string | null,
  staff_id = "s1",
): ClockEntry => ({ id, staff_id, clock_in, clock_out });

describe("the calendar the timesheet is drawn on", () => {
  it("counts minutes between instants, never negative", () => {
    expect(minutesBetween("2026-09-21T13:00:00Z", "2026-09-21T21:30:00Z")).toBe(510);
    expect(minutesBetween("2026-09-21T21:30:00Z", "2026-09-21T13:00:00Z")).toBe(0);
    expect(minutesBetween("nonsense", "2026-09-21T13:00:00Z")).toBe(0);
  });

  it("starts a payroll week on Monday, and a Sunday belongs to the week before", () => {
    expect(mondayOf("2026-09-21")).toBe("2026-09-21"); // Monday
    expect(mondayOf("2026-09-24")).toBe("2026-09-21"); // Thursday
    expect(mondayOf("2026-09-27")).toBe("2026-09-21"); // Sunday
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2027-01-02")).toBe("2026-12-28"); // across a year
    expect(weekDays("2026-09-21")).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("finds the org's midnight on both sides of daylight saving", () => {
    // CDT, UTC-5
    expect(new Date(orgMidnight("2026-07-15", CHI)).toISOString()).toBe("2026-07-15T05:00:00.000Z");
    // CST, UTC-6
    expect(new Date(orgMidnight("2026-01-15", CHI)).toISOString()).toBe("2026-01-15T06:00:00.000Z");
    // The spring-forward day starts in CST and the day after in CDT.
    expect(new Date(orgMidnight("2026-03-08", CHI)).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(new Date(orgMidnight("2026-03-09", CHI)).toISOString()).toBe("2026-03-09T05:00:00.000Z");
    // The fall-back day starts in CDT and the day after in CST: a 25-hour day.
    expect(new Date(orgMidnight("2026-11-01", CHI)).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(new Date(orgMidnight("2026-11-02", CHI)).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    // A zone the other side of Greenwich, whose transitions fall at a
    // different UTC hour.
    expect(new Date(orgMidnight("2026-10-25", "Europe/London")).toISOString()).toBe(
      "2026-10-24T23:00:00.000Z",
    );
    expect(new Date(orgMidnight("2026-10-26", "Europe/London")).toISOString()).toBe(
      "2026-10-26T00:00:00.000Z",
    );
  });

  it("turns what the office typed into the instant it meant, and back", () => {
    const ms = orgWallTimeToInstant("2026-09-21", "07:42", CHI);
    expect(new Date(ms).toISOString()).toBe("2026-09-21T12:42:00.000Z");
    expect(orgTimeInputValue(ms, CHI)).toEqual({ day: "2026-09-21", time: "07:42" });
    const winter = orgWallTimeToInstant("2026-12-01", "16:05", CHI);
    expect(new Date(winter).toISOString()).toBe("2026-12-01T22:05:00.000Z");
    expect(orgLocalStamp(winter, CHI)).toBe("2026-12-01 16:05");
    expect(orgLocalStamp(orgMidnight("2026-12-02", CHI), CHI)).toBe("2026-12-02 00:00");
  });
});

describe("a shift is cut at the org's midnight", () => {
  it("puts a 9pm-to-1am shift three hours on one day and one on the next", () => {
    // 21:00 CDT Sep 21 = 02:00Z Sep 22; 01:00 CDT Sep 22 = 06:00Z.
    const segs = splitByOrgDay(entry("e", "2026-09-22T02:00:00Z", "2026-09-22T06:00:00Z"), CHI, 0);
    expect(segs.map((s) => [s.day, s.minutes])).toEqual([
      ["2026-09-21", 180],
      ["2026-09-22", 60],
    ]);
    expect(segs[0].continuesIntoNextDay).toBe(true);
    expect(segs[1].continuesFromPreviousDay).toBe(true);
    // A UTC split would have called all four hours Sep 22.
  });

  it("pays the repeated hour on the night the clocks go back", () => {
    // Sat Oct 31 22:00 CDT (03:00Z Nov 1) to Sun Nov 1 06:00 CST (12:00Z).
    // Eight hours on the wall, nine in fact.
    const segs = splitByOrgDay(entry("e", "2026-11-01T03:00:00Z", "2026-11-01T12:00:00Z"), CHI, 0);
    expect(segs.map((s) => [s.day, s.minutes])).toEqual([
      ["2026-10-31", 120],
      ["2026-11-01", 420],
    ]);
    expect(segs.reduce((n, s) => n + s.minutes, 0)).toBe(540);
  });

  it("does not pay the hour that never happened when they spring forward", () => {
    // Sat Mar 7 22:00 CST (04:00Z Mar 8) to Sun Mar 8 06:00 CDT (11:00Z).
    // Eight hours on the wall, seven in fact.
    const segs = splitByOrgDay(entry("e", "2026-03-08T04:00:00Z", "2026-03-08T11:00:00Z"), CHI, 0);
    expect(segs.map((s) => [s.day, s.minutes])).toEqual([
      ["2026-03-07", 120],
      ["2026-03-08", 300],
    ]);
  });

  it("counts an open shift up to now, and only today's part of it on today", () => {
    // Clocked in 22:00 CDT yesterday (Sep 21), still on at 09:30 CDT today.
    const now = at("2026-09-22T14:30:00Z");
    const open = entry("e", "2026-09-22T03:00:00Z", null);
    const segs = splitByOrgDay(open, CHI, now);
    expect(segs.map((s) => [s.day, s.minutes, s.open])).toEqual([
      ["2026-09-21", 120, true],
      ["2026-09-22", 570, true],
    ]);
    expect(minutesOnDay([open], "2026-09-22", CHI, now)).toBe(570);
    expect(minutesOnDay([open], "2026-09-21", CHI, now)).toBe(120);
  });

  it("yields nothing for a row whose end is before its start", () => {
    expect(splitByOrgDay(entry("e", "2026-09-22T06:00:00Z", "2026-09-22T02:00:00Z"), CHI, 0)).toEqual(
      [],
    );
  });

  it("adds a day's shifts up across a lunch break", () => {
    const day = [
      entry("a", "2026-09-21T12:42:00Z", "2026-09-21T17:00:00Z"), // 7:42 to 12:00
      entry("b", "2026-09-21T17:30:00Z", "2026-09-21T21:10:00Z"), // 12:30 to 4:10
    ];
    expect(minutesOnDay(day, "2026-09-21", CHI, 0)).toBe(258 + 220);
  });
});

describe("the week", () => {
  const MONDAY = "2026-09-21";
  const staff = [
    { id: "s1", display_name: "Maximilian Alexander Fitzgerald-Worthington III" },
    { id: "s2", display_name: "Wen Zhang" },
    { id: "s3", display_name: "Kai Ortiz" },
  ];
  /** 7:00 to 16:00 CDT on each of `n` weekdays starting Monday: nine hours. */
  const nineHourDays = (n: number, staffId: string) =>
    Array.from({ length: n }, (_, i) =>
      entry(
        `${staffId}-${i}`,
        `${addDays(MONDAY, i)}T12:00:00Z`,
        `${addDays(MONDAY, i)}T21:00:00Z`,
        staffId,
      ),
    );

  it("flags overtime past forty hours, and only the part past forty", () => {
    const sheet = buildTimesheet({
      weekStart: MONDAY,
      tz: CHI,
      now: at("2026-09-28T12:00:00Z"),
      staff,
      entries: [...nineHourDays(5, "s1"), ...nineHourDays(4, "s2")],
      visits: [],
    });
    const [a, b, c] = sheet.rows;
    expect(a.totalMinutes).toBe(45 * 60);
    expect(a.overtimeMinutes).toBe(5 * 60);
    expect(b.totalMinutes).toBe(36 * 60);
    expect(b.overtimeMinutes).toBe(0);
    // A person with no time still has a row: an empty row is the forgotten
    // clock-in the office needs to see.
    expect(c.totalMinutes).toBe(0);
    expect(c.days).toHaveLength(7);
    expect(sheet.totalMinutes).toBe(81 * 60);
    expect(sheet.overtimeMinutes).toBe(5 * 60);
    expect(OVERTIME_THRESHOLD_MINUTES).toBe(2400);
  });

  it("takes only this week's part of a shift that crosses into it or out of it", () => {
    const sheet = buildTimesheet({
      weekStart: MONDAY,
      tz: CHI,
      now: at("2026-09-30T12:00:00Z"),
      staff,
      entries: [
        // Sunday Sep 20 22:00 CDT to Monday Sep 21 02:00 CDT: 2h belong here.
        entry("x", "2026-09-21T03:00:00Z", "2026-09-21T07:00:00Z", "s1"),
        // Sunday Sep 27 23:00 CDT to Monday Sep 28 01:00 CDT: 1h belongs here.
        entry("y", "2026-09-28T04:00:00Z", "2026-09-28T06:00:00Z", "s1"),
      ],
      visits: [],
    });
    const row = sheet.rows[0];
    expect(row.days[0].minutes).toBe(120);
    expect(row.days[6].minutes).toBe(60);
    expect(row.totalMinutes).toBe(180);
  });

  it("counts a visit on the org day it was completed, not the UTC day", () => {
    const sheet = buildTimesheet({
      weekStart: MONDAY,
      tz: CHI,
      now: at("2026-09-28T12:00:00Z"),
      staff,
      entries: [],
      visits: [
        // 03:00Z Tuesday is 22:00 Monday in Chicago.
        { assigned_staff_id: "s2", completed_at: "2026-09-22T03:00:00Z" },
        { assigned_staff_id: "s2", completed_at: "2026-09-22T15:00:00Z" },
        // Next week, and nobody's.
        { assigned_staff_id: "s2", completed_at: "2026-09-29T15:00:00Z" },
        { assigned_staff_id: null, completed_at: "2026-09-22T15:00:00Z" },
      ],
    });
    const wen = sheet.rows[1];
    expect(wen.days[0].visitsCompleted).toBe(1);
    expect(wen.days[1].visitsCompleted).toBe(1);
    expect(wen.visitsCompleted).toBe(2);
  });

  it("adds a DST week up to the hours actually worked", () => {
    // Mon Oct 26 to Sun Nov 1: the week the clocks go back.
    const sheet = buildTimesheet({
      weekStart: "2026-10-26",
      tz: CHI,
      now: at("2026-11-05T12:00:00Z"),
      staff,
      entries: [entry("n", "2026-11-01T03:00:00Z", "2026-11-01T12:00:00Z", "s3")],
      visits: [],
    });
    expect(sheet.rows[2].totalMinutes).toBe(540);
    expect(sheet.rows[2].days[5].minutes).toBe(120); // Saturday
    expect(sheet.rows[2].days[6].minutes).toBe(420); // Sunday, 25 hours long
  });

  it("marks who is on the clock and counts them up to now", () => {
    const sheet = buildTimesheet({
      weekStart: MONDAY,
      tz: CHI,
      now: at("2026-09-23T15:00:00Z"), // Wednesday 10:00 CDT
      staff,
      entries: [entry("o", "2026-09-23T12:00:00Z", null, "s2")],
      visits: [],
    });
    expect(sheet.rows[1].onTheClock).toBe(true);
    expect(sheet.rows[1].days[2].minutes).toBe(180);
    expect(sheet.rows[0].onTheClock).toBe(false);
  });
});

describe("the payroll export adds up", () => {
  const sheet = buildTimesheet({
    weekStart: "2026-09-21",
    tz: CHI,
    now: at("2026-09-28T12:00:00Z"),
    staff: [
      { id: "s1", display_name: "=HYPERLINK(evil)" },
      { id: "s2", display_name: "Wen Zhang" },
    ],
    entries: [
      entry("a", "2026-09-21T12:42:00Z", "2026-09-21T17:00:00Z", "s1"),
      entry("b", "2026-09-21T17:30:00Z", "2026-09-21T21:10:00Z", "s1"),
      entry("c", "2026-09-23T02:00:00Z", "2026-09-23T06:07:00Z", "s1"), // across midnight
    ],
    visits: [
      { assigned_staff_id: "s1", completed_at: "2026-09-21T15:00:00Z" },
      { assigned_staff_id: "s1", completed_at: "2026-09-21T19:00:00Z" },
      // Wen completed a visit and never clocked in.
      { assigned_staff_id: "s2", completed_at: "2026-09-24T15:00:00Z" },
    ],
  });
  const rows = timesheetCsvRows(sheet, CHI);

  it("writes one row per shift per day, two for a shift across midnight", () => {
    expect(rows.filter((r) => r[0] === "=HYPERLINK(evil)")).toHaveLength(4);
    const crossing = rows.filter((r) => r[4] && (r[1] === "2026-09-22" || r[1] === "2026-09-23"));
    expect(crossing.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([
      ["2026-09-22", "2026-09-22 21:00", "2026-09-23 00:00", "3.00"],
      ["2026-09-23", "2026-09-23 00:00", "2026-09-23 01:07", "1.12"],
    ]);
  });

  it("sums to the week's hours and visits", () => {
    const hours = rows.reduce((n, r) => n + Number(r[4]), 0);
    expect(hours).toBeCloseTo(sheet.totalMinutes / 60, 1);
    const visits = rows.reduce((n, r) => n + (r[5] ? Number(r[5]) : 0), 0);
    expect(visits).toBe(3);
  });

  it("keeps the visits of a day with no time on the clock", () => {
    const wen = rows.filter((r) => r[0] === "Wen Zhang");
    // "0.00" before the note is the Tips column: written on a day's first
    // row like Visits, so it is present (and zero) here.
    expect(wen).toEqual([
      ["Wen Zhang", "2026-09-24", "", "", "0.00", "1", "0.00", "No time recorded"],
    ]);
  });

  it("prints durations the way a person reads them", () => {
    expect(formatDuration(192)).toBe("3h 12m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(-3)).toBe("0m");
    expect(hoursDecimal(495)).toBe("8.25");
  });
});

// ── what My Day shows while a tap is in the offline queue ──────────────────

const tapAction = (id: string, kind: "clock_in" | "clock_out", iso: string, userId = "u1") =>
  ({ id, kind, ts: at(iso), userId }) as PendingAction;

describe("a queued tap moves the clock at once", () => {
  it("opens a shift at the TAP time when the server has none", () => {
    const taps = queuedClockTaps([tapAction("t1", "clock_in", "2026-09-21T12:02:00Z")]);
    const shown = withQueuedClock([], taps);
    expect(shown.open?.clock_in).toBe("2026-09-21T12:02:00.000Z");
    expect(shown.queued).toBe("clock_in");
  });

  it("closes the server's open shift at the tap time", () => {
    const server = [entry("e", "2026-09-21T12:00:00Z", null)];
    const shown = withQueuedClock(server, [
      { id: "t", kind: "clock_out", at: at("2026-09-21T21:10:00Z") },
    ]);
    expect(shown.open).toBeNull();
    expect(shown.entries[0].clock_out).toBe("2026-09-21T21:10:00.000Z");
    expect(minutesOnDay(shown.entries, "2026-09-21", CHI, 0)).toBe(550);
    // The server's copy is not mutated.
    expect(server[0].clock_out).toBeNull();
  });

  it("follows the server's rules: a second clock-in and a stray clock-out change nothing", () => {
    const server = [entry("e", "2026-09-21T12:00:00Z", null)];
    const shown = withQueuedClock(server, [
      { id: "t1", kind: "clock_in", at: at("2026-09-21T13:00:00Z") },
    ]);
    expect(shown.entries).toHaveLength(1);
    expect(shown.queued).toBeNull();
    const off = withQueuedClock([], [{ id: "t2", kind: "clock_out", at: at("2026-09-21T13:00:00Z") }]);
    expect(off.entries).toHaveLength(0);
  });

  it("replays in, out, in as a lunch break", () => {
    const shown = withQueuedClock([], [
      { id: "1", kind: "clock_in", at: at("2026-09-21T12:00:00Z") },
      { id: "2", kind: "clock_out", at: at("2026-09-21T17:00:00Z") },
      { id: "3", kind: "clock_in", at: at("2026-09-21T17:30:00Z") },
    ]);
    expect(shown.entries).toHaveLength(2);
    expect(shown.open?.clock_in).toBe("2026-09-21T17:30:00.000Z");
    expect(minutesOnDay(shown.entries, "2026-09-21", CHI, at("2026-09-21T18:30:00Z"))).toBe(360);
  });

  it("holds a tap after the replay until the clock has been fetched again", () => {
    const tap = { id: "t", kind: "clock_in" as const, at: 1000 };
    // Replay deleted it at t=5000; the data is from t=4000.
    const held = holdClockUntilRefetched([tap], [], 4000, 5000);
    expect(held).toEqual([{ ...tap, leftQueueAt: 5000 }]);
    // Still held on the next pass with the same data...
    expect(holdClockUntilRefetched(held, [], 4000, 6000)).toHaveLength(1);
    // ...and released once the clock was fetched after it left.
    expect(holdClockUntilRefetched(held, [], 5500, 7000)).toEqual([]);
    // A held tap is drawn but no longer says it is waiting to sync.
    expect(withQueuedClock([], held).queued).toBeNull();
  });

  it("treats a double tap as one tap, and an alternation as several", () => {
    const q = [tapAction("a", "clock_in", "2026-09-21T12:00:00Z")];
    expect(clockCollision(q, { kind: "clock_in", userId: "u1" })?.id).toBe("a");
    expect(clockCollision(q, { kind: "clock_out", userId: "u1" })).toBeNull();
    // Another person's tap on a shared tablet is not this person's duplicate.
    expect(clockCollision(q, { kind: "clock_in", userId: "u2" })).toBeNull();
    const alt = [...q, tapAction("b", "clock_out", "2026-09-21T17:00:00Z")];
    expect(clockCollision(alt, { kind: "clock_in", userId: "u1" })).toBeNull();
  });
});
