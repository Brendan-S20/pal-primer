// The arithmetic of the time clock, kept apart from the database and the
// screen so every rule here can be tested without either.
//
// ── WHICH DAY DOES AN HOUR BELONG TO ─────────────────────────────────────────
//
// The organization's. A shift is two instants, and a timesheet is a grid of
// calendar days, so every entry has to be cut into the days it touched — and
// "day" means the org's calendar, never the server's (UTC) or the device's.
// A tech who clocks in at 9pm Saturday and out at 1am Sunday worked three
// hours on Saturday and one on Sunday, on the org's clock, whatever timezone
// the laptop reading the sheet is in. org-day.ts is where that rule lives for
// the rest of the product; this file adds the one thing it lacks, which is
// the instant a given org day STARTS, because that is where a shift is cut.
//
// ── WHY MIDNIGHT HAS TO BE FOUND, NOT COMPUTED ───────────────────────────────
//
// A day is not 24 hours twice a year. On the night the clocks go back the org
// day is 25 hours long, and a shift from 10pm to 6am is nine hours of work
// that a wall-clock subtraction calls eight. So nothing here subtracts wall
// clocks. Durations are instants minus instants; days are cut at the instant
// the org's midnight occurs, found by asking Intl what the offset is there.
//
// ── MINUTES, NOT ROUNDED UNTIL THEY ARE PRINTED ──────────────────────────────
//
// Every duration is carried as fractional minutes and summed before rounding.
// Rounding each shift first and summing the rounded values drifts: forty
// shifts of 7m29s are 299 minutes, not 280.

import { orgLocalDay } from "@/lib/org-day";

/** Over this many minutes in the org's Monday-to-Sunday week is overtime. The
 *  US federal rule (FLSA): forty hours in a workweek. */
export const OVERTIME_THRESHOLD_MINUTES = 40 * 60;

export type ClockEntry = {
  id: string;
  staff_id: string;
  clock_in: string;
  /** Null while the shift is still running. */
  clock_out: string | null;
  clock_in_source?: string;
  clock_out_source?: string | null;
  note?: string | null;
  edited_at?: string | null;
};

/** One entry's share of one org day. */
export type DaySegment = {
  entryId: string;
  day: string;
  /** Instants, ms since epoch. */
  start: number;
  end: number;
  minutes: number;
  /** The shift has no clock-out yet; `end` is "now". */
  open: boolean;
  /** This segment begins at the org's midnight rather than at the clock-in. */
  continuesFromPreviousDay: boolean;
  /** This segment ends at the org's midnight rather than at the clock-out. */
  continuesIntoNextDay: boolean;
};

const toMs = (v: string | number | Date): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);

/** Minutes between two instants; never negative. Fractional. */
export function minutesBetween(a: string | number | Date, b: string | number | Date): number {
  const d = toMs(b) - toMs(a);
  return Number.isFinite(d) && d > 0 ? d / 60_000 : 0;
}

