// How often a plan recurs, read off the dates of its visits in a visits
// file (src/lib/import-visit-plans.ts).
//
// Real schedules are not clean. A visit is moved a day once, a weekly plan
// started with one visit on another weekday, a monthly plan is "the second
// Friday" rather than a date. Rigel's review of #1069 at da4554c6 found each
// of these read wrongly when the rule was "every date on one weekday": a
// weekly Friday plan booked on Wednesdays, a biweekly plan with one moved
// visit read as weekly, two one-off jobs ten weeks apart read as a plan
// "every 10 weeks". So:
//
// - The spacing is the median gap, so one moved visit does not change it.
// - The weekday (or day of the month) is the most common one, and up to one
//   date in five (at least one, with three or more dates) may be off it.
// - Two dates are a plan only when they agree exactly and are at most four
//   weeks apart; with no third date nothing says the gap was a pattern.
// - "The second Friday" is read as such. HoundStack repeats a monthly plan on
//   a date, so it imports on the date of its next visit, with a note that
//   says so in words.

import { parseFrequency } from "@/lib/import-services";

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const NTH = ["first", "second", "third", "fourth", "fifth"];

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const dayOfMonth = (iso: string) => Number(iso.slice(8, 10));
export const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** The most common value and how many times it occurs (ties: the smallest
 *  number, or the first string seen). */
export function mostCommon<T extends number | string>(
  values: readonly T[],
): { value: T; count: number } {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [value, count] = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (typeof a[0] === "number" ? (a[0] as number) - (b[0] as number) : 0),
  )[0];
  return { value, count };
}

function median(nums: readonly number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type DatesSchedule = {
  /** In the words the plan import reads ("Weekly on Fridays"). */
  text: string;
  /** What the owner should know that the text cannot say. */
  note?: string;
};

/** How often a run of visit dates (sorted, distinct) recurs, or null when
 *  the dates have no regular pattern. `anchor` is the date a monthly plan
 *  read by weekday is set to (its next visit; by default the latest date). */
export function scheduleFromDates(
  dates: readonly string[],
  anchor: string | null = dates.at(-1) ?? null,
): DatesSchedule | null {
  const n = dates.length;
  if (n < 2) return null;
  const gaps = dates.slice(1).map((d, i) => dayNumber(d) - dayNumber(dates[i]));
  const gap = median(gaps);
  const slack = n >= 3 ? Math.max(1, Math.floor(n / 5)) : 0;
  const enough = (count: number) => count >= n - slack;

  // Monthly on a date: the 10th.
  const dom = mostCommon(dates.map(dayOfMonth));
  // Every gap a whole number of four weeks is every 4 weeks, though a run
  // of three can share a date twice (Jan 8, Feb 5, Mar 5) and a skipped
  // visit leaves eight weeks (Oct 28, Nov 25, Dec 23, Feb 17), which looks
  // like a fourth Wednesday that moved once (#1069, Rigel at 0545ace1).
  const fourWeekly = n >= 3 && gaps.every((x) => x > 0 && x % 28 === 0);
  if (gap >= 27 && gap <= 32 && enough(dom.count) && !fourWeekly) {
    return { text: `Monthly on the ${ordinal(dom.value)} day of the month` };
  }
  // Monthly on a weekday: the second Friday. Its gaps are four weeks or
  // five; all four is every 4 weeks, which a run of three can look like.
  if (gap >= 27 && gap <= 36 && gaps.some((x) => x >= 34) && !fourWeekly) {
    const nth = mostCommon(dates.map((d) => `${weekday(d)}:${Math.ceil(dayOfMonth(d) / 7)}`));
    if (enough(nth.count)) {
      const [wd, k] = nth.value.split(":").map(Number);
      const on = dayOfMonth(anchor ?? dates[n - 1]);
      const which = `${NTH[k - 1]} ${DAY_NAMES[wd]}`;
      return {
        text: `Monthly on the ${ordinal(on)} day of the month`,
        note: `In the old system this plan was monthly on the ${which}. HoundStack repeats a monthly plan on the same date, so it is set to the ${ordinal(on)}, the date of its next visit; move a visit by hand in a month when the ${which} falls on another date.`,
      };
    }
  }
  // Weekly, or every few weeks, on one weekday.
  const wd = mostCommon(dates.map(weekday));
  const k = Math.round(gap / 7);
  if (k >= 1 && Math.abs(gap - 7 * k) <= 1 && enough(wd.count) && (n >= 3 || k <= 4)) {
    const on = `on ${DAY_NAMES[wd.value]}s`;
    return { text: k === 1 ? `Weekly ${on}` : `Every ${k} weeks ${on}` };
  }
  // Twice a week: two weekdays, each a quarter of the visits or more.
  if (n >= 3 && gap < 7) {
    const counts = new Map<number, number>();
    for (const d of dates) counts.set(weekday(d), (counts.get(weekday(d)) ?? 0) + 1);
    const [a, b] = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    if (b && a[1] >= n / 4 && b[1] >= n / 4 && enough(a[1] + b[1])) {
      const [x, y] = [a[0], b[0]].sort((p, q) => p - q);
      return { text: `Twice a week on ${DAY_NAMES[x]}s and ${DAY_NAMES[y]}s` };
    }
  }
  // Every n days. Walked from the first visit, it misses no more days than
  // the slack, and daily visits fall on every day of the week: walks Monday
  // to Friday, or Monday to Saturday, are not daily (#1069, Rigel).
  const g = mostCommon(gaps);
  const span = dayNumber(dates[n - 1]) - dayNumber(dates[0]);
  const walked = Math.floor(span / Math.max(1, g.value)) + 1;
  const everyDay = g.value !== 1 || new Set(dates.map(weekday)).size === 7;
  if (
    n >= 3 &&
    g.value > 0 &&
    g.value % 7 !== 0 &&
    g.count >= gaps.length - slack &&
    walked - n <= slack &&
    everyDay
  ) {
    return { text: `Every ${g.value} days` };
  }
  return null;
}

/** How often a run of visit dates recurs, in the words the plan import reads
 *  ("Weekly on Fridays"), or null. */
export function frequencyFromDates(dates: readonly string[]): string | null {
  return scheduleFromDates(dates)?.text ?? null;
}

/** The service's own name read as a frequency, on the weekday (or date) of
 *  `on`, the plan's next visit or its latest: "Every Other Week Pet Waste
 *  Cleanup" on a Friday is "Every 2 weeks on Fridays". Null when the name
 *  says nothing about how often, or says once. */
export function frequencyFromName(name: string, on: string | null): string | null {
  const f = parseFrequency(name);
  if (!f || f.frequency === "one_time") return null;
  const day = on ? ` on ${DAY_NAMES[weekday(on)]}s` : "";
  const said = `, from the service name "${name}"`;
  if (f.frequency === "weekly" && (f.intervalWeeks ?? 1) > 1) {
    return `Every ${f.intervalWeeks} weeks${day}${said}`;
  }
  if (f.frequency === "weekly") return `Weekly${day}${said}`;
  if (f.frequency === "biweekly") return `Every 2 weeks${day}${said}`;
  if (f.frequency === "monthly") {
    const dom = on ? ` on the ${ordinal(dayOfMonth(on))} day of the month` : "";
    return `Monthly${dom}${said}`;
  }
  if (f.frequency === "every_n_days") return `Every ${f.intervalDays} days${said}`;
  return null;
}

const DAYS = DAY_NAMES.map((d) => `${d}s`);
/** The weekdays a run of visits falls on, when it falls on them week after
 *  week (walks Monday to Friday), Monday first; else none. */
export function weekdaysOf(dates: readonly string[]): string[] {
  const days = [...new Set(dates.map(weekday))];
  const tight = dates.every((d, i) => i === 0 || dayNumber(d) - dayNumber(dates[i - 1]) <= 3);
  if (days.length < 3 || dates.length < days.length * 2 || !tight) return [];
  return days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS[d]);
}

