// Where an imported plan's schedule is walked from (#1069).
//
// A plan's visits are generated from subscriptions.started_on, its
// frequency and its weekdays. The old system's file can carry three dates
// to set it from: when the plan began there, its last completed visit and
// its next booked one. Any one of them may have been moved by hand once, so
// a date is trusted only when another agrees with it.

import type { ImportFrequency } from "@/lib/import-services";

const NO_VISIT = /^(-+|—|–|n\/?a|none|never|not yet|no visits?)$/i;

/** A last or next visit cell with "no visit" placeholders read as blank. */
export function noVisit(text: string | null): string | null {
  return text && NO_VISIT.test(text.trim()) ? null : text;
}

const DAY_MS = 86_400_000;
const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** True when two dates fall on the same regular schedule for the plan's
 *  frequency: the same weekday (or both on its days) in a week the
 *  interval lands on, the same day of the month (a short month's last day
 *  standing in for a later one), or a whole number of intervals of days. */
export function sameSchedule(
  a: string,
  b: string,
  f: {
    frequency: ImportFrequency["frequency"];
    intervalWeeks?: number | null;
    intervalDays?: number | null;
    weekdays?: readonly number[];
  },
): boolean {
  const days = f.weekdays ?? [];
  const onDays = (x: string) => (days.length ? days.includes(weekdayOf(x)) : true);
  switch (f.frequency) {
    case "monthly": {
      const [da, db] = [Number(a.slice(8, 10)), Number(b.slice(8, 10))];
      if (da === db) return true;
      const lastDay = (x: string) => {
        const dt = new Date(`${x}T00:00:00Z`);
        return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      };
      return (da === lastDay(a) && db > da) || (db === lastDay(b) && da > db);
    }
    case "every_n_days":
      return mod(dayNumber(a) - dayNumber(b), f.intervalDays ?? 1) === 0;
    case "twice_weekly":
      return onDays(a) && onDays(b);
    case "one_time":
      return true;
    default: {
      const n = f.frequency === "biweekly" ? 2 : (f.intervalWeeks ?? 1);
      // Weeks counted from a Monday (day 0 was a Thursday).
      const week = (x: string) => Math.floor((dayNumber(x) + 3) / 7);
      if (mod(week(a) - week(b), n) !== 0) return false;
      return days.length > 1 ? onDays(a) && onDays(b) : weekdayOf(a) === weekdayOf(b);
    }
  }
}

/** The date a plan's schedule is walked from, given the file's start date
 *  and the old system's last completed and next booked visit. One visit
 *  moved by hand (Nov 27 done on Nov 28 once) must not move every visit
 *  after it (Rigel, #1069), so a date is used only when another of the
 *  three agrees with it on the plan's frequency: the next visit first, then
 *  the last visit, then the start date. When no two agree, or there is only
 *  one to go on, the start date is the plan's own (a whole schedule moved
 *  since it began shows as the two visits agreeing without it). A visit off
 *  the chosen schedule is returned so the owner is told to move it. With no
 *  frequency in the file there is no schedule to check against, and the
 *  latest known date is used. */
export function planAnchor(p: {
  frequency: ImportFrequency["frequency"];
  intervalWeeks: number | null;
  intervalDays: number | null;
  weekdays: readonly number[];
  frequencyInFile: boolean;
  start: string | null;
  last: string | null;
  next: string | null;
}): {
  on: string | null;
  from: "next visit" | "last visit" | "start date" | null;
  off: { which: "last visit" | "next visit"; on: string }[];
} {
  const points = (
    [
      ["next visit", p.next],
      ["last visit", p.last],
      ["start date", p.start],
    ] as const
  ).filter((x): x is readonly ["next visit" | "last visit" | "start date", string] => !!x[1]);
  if (!points.length) return { on: null, from: null, off: [] };
  if (!p.frequencyInFile || points.length === 1) {
    return { on: points[0][1], from: points[0][0], off: [] };
  }
  const same = (a: string, b: string) => sameSchedule(a, b, p);
  const agreed = points.find(([, d]) => points.some(([, o]) => o !== d && same(d, o)));
  const pick = agreed ?? points.find(([w]) => w === "start date") ?? points[0];
  const off = points
    .filter(([w, d]) => w !== "start date" && !same(d, pick[1]))
    .map(([w, d]) => ({ which: w as "last visit" | "next visit", on: d }));
  return { on: pick[1], from: pick[0], off };
}