/** "YYYY-MM-DD" plus `n` calendar days. Pure date arithmetic, no timezone. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday on or before `day` — the start of its payroll week. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

/** The seven org days of the week that starts on `monday`. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far the org's wall clock is ahead of UTC at instant `ms`, in ms. */
function offsetAt(ms: number, tz: string): number {
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    offsetFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get("hour") % 24; // some engines print 24 for midnight
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the org's wall clock reads `hh:mm` on `day`.
 *
 * Two passes, because the offset to subtract is the one in force at the
 * ANSWER, which is what we are looking for: the first guess uses the offset
 * at the UTC reading of the wall time, the second corrects it with the offset
 * at the first guess. That converges for every zone whose transitions are
 * not at the requested time. A wall time that does not exist (inside a
 * spring-forward gap, 2:30 AM on the second Sunday of March in Chicago)
 * resolves to a neighbouring real instant an hour away; no midnight in any US
 * zone is in a gap, so the day boundaries this file cuts at are exact.
 */
export function orgWallTimeToInstant(day: string, hhmm: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  let guess = wall - offsetAt(wall, tz);
  guess = wall - offsetAt(guess, tz);
  return guess;
}

/** The instant the org's `day` begins. */
export function orgMidnight(day: string, tz: string): number {
  return orgWallTimeToInstant(day, "00:00", tz);
}

/**
 * Cut one shift into the org days it touched.
 *
 * An open shift runs to `now`. A shift with its clock-out before its clock-in
 * — which the database refuses, so only a corrupt read could produce — yields
 * nothing rather than negative hours.
 */
export function splitByOrgDay(entry: ClockEntry, tz: string, now: number): DaySegment[] {
  const start = toMs(entry.clock_in);
  const open = entry.clock_out == null;
  const end = open ? Math.max(start, now) : toMs(entry.clock_out!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: DaySegment[] = [];
  let day = orgLocalDay(start, tz);
  let segStart = start;
  // Bounded: a shift longer than the 7-day replay window is already a bug,
  // and a loop over a corrupt year-long row should not hang a page.
  for (let guard = 0; guard < 400 && segStart < end; guard++) {
    const nextMidnight = orgMidnight(addDays(day, 1), tz);
    const segEnd = Math.min(end, nextMidnight);
    if (segEnd > segStart) {
      out.push({
        entryId: entry.id,
        day,
        start: segStart,
        end: segEnd,
        minutes: (segEnd - segStart) / 60_000,
        open,
        continuesFromPreviousDay: segStart !== start,
        continuesIntoNextDay: segEnd !== end,
      });
    }
    segStart = segEnd;
    day = addDays(day, 1);
  }
  return out;
}

/** Minutes worked on one org day, across every entry given. Open entries
 *  count up to `now`. */
export function minutesOnDay(
  entries: readonly ClockEntry[],
  day: string,
  tz: string,
  now: number,
): number {
  let total = 0;
  for (const e of entries) {
    for (const s of splitByOrgDay(e, tz, now)) if (s.day === day) total += s.minutes;
  }
  return total;
}

/** "3h 12m", "45m", "0m". Rounded to the minute here and nowhere earlier. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** Decimal hours for payroll, "8.25". Payroll systems take hours, not h:mm. */
export function hoursDecimal(minutes: number): string {
  return (Math.max(0, Math.round(minutes)) / 60).toFixed(2);
}

// ── the week ────────────────────────────────────────────────────────────────

export type TimesheetStaff = { id: string; display_name: string; active?: boolean };
export type CompletedVisit = { assigned_staff_id: string | null; completed_at: string | null };
/** A tip credited to somebody: `payments.tip_staff_id`, dated by when the
 *  payment carrying it was received (`paid_at`), on the org's calendar. */
export type ReceivedTip = {
  tip_staff_id: string | null;
  tip_cents: number | null;
  paid_at: string | null;
};

export type TimesheetDay = {
  day: string;
  minutes: number;
  segments: DaySegment[];
  visitsCompleted: number;
  /** Tips credited to this person on payments received this day. */
  tipsCents: number;
};

export type TimesheetRow = {
  staff: TimesheetStaff;
  days: TimesheetDay[];
  totalMinutes: number;
  overtimeMinutes: number;
  visitsCompleted: number;
  tipsCents: number;
  /** Somebody is on the clock right now. */
  onTheClock: boolean;
};

export type Timesheet = {
  weekStart: string;
  days: string[];
  rows: TimesheetRow[];
  totalMinutes: number;
  overtimeMinutes: number;
  tipsCents: number;
};

/**
 * One row per person for the week that starts on `weekStart`.
 *
 * Entries that began the Sunday before and ran past midnight contribute only
 * their Monday part; the same is true at the other end. Visits count on the
 * org day of their `completed_at`, the same day rule as the hours beside them.
 *
 * Who gets a row: everyone passed in `staff`. The caller decides that list
 * (the active field team, plus anyone with hours this week) because "a person
 * who should have clocked in and did not" is exactly what an empty row shows.
 */
export function buildTimesheet(input: {
  weekStart: string;
  tz: string;
  now: number;
  staff: readonly TimesheetStaff[];
  entries: readonly ClockEntry[];
  visits: readonly CompletedVisit[];
  /** Tips credited this week. Optional so a caller with none passes nothing. */
  tips?: readonly ReceivedTip[];
}): Timesheet {
  const days = weekDays(input.weekStart);
  const inWeek = new Set(days);
  const rows: TimesheetRow[] = input.staff.map((s) => ({
    staff: s,
    days: days.map((day) => ({ day, minutes: 0, segments: [], visitsCompleted: 0, tipsCents: 0 })),
    totalMinutes: 0,
    overtimeMinutes: 0,
    visitsCompleted: 0,
    tipsCents: 0,
    onTheClock: false,
  }));
  const byStaff = new Map(rows.map((r) => [r.staff.id, r]));
  const index = new Map(days.map((d, i) => [d, i]));

  for (const e of input.entries) {
    const row = byStaff.get(e.staff_id);
    if (!row) continue;
    if (e.clock_out == null) row.onTheClock = true;
    for (const seg of splitByOrgDay(e, input.tz, input.now)) {
      if (!inWeek.has(seg.day)) continue;
      const cell = row.days[index.get(seg.day)!];
      cell.segments.push(seg);
      cell.minutes += seg.minutes;
      row.totalMinutes += seg.minutes;
    }
  }
  for (const v of input.visits) {
    if (!v.assigned_staff_id || !v.completed_at) continue;
    const row = byStaff.get(v.assigned_staff_id);
    const i = index.get(orgLocalDay(v.completed_at, input.tz));
    if (!row || i == null) continue;
    row.days[i].visitsCompleted += 1;
    row.visitsCompleted += 1;
  }
  // Tips on the org day the payment arrived, the same day rule as the hours
  // and visits beside them. A tip with nobody against it (no completed visit
  // on the invoice) is not anybody's pay and is left to the invoice and the
  // Tips received report.
  for (const t of input.tips ?? []) {
    const cents = Math.max(0, Math.round(Number(t.tip_cents ?? 0)));
    if (!t.tip_staff_id || !t.paid_at || cents <= 0) continue;
    const row = byStaff.get(t.tip_staff_id);
    const i = index.get(orgLocalDay(t.paid_at, input.tz));
    if (!row || i == null) continue;
    row.days[i].tipsCents += cents;
    row.tipsCents += cents;
  }
  let totalMinutes = 0;
  let overtimeMinutes = 0;
  let tipsCents = 0;
  for (const r of rows) {
    for (const d of r.days) d.segments.sort((a, b) => a.start - b.start);
    r.overtimeMinutes = Math.max(0, r.totalMinutes - OVERTIME_THRESHOLD_MINUTES);
    totalMinutes += r.totalMinutes;
    overtimeMinutes += r.overtimeMinutes;
    tipsCents += r.tipsCents;
  }
  return { weekStart: input.weekStart, days, rows, totalMinutes, overtimeMinutes, tipsCents };
}

// ── the export ──────────────────────────────────────────────────────────────

export const TIMESHEET_CSV_HEADERS = [
  "Staff",
  "Date",
  "Clock in",
  "Clock out",
  "Hours",
  "Visits completed",
  "Tips",
  "Notes",
] as const;

/** "12.50" -- dollars with two decimals and no symbol, which is what a
 *  spreadsheet sums without being told the column is currency. */
export function csvDollars(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}

const localStampFormatters = new Map<string, Intl.DateTimeFormat>();

/** "2026-09-21 07:42" on the org's clock — sortable, and what a spreadsheet
 *  parses as a date-time without being told a format. */
export function orgLocalStamp(ms: number, tz: string): string {
  let f = localStampFormatters.get(tz);
  if (!f) {
    // Assembled from parts, so the locale only has to give numeric parts; it
    // is deliberately not en-CA, which is org-day.ts's one definition of the
    // org's calendar day (tests/org-day.test.ts keeps it the only one).
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localStampFormatters.set(tz, f);
  }
  const p = f.formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

/**
 * Payroll inputs, one row per shift per day.
 *
 * Built so the columns ADD UP: a shift crossing midnight is two rows, each
 * with its own day's hours, and a day's completed visits are written once — on
 * its first row — so summing Visits gives the week's visits and summing Hours
 * gives the week's hours, to within each row's rounding to two decimals. A day with visits and no clocked
 * time still gets a row, with no times and zero hours, because a person who
 * completed six visits without clocking in is the row an owner most needs to
 * see before running payroll.
 *
 * Tips follow the visits rule exactly: a day's tips are written once, on its
 * first row, so summing the column gives the week's tips; and a day with tips
 * and no clocked time still gets a row, because a tip is pay whether or not
 * the shift was recorded.
 */
export function timesheetCsvRows(sheet: Timesheet, tz: string): string[][] {
  const out: string[][] = [];
  for (const row of sheet.rows) {
    for (const d of row.days) {
      if (d.segments.length === 0) {
        if (d.visitsCompleted > 0 || d.tipsCents > 0) {
          out.push([
            row.staff.display_name,
            d.day,
            "",
            "",
            "0.00",
            String(d.visitsCompleted),
            csvDollars(d.tipsCents),
            "No time recorded",
          ]);
        }
        continue;
      }
      d.segments.forEach((s, i) => {
        const notes: string[] = [];
        if (s.open) notes.push("Still clocked in");
        if (s.continuesFromPreviousDay) notes.push("Continued from the previous day");
        if (s.continuesIntoNextDay) notes.push("Continues past midnight");
        out.push([
          row.staff.display_name,
          d.day,
          orgLocalStamp(s.start, tz),
          s.open && !s.continuesIntoNextDay ? "" : orgLocalStamp(s.end, tz),
          hoursDecimal(s.minutes),
          i === 0 ? String(d.visitsCompleted) : "",
          i === 0 ? csvDollars(d.tipsCents) : "",
          notes.join("; "),
        ]);
      });
    }
  }
  return out;
}

/** The instant an office form's "day + HH:MM" means, and back. */
export function orgTimeInputValue(ms: number | string, tz: string): { day: string; time: string } {
  const stamp = orgLocalStamp(toMs(ms), tz);
  return { day: stamp.slice(0, 10), time: stamp.slice(11, 16) };
}
