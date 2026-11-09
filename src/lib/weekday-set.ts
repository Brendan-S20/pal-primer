/** A plan's weekday set (subscriptions.weekdays, migration
 *  20261010010000_five-walks-a-week): the days of the week a walk plan runs
 *  on, one visit on each.
 *
 *  Days are 0 = Sunday ... 6 = Saturday, the numbering preferred_weekdays,
 *  organizations.work_days and the generator's EXTRACT(DOW ...) already use.
 *  They are SHOWN Monday first, because a walker's week is Monday to Friday.
 *
 *  Pure, so the picker, the plan card, the server and the tests share one
 *  copy of the rules the database holds as subscriptions_weekdays_valid. */

/** Display order: Monday first, Sunday last. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** What a new walk plan starts on: Monday to Friday. */
export const WORK_WEEK: readonly number[] = [1, 2, 3, 4, 5];

function isDay(d: unknown): d is number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;
}

/** The same rule as public.is_weekday_set: one to seven distinct days, 0-6. */
export function isWeekdaySet(days: readonly unknown[] | null | undefined): boolean {
  if (!days || days.length < 1 || days.length > 7) return false;
  if (!days.every(isDay)) return false;
  return new Set(days).size === days.length;
}

/** Valid days only, each once, ascending (the order the database stores). */
export function normalizeWeekdays(days: readonly number[]): number[] {
  return [...new Set(days.filter(isDay))].sort((a, b) => a - b);
}

/** The set with `day` switched on or off. */
export function toggleWeekday(days: readonly number[], day: number): number[] {
  return days.includes(day)
    ? normalizeWeekdays(days.filter((d) => d !== day))
    : normalizeWeekdays([...days, day]);
}

/** How many service days a plan of `frequency` runs on each week it runs.
 *  Twice weekly is two; every other cadence (weekly, every 2 weeks, monthly)
 *  lands on ONE day, the first of preferred_weekdays. */
export function serviceDaysPerWeek(frequency: string): number {
  return frequency === "twice_weekly" ? 2 : 1;
}

/**
 * The new-client wizard's Service day chips after a tap. A weekly plan saved
 * with Fri and Sat read "Fri Sat" on the client's Services but generated
 * Fridays only, because a weekly plan lands on the first preferred day
 * (R2-44, waste-r2-08). So a one-day cadence picks ONE day: a tap moves the
 * day rather than adding a second one. Twice weekly keeps up to two; a third
 * tap drops the pair's first day in the week. Never empty: tapping the only day
 * leaves it on.
 */
export function pickServiceDay(
  current: readonly number[],
  day: number,
  frequency: string,
): number[] {
  const max = serviceDaysPerWeek(frequency);
  const now = normalizeWeekdays(current).slice(0, max);
  if (now.includes(day)) {
    const left = now.filter((d) => d !== day);
    return left.length ? left : [day];
  }
  if (max === 1) return [day];
  return normalizeWeekdays([...(now.length >= max ? now.slice(1) : now), day]);
}

/** The days a plan of `frequency` is saved with: no more than it runs on. */
export function serviceDaysFor(days: readonly number[], frequency: string): number[] {
  return normalizeWeekdays(days).slice(0, serviceDaysPerWeek(frequency));
}

// 2023-01-01 was a Sunday, so day d of that week is Jan 1 + d.
const dayDate = (d: number) => new Date(Date.UTC(2023, 0, 1 + d));

/** "Mon" in the formatters' locale (lib/i18n `intlLocaleFor`); the device's
 *  when none is given. */
export function weekdayName(
  day: number,
  locale?: string,
  width: "short" | "long" = "short",
): string {
  return new Intl.DateTimeFormat(locale ?? [], { weekday: width, timeZone: "UTC" }).format(
    dayDate(day),
  );
}

/**
 * How a plan card reads its days: "Mon–Fri", "Mon, Wed, Fri", "Sat, Sun".
 * Three or more days in a row (Monday first) read as a range; anything
 * shorter is listed. Names and the list's separators
 * come from Intl in `locale`, so this is the same sentence in Spanish,
 * Arabic and Chinese without a translation key.
 */
export function formatWeekdaySet(days: readonly number[], locale?: string): string {
  const set = new Set(normalizeWeekdays(days));
  if (set.size === 0) return "";
  const runs: number[][] = [];
  let run: number[] = [];
  for (const d of WEEK_ORDER) {
    if (set.has(d)) {
      run.push(d);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  const parts: string[] = [];
  for (const r of runs) {
    if (r.length >= 3) {
      parts.push(`${weekdayName(r[0], locale)}–${weekdayName(r[r.length - 1], locale)}`);
    } else {
      for (const d of r) parts.push(weekdayName(d, locale));
    }
  }
  return new Intl.ListFormat(locale ?? [], { style: "short", type: "unit" }).format(parts);
}

/**
 * Whether the plan form offers "Set days each week". A walk, a sit or a groom
 * is sold by the day of the week, so it is offered for every service that is
 * not pet waste. A scooper's plan keeps the schedule list it has always had
 * unless the business turns set days on for it, and a plan that already runs
 * on set days keeps offering them, or editing it would lose its own schedule.
 */
export function offersSetDays(opts: {
  serviceLine: string | null | undefined;
  alreadySetDays: boolean;
  turnedOn: boolean;
}): boolean {
  if (opts.alreadySetDays || opts.turnedOn) return true;
  return !!opts.serviceLine && opts.serviceLine !== "pet_waste";
}
