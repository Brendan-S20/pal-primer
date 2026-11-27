// Where an imported plan's schedule is walked from (#1069).
//
// A plan's visits are generated from subscriptions.started_on, its
// frequency and its weekdays. The old system's file can carry three dates
// to set it from: when the plan began there, its last completed visit and
// its next booked one. Any one of them may have been moved by hand once, so
// a date is trusted only when another agrees with it.

import type { ImportFrequency } from "@/lib/import-services";

const NO_VISIT =
  /^(-+|—|–|n\/?a|none|never|not yet|not scheduled|unscheduled|no visits?|tbd|tba|null|nil|0+|0{1,2}\/0{1,2}\/0{2,4}|0{4}-0{2}-0{2})$/i;

/** A last or next visit cell with "no visit" placeholders read as blank
 *  ("-", "N/A.", "Never", "TBD", "Not scheduled", "null", "0",
 *  "00/00/0000"). */
export function noVisit(text: string | null): string | null {
  return text && NO_VISIT.test(text.trim().replace(/\.$/, "")) ? null : text;
}

/** The day of the month a monthly frequency names ("Monthly on the 10th
 *  day of the month" is 10; "on the last day" is 31, read as the month's
 *  last day), or null when it names none. */
export function statedMonthDay(text: string | null | undefined): number | null {
  const t = (text ?? "").toLowerCase();
  if (!/month/.test(t)) return null;
  if (/\blast\s+day\b/.test(t)) return 31;
  const m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/) ?? t.match(/\bday\s+(\d{1,2})\b/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 31 ? n : null;
}

const lastDayOf = (x: string) => {
  const dt = new Date(`${x}T00:00:00Z`);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
};

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
      return (da === lastDayOf(a) && db > da) || (db === lastDayOf(b) && da > db);
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

type Which = "next visit" | "visit after next" | "last visit" | "start date";

/** The date a plan's schedule is walked from, given the file's start date,
 *  the old system's last completed visit and its next two booked ones, and
 *  the day of the month the frequency names. One visit moved by hand (Nov
 *  27 done on Nov 28 once) must not move every visit after it, and a new
 *  or changed schedule must not be walked from its old dates (Rigel's
 *  reviews of #1069). So:
 *
 *  - The next two booked visits agreeing with each other set the plan.
 *  - Otherwise a date is used when another agrees with it on the plan's frequency:
 *    the next visit first, then the last visit, then the visit after next,
 *    then the start date; dates that also fit the day the frequency names
 *    (the 10th, a Tuesday) first. The two upcoming visits agreeing
 *    with each other and not with the past means the schedule changed in
 *    the old system: the plan follows the upcoming visits (`changed`).
 *  - When no two agree, the date that fits the named day is used, else the
 *    start date, else the next visit; with nothing to tell which is right
 *    the owner is told the dates disagree (`unsure`), not that one moved.
 *
 *  A visit off the chosen schedule is returned for the plan's note. With no
 *  frequency in the file there is no schedule to check, and the latest
 *  known date is used. */
export function planAnchor(p: {
  frequency: ImportFrequency["frequency"];
  intervalWeeks: number | null;
  intervalDays: number | null;
  weekdays: readonly number[];
  frequencyInFile: boolean;
  start: string | null;
  last: string | null;
  next: string | null;
  afterNext?: string | null;
  monthDay?: number | null;
}): {
  on: string | null;
  from: Which | null;
  off: { which: "last visit" | "next visit"; on: string }[];
  changed?: boolean;
  unsure?: boolean;
} {
  const all = (
    [
      ["next visit", p.next],
      ["last visit", p.last],
      ["visit after next", p.afterNext ?? null],
      ["start date", p.start],
    ] as const
  ).filter((x): x is readonly [Which, string] => !!x[1]);
  if (!all.length) return { on: null, from: null, off: [] };
  const first = all.find(([w]) => w !== "visit after next") ?? all[0];
  if (!p.frequencyInFile || all.length === 1) return { on: first[1], from: first[0], off: [] };

  const same = (a: string, b: string) => sameSchedule(a, b, p);
  const fitsDay = (d: string) => {
    if (p.frequency === "monthly" && p.monthDay) {
      const day = Number(d.slice(8, 10));
      return day === p.monthDay || (p.monthDay > lastDayOf(d) && day === lastDayOf(d));
    }
    if (p.frequency !== "monthly" && p.frequency !== "every_n_days" && p.weekdays.length) {
      return p.weekdays.includes(weekdayOf(d));
    }
    return true;
  };
  const fitting = all.filter(([, d]) => fitsDay(d));
  const agreedIn = (pool: typeof all) => {
    const agrees = (d: string) => pool.some(([, o]) => o !== d && same(d, o));
    return (
      pool.find(([w, d]) => w !== "visit after next" && agrees(d)) ??
      pool.find(([, d]) => agrees(d))
    );
  };
  // Dates that agree with each other win over one that only fits the named
  // day: every visit moved from the 10th to the 12th is a schedule that
  // moved, with a frequency text nobody updated. And the next two booked
  // visits agreeing is the schedule from here on, whatever the past says.
  const ahead = all.find(([w]) => w === "next visit");
  const agreed =
    (ahead && p.afterNext && same(ahead[1], p.afterNext) ? ahead : undefined) ??
    agreedIn(fitting) ??
    agreedIn(all);
  const fits = fitting.length && fitting.length < all.length ? fitting[0] : null;
  const pick = agreed ?? fits ?? all.find(([w]) => w === "start date") ?? first;
  const unsure = !agreed && !fits;
  const upcomingAgree = !!p.next && !!p.afterNext && same(p.next, p.afterNext);
  const changed =
    !!agreed && upcomingAgree && pick[1] === p.next && !!p.last && !same(p.last, p.next);
  const off = all
    .filter(
      ([w, d]) => (w === "next visit" || (w === "last visit" && !changed)) && !same(d, pick[1]),
    )
    .map(([w, d]) => ({ which: w as "last visit" | "next visit", on: d }));
  return {
    on: pick[1],
    from: pick[0],
    off,
    ...(changed ? { changed: true } : {}),
    ...(unsure && off.length ? { unsure: true } : {}),
  };
}