/** Whether `dates` (sorted, distinct) are what a schedule read from earlier
 *  visits books, walked from `from`: weekly or every k weeks, monthly on a
 *  date, or twice a week, where every one of its two weekdays between the
 *  first date and the last is there (Tuesdays and Fridays booking only
 *  Fridays is a change: #1069, Rigel at 0545ace1). Another kind of schedule
 *  is taken to fit. */
export function fitsSchedule(text: string, from: string, dates: readonly string[]): boolean {
  const w = text.match(/^(?:Weekly|Every (\d+) weeks) on (\w+)$/);
  if (w) {
    const step = 7 * Number(w[1] ?? 1);
    const wd = DAYS.indexOf(w[2]);
    return dates.every((d) => weekday(d) === wd && (dayNumber(d) - dayNumber(from)) % step === 0);
  }
  const m = text.match(/^Monthly on the (\d+)\w\w day of the month$/);
  if (m) return dates.every((d) => dayOfMonth(d) === Number(m[1]));
  const t = text.match(/^Twice a week on (\w+) and (\w+)$/);
  if (t && dates.length) {
    const on = new Set([DAYS.indexOf(t[1]), DAYS.indexOf(t[2])]);
    const have = new Set(dates.map(dayNumber));
    for (let d = dayNumber(dates[0]); d <= dayNumber(dates.at(-1)!); d++) {
      if (on.has((d + 4) % 7) !== have.has(d)) return false;
    }
    return true;
  }
  return true;
}

const listed = (dates: readonly string[]) => dates.join(" and ");

/** A warning when a plan's next two visits do not say plainly whether its
 *  schedule changed: they are off the schedule its earlier visits had, and
 *  two dates are too few to read a new one (Fridays, then a Tuesday and a
 *  Friday); or they fit it with a wider gap (weekly, then two Fridays two
 *  weeks apart), which is a skipped visit or a slower plan. `read` is the
 *  schedule the plan is imported with. Null when there is nothing to say. */
export function scheduleChange(
  before: string,
  from: string,
  ahead: readonly string[],
  read: string,
): string | null {
  if (ahead.length !== 2) return null;
  const check = `It is read as ${read.toLowerCase()}; check it before you turn the plan on.`;
  if (!fitsSchedule(before, from, ahead)) {
    if (read === before || !fitsSchedule(read, ahead[0], ahead)) {
      return `Its next two visits (${listed(ahead)}) do not follow its earlier visits (${before.toLowerCase()}), so the schedule may have changed in the old system. ${check}`;
    }
    return null;
  }
  const w = before.match(/^(?:Weekly|Every (\d+) weeks) on /);
  const gap = dayNumber(ahead[1]) - dayNumber(ahead[0]);
  const step = 7 * Number(w?.[1] ?? 1);
  if (w && gap > step) {
    return `Its next two visits (${listed(ahead)}) are ${gap / 7} weeks apart, though its earlier visits were ${before.toLowerCase()}: a visit is skipped, or the plan is now every ${gap / 7} weeks. ${check}`;
  }
  return null;
}
