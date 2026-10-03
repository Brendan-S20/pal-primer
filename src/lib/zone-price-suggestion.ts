// Zone price suggestions as a written rule, not a model call.
//
// `suggestZonePricing` already computed everything a pricing decision rests on:
// visits completed and skipped per zone over 90 days, and the average price
// those visits were billed at. It then handed those numbers to a model and
// asked for a price. The model could only do arithmetic on them, and did it
// differently each run, so the same zone could be "raise 8%" on Monday and
// "hold" on Tuesday with no new visit in between. An owner deciding whether to
// change what their customers pay deserves a rule they can read.
//
// THE RULE
//
//   skip rate = skipped / (completed + skipped), over the last 90 days.
//
//   Fewer than 20 completed visits  hold; too little to judge. Confidence low.
//   No priced visits at all         hold; there is no price to move.
//   Skip rate 5% or less            raise 10%, rounded to the nearest dollar.
//   Skip rate 20% or more           hold; a raise on a zone that is already
//                                   skipping risks losing it.
//   Anything between                hold.
//
//   Confidence is high from 40 completed visits, medium from 20.
//
//   A raised residential price is never below $12.00. The floor applies only to
//   a raise: a hold suggests nothing, so it keeps whatever the zone charges.
//
// Every zone is returned, holds included. PricingPanel shows one row per zone
// with its 90-day figures, so a hold is the answer to "why not this one" and
// leaving it out would make the table look as if the zone had been missed.

export interface ZonePriceStats {
  zone_id: string;
  name: string;
  postal_prefix: string | null;
  account_type: string | null;
  current_price_note: string | null;
  completed_90d: number;
  skipped_90d: number;
  /** skipped / (completed + skipped), as a whole percent. The same figure the
   *  rule below decides on, so the column and the reason never disagree. */
  skip_rate_pct: number;
  avg_visit_price_cents: number;
}

export type ZonePriceConfidence = "low" | "medium" | "high";

export interface ZonePriceSuggestion {
  zone_id: string;
  suggested_price_cents: number;
  delta_pct: number;
  confidence: ZonePriceConfidence;
  reason: string;
}

export const MIN_COMPLETED_TO_JUDGE = 20;
export const HIGH_CONFIDENCE_COMPLETED = 40;
export const RAISE_MAX_SKIP_RATE = 0.05;
export const HOLD_SKIP_RATE = 0.2;
export const RAISE_FRACTION = 0.1;
export const RESIDENTIAL_FLOOR_CENTS = 1200;

/** One sentence, shown above the table, so the rule is on the screen and not
 *  only in this file. */
export const ZONE_PRICING_RULE_NOTE =
  "A zone is raised 10% when it had 20 or more completed visits in the last 90 days and 5% or fewer were skipped. Every other zone holds at its current average price.";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The skip rate the rule uses. Zero when nothing was completed or skipped. */
export function zoneSkipRate(completed: number, skipped: number): number {
  const total = Math.max(0, completed) + Math.max(0, skipped);
  return total > 0 ? Math.max(0, skipped) / total : 0;
}

function confidenceFor(completed: number): ZonePriceConfidence {
  if (completed >= HIGH_CONFIDENCE_COMPLETED) return "high";
  if (completed >= MIN_COMPLETED_TO_JUDGE) return "medium";
  return "low";
}

export function suggestZonePrice(s: ZonePriceStats): ZonePriceSuggestion {
  const completed = Math.max(0, Math.floor(s.completed_90d || 0));
  const skipped = Math.max(0, Math.floor(s.skipped_90d || 0));
  const current = Math.max(0, Math.round(s.avg_visit_price_cents || 0));
  const rate = zoneSkipRate(completed, skipped);
  const ratePct = Math.round(rate * 100);
  const hold = (confidence: ZonePriceConfidence, reason: string): ZonePriceSuggestion => ({
    zone_id: s.zone_id,
    suggested_price_cents: current,
    delta_pct: 0,
    confidence,
    reason,
  });

  if (completed < MIN_COMPLETED_TO_JUDGE) {
    return hold(
      "low",
      `Not enough visits in 90 days to judge (${completed} completed).`,
    );
  }
  if (current <= 0) {
    return hold("low", "No priced visits in 90 days, so there is no current price to move.");
  }

  const confidence = confidenceFor(completed);
  if (rate >= HOLD_SKIP_RATE) {
    return hold(
      confidence,
      `Hold: ${ratePct}% of visits were skipped, and a raise on a zone that skips this much risks losing clients.`,
    );
  }
  if (rate > RAISE_MAX_SKIP_RATE) {
    return hold(
      confidence,
      `Hold: ${ratePct}% of visits were skipped. A raise is suggested at 5% or less.`,
    );
  }

  let suggested = Math.round((current * (1 + RAISE_FRACTION)) / 100) * 100;
  let floorNote = "";
  if (s.account_type !== "commercial" && suggested < RESIDENTIAL_FLOOR_CENTS) {
    suggested = RESIDENTIAL_FLOOR_CENTS;
    floorNote = ` Raised to the ${dollars(RESIDENTIAL_FLOOR_CENTS)} residential minimum.`;
  }
  // The schema the panel was built against allowed -50% to +200%.
  const delta = Math.max(-50, Math.min(200, Math.round(((suggested - current) / current) * 100)));
  return {
    zone_id: s.zone_id,
    suggested_price_cents: suggested,
    delta_pct: delta,
    confidence,
    reason: `Raise 10%: ${completed} visits completed in 90 days and only ${ratePct}% skipped.${floorNote}`,
  };
}

/** Every zone, in the order given, each with its stats and its suggestion. */
export function suggestZonePrices(stats: ZonePriceStats[]): {
  notes: string;
  suggestions: Array<ZonePriceSuggestion & ZonePriceStats>;
} {
  return {
    notes: ZONE_PRICING_RULE_NOTE,
    suggestions: stats.map((s) => ({ ...suggestZonePrice(s), ...s })),
  };
}
