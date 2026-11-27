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
  if (gap >= 27 && gap <= 32 && enough(dom.count)) {
    return { text: `Monthly on the ${ordinal(dom.value)} day of the month` };
  }
  // Monthly on a weekday: the second Friday. Its gaps are four weeks or
  // five; all four is every 4 weeks, which a run of three can look like.
  if (gap >= 27 && gap <= 36 && gaps.some((x) => x >= 34)) {
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
  // Every n days.
  const g = mostCommon(gaps);
  if (n >= 3 && g.value > 0 && g.value % 7 !== 0 && g.count >= gaps.length - slack) {
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
