// What `organizations.frequency_multipliers` means, in one place (#572, F-07).
//
// Each number is what ONE CYCLE of the plan costs, measured in weekly visits:
//
//   weekly        1.0  one visit a week               = 1.0 weekly visit
//   biweekly      1.7  one visit every two weeks      = 1.7 weekly visits
//   twice_weekly  1.8  two visits a week, together    = 1.8 weekly visits
//   monthly       3.2  one visit a month              = 3.2 weekly visits
//
// For every cadence but one, a cycle is one visit, so the number is also the
// per-visit factor and nothing about biweekly or monthly changes here. Twice
// weekly is the exception: its cycle is a week with TWO visits in it. Until
// this file, every caller multiplied the per-visit price by 1.8 anyway, so
// two visits billed 3.6x the weekly plan. Measured on a pet-waste signup
// page: weekly $25.00/visit, twice weekly $45.00/visit, $90 a week.
//
// The owner's decision (D1, 2026-10-28): 1.8 is the weekly TOTAL. So each
// twice-weekly visit is 1.8 / 2 = 0.9 of a weekly visit. public_quote does
// the same division in SQL (20261029120000_twice-weekly-is-priced-per-week).

/** The cadences that have a multiplier, in the order an owner reads them. */
export const MULTIPLIER_FREQUENCIES = ["weekly", "twice_weekly", "biweekly", "monthly"] as const;
export type MultiplierFrequency = (typeof MULTIPLIER_FREQUENCIES)[number];

/** Visits in one cycle. A cadence not listed is one visit per cycle. */
export const VISITS_PER_CYCLE: Readonly<Record<MultiplierFrequency, number>> = {
  weekly: 1,
  twice_weekly: 2,
  biweekly: 1,
  monthly: 1,
};

/** The column default (20260701215820), read as cycle totals. */
export const DEFAULT_FREQUENCY_MULTIPLIERS: Readonly<Record<MultiplierFrequency, number>> = {
  weekly: 1.0,
  twice_weekly: 1.8,
  biweekly: 1.7,
  monthly: 3.2,
};

/** Bounds an owner can save. Wide enough for any real price list, narrow
 *  enough that a typo (18 for 1.8) is refused rather than invoiced. */
export const MIN_MULTIPLIER = 0.1;
export const MAX_MULTIPLIER = 10;

/** The stored cycle multiplier, or null when the org has none for it. */
function storedCycleMultiplier(
  multipliers: Record<string, unknown> | null | undefined,
  frequency: string | null | undefined,
): number | null {
  const raw = Number(multipliers?.[frequency ?? ""]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** What one cycle costs, in weekly visits. 1 when the org has no number. */
export function cycleMultiplier(
  multipliers: Record<string, unknown> | null | undefined,
  frequency: string | null | undefined,
): number {
  return storedCycleMultiplier(multipliers, frequency) ?? 1;
}

/**
 * The factor ONE visit's price is multiplied by. This is the number every
 * per-visit price in the product must use.
 *
 * A frequency the org has no number for falls back to 1 per visit, as it
 * always has: an unknown cadence is priced like a weekly visit rather than
 * halved.
 */
export function perVisitMultiplier(
  multipliers: Record<string, unknown> | null | undefined,
  frequency: string | null | undefined,
): number {
  const cycle = storedCycleMultiplier(multipliers, frequency);
  if (cycle == null) return 1;
  const visits = VISITS_PER_CYCLE[frequency as MultiplierFrequency] ?? 1;
  return cycle / visits;
}

/** A multiplier as a person writes it: 0.9, 1.7, 0.875. */
export function formatMultiplier(m: number): string {
  return String(Math.round(m * 1000) / 1000);
}
