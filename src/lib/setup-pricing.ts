// The two prices setup step 2 used to leave somewhere else (D7, onboarding
// audit 2026-11-09).
//
// Step 2 asked for an area, a radius, a price per visit and an extra-dog
// price. The first cleanup lived on Zones, which afterwards read "Off. New
// clients are not charged for a first cleanup.", and what every 2 weeks costs
// against weekly lived on Settings > Business defaults ("Price by schedule"),
// never shown in setup. An owner finished setup and quoted their first
// biweekly client at the column default with no first cleanup, never having
// been asked either.
//
// Step 2 now asks both, for a pet-waste business, and writes them where Zones
// and Business defaults read them. No parallel field:
//
//   * the first cleanup is the zone's own initial_cleanup_cents (createZone)
//     plus organizations.first_cleanup_pricing's mode (setFirstCleanupPricing),
//     exactly what FirstCleanupPricingCard's "flat" mode reads;
//   * the schedule prices are organizations.frequency_multipliers
//     (updateFrequencyMultipliers), exactly what FrequencyPricingCard edits.

import type { FirstCleanupPricing } from "@/lib/first-cleanup";
import {
  DEFAULT_FREQUENCY_MULTIPLIERS,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  MULTIPLIER_FREQUENCIES,
  type MultiplierFrequency,
} from "@/lib/frequency-multipliers";
import { MAX_TIER_PRICE_CENTS } from "@/lib/first-cleanup";
import { parseMoneyToCents } from "@/lib/quotes";

/** Off, or one flat price on the area being created. Tiers by "when was your
 *  yard last cleaned" stay a Zones decision: too much for a setup step. */
export type SetupFirstCleanup = "off" | "flat";

/**
 * The zone's initial_cleanup_cents for the answer, or null when the answer
 * cannot be saved (flat with no price). Off is an explicit $0, not a blank.
 */
export function setupFirstCleanupCents(choice: SetupFirstCleanup, price: string): number | null {
  if (choice === "off") return 0;
  const cents = parseMoneyToCents(price);
  return cents != null && cents > 0 && cents <= MAX_TIER_PRICE_CENTS ? cents : null;
}

/**
 * The first_cleanup_pricing to save, or null when nothing needs saving: the
 * mode is already the one chosen, or the business priced first cleanups by
 * tier on Zones, which setup never replaces. Tiers and the extra-dog amount
 * are carried through untouched.
 */
export function firstCleanupPricingFromSetup(
  current: FirstCleanupPricing,
  choice: SetupFirstCleanup,
): FirstCleanupPricing | null {
  if (current.mode === "by_last_cleaned") return null;
  if (current.mode === choice) return null;
  return { ...current, mode: choice };
}

/** The schedules setup asks about, in the order an owner reads them: weekly
 *  is the baseline, every 2 weeks is the one nearly every scooper sells. The
 *  other two are kept as stored and shown on Business defaults. */
export const SETUP_MULTIPLIER_FREQUENCIES = [
  "weekly",
  "biweekly",
] as const satisfies readonly MultiplierFrequency[];

function parseMultiplier(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(n) && n >= MIN_MULTIPLIER && n <= MAX_MULTIPLIER
    ? n
    : null;
}

/** The stored multiplier for a schedule, else the column default. */
export function storedMultiplier(
  stored: Record<string, unknown> | null | undefined,
  f: MultiplierFrequency,
): number {
  const n = Number(stored?.[f]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FREQUENCY_MULTIPLIERS[f];
}

/**
 * All four multipliers to send to updateFrequencyMultipliers (it takes all
 * four): what the owner typed, else what is stored, else the default. Null
 * when a typed one is outside the range Business defaults allows.
 */
export function setupMultipliers(
  stored: Record<string, unknown> | null | undefined,
  typed: Partial<Record<MultiplierFrequency, string>>,
): Record<MultiplierFrequency, number> | null {
  const out = {} as Record<MultiplierFrequency, number>;
  for (const f of MULTIPLIER_FREQUENCIES) {
    const raw = typed[f];
    if (raw === undefined) {
      out[f] = storedMultiplier(stored, f);
      continue;
    }
    const n = parseMultiplier(raw);
    if (n == null) return null;
    out[f] = n;
  }
  return out;
}
