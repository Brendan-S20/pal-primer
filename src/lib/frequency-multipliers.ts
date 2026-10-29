// How a pet-waste plan's cadence changes its price (#572, F-07).
//
// `organizations.frequency_multipliers` is a PER-VISIT multiplier on the
// weekly price, read the same way by every pricing path: computeZoneVisitPrice
// (pricing.ts), the quote prefill (quote-pricing.ts), the new-client wizard,
// pricing drift, and public_quote in the database. So the number the owner
// sets for a cadence is what one visit of it costs, as a multiple of one
// weekly visit.
//
// The shipped default was { weekly 1, biweekly 1.7, twice_weekly 1.8,
// monthly 3.2 }, and 1.8 per visit at two visits a week billed twice-weekly
// at 3.6x the weekly plan: a $35 weekly yard was $63 a visit, $126 a week.
// D1 (2026-10-28): 1.8 was meant as the WEEK. Twice-weekly is now 0.9 a
// visit, 1.8x the weekly plan for the week, and the owner can see and change
// every cadence in Settings > Business defaults.
//
// Biweekly and monthly keep their values and their per-visit meaning: a
// biweekly visit is 1.7x a weekly one (0.85x a week), a monthly visit 3.2x
// (about 0.74x a week). Waste piles up between visits, so a longer gap is a
// bigger visit at a lower weekly cost.

export const FREQUENCY_KEYS = ["weekly", "twice_weekly", "biweekly", "monthly"] as const;
export type FrequencyKey = (typeof FREQUENCY_KEYS)[number];
export type FrequencyMultipliers = Record<FrequencyKey, number>;

/** The pet-waste default, and organizations.frequency_multipliers' column
 *  default from 20261029120000. */
export const DEFAULT_FREQUENCY_MULTIPLIERS: Readonly<FrequencyMultipliers> = {
  weekly: 1.0,
  biweekly: 1.7,
  twice_weekly: 0.9,
  monthly: 3.2,
};

/** Visits in an average week. Monthly is 12 visits over 52 weeks. */
export const VISITS_PER_WEEK: Readonly<FrequencyMultipliers> = {
  weekly: 1,
  twice_weekly: 2,
  biweekly: 0.5,
  monthly: 12 / 52,
};

/** The owner's bounds, also checked by update_org_frequency_multipliers. A
 *  twice-weekly visit may not cost more than a weekly one, so the week never
 *  costs more than two weekly visits. Weekly is the price itself and is not
 *  editable. */
export const MULTIPLIER_MIN = 0.1;
export const MULTIPLIER_MAX = 10;
export const TWICE_WEEKLY_MAX = 1;

/** The per-visit multiplier for a cadence, 1 when the map has nothing usable
 *  for it (the fallback every pricing path already used). */
export function perVisitMultiplier(
  multipliers: Record<string, unknown> | null | undefined,
  frequency: string,
): number {
  const n = Number(multipliers?.[frequency] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** What a week of this cadence costs, as a multiple of the weekly plan. */
export function weeklyTotalMultiplier(
  multipliers: Record<string, unknown> | null | undefined,
  frequency: FrequencyKey,
): number {
  return perVisitMultiplier(multipliers, frequency) * VISITS_PER_WEEK[frequency];
}

/** The org's map with every cadence present, defaults filling any gap. */
export function withDefaults(
  multipliers: Record<string, unknown> | null | undefined,
): FrequencyMultipliers {
  const out = { ...DEFAULT_FREQUENCY_MULTIPLIERS };
  for (const k of FREQUENCY_KEYS) {
    const n = Number(multipliers?.[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** Why a map cannot be saved, or null when it can. */
export function multipliersProblem(m: Record<string, number>): string | null {
  if (m.weekly !== 1) return "Weekly is the base price and stays at 1.";
  for (const k of ["biweekly", "twice_weekly", "monthly"] as const) {
    const v = m[k];
    if (!Number.isFinite(v) || v < MULTIPLIER_MIN || v > MULTIPLIER_MAX) {
      return `Each multiplier must be between ${MULTIPLIER_MIN} and ${MULTIPLIER_MAX}.`;
    }
  }
  if (m.twice_weekly > TWICE_WEEKLY_MAX) {
    return "A twice-weekly visit can cost at most the weekly price, so a week of two visits is never more than two weekly visits.";
  }
  return null;
}
