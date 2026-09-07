// Who is off the current rate card, and by how much.
//
// `subscriptions.price_cents` is a snapshot taken when the service was created
// and changed only when somebody edits it. The zone's rate card, meanwhile,
// moves whenever an admin edits the zone. Nothing reconciles the two, so the
// gap between "what this customer pays" and "what this zone charges today"
// grows silently and is invisible from every screen in the product.
//
// This module computes that gap. It writes nothing and decides nothing: it
// answers "who is off, and by how much", which is the question that has to be
// answered before anybody can sensibly decide what to do about it.
//
// ── WHY THE PROPERTY'S ZONE AND NOT THE SUBSCRIPTION'S ──────────────────────
//
// Both `subscriptions.zone_id` and `properties.zone_id` exist and they
// disagree constantly -- measured on the demo organization on 2026-09-07, they
// differ on 45 of the 54 active services that have a zone at all.
//
// `properties.zone_id` is the one that means "where this service is routed
// today": `redetectZonesForOrg` re-runs the matcher after every zone edit and
// updates `properties`. `subscriptions.zone_id` is set once at create and
// nothing rewrites it, so it is a record of the past, not the present.
//
// "What would this cost today" is a question about the present, so the
// property's zone is the right input. A service whose property is in no zone
// has no answer at all, and that is reported as its own outcome rather than
// papered over by falling back to the stale column -- see NO_ZONE below, which
// on real data is not an edge case but 43% of the book.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
//
// It does not propose a new price, and it does not decide whether a gap is a
// mistake or a deliberate discount. Provenance answers the second question
// where it is recorded (see price-provenance.ts); where it is NULL the honest
// answer is that nobody knows, and a report that guessed would be worse than
// one that says so.

import { computeZoneVisitPrice, type ZonePricingFields } from "@/lib/pricing";

/**
 * Why a service has no comparison, or which direction it is off in.
 *
 * `no_zone` is not an error. A property outside every zone is a legitimate
 * state -- somebody quoted it by hand -- and the rate card genuinely has no
 * opinion about it. Grouping it with "on rate" would understate the problem;
 * grouping it with "off rate" would invent a number.
 */
export type DriftOutcome = "no_zone" | "on_rate" | "under" | "over";

/** One active service, as much of it as the comparison needs. */
export interface DriftSubscription {
  id: string;
  clientId: string;
  clientName: string;
  frequency: string;
  /** What the customer actually pays per visit, in cents. */
  priceCents: number;
  dogCount: number | null;
  /** The zone the property is routed to TODAY, or null if it is in none. */
  zone: (ZonePricingFields & { id: string; name: string }) | null;
  boundaryAreaSqm: number | null;
  /** Provenance, straight off the row. All three may be NULL. */
  pricedAt: string | null;
  pricedFromZoneId: string | null;
  priceOverriddenAt: string | null;
}

export interface DriftRow {
  subscriptionId: string;
  clientId: string;
  clientName: string;
  frequency: string;
  outcome: DriftOutcome;
  zoneId: string | null;
  zoneName: string | null;
  paidCents: number;
  /** What the zone charges today for this service. Null when there is no zone. */
  todayCents: number | null;
  /** todayCents - paidCents. Positive means the customer pays less than the
   *  card says. Null when there is no zone. */
  diffCents: number | null;
  /** todayCents / paidCents, for sorting by severity rather than by dollars --
   *  a $26 service at 18x is a worse fault than a $90 one at 1.2x, and sorting
   *  by absolute difference buries it. Null when there is no zone, and null
   *  when the customer pays nothing, which would divide by zero. */
  ratio: number | null;
  /** True when the zone's area ceiling bound the computed charge down. Shown
   *  because a capped price and an uncapped one that lands on the same number
   *  are different facts about the zone. */
  areaCapped: boolean;
  /** True when a human has typed over this price. These are the services a
   *  bulk change should not touch without being asked. */
  handPriced: boolean;
  pricedAt: string | null;
  pricedFromZoneId: string | null;
  priceOverriddenAt: string | null;
}

export interface DriftSummary {
  total: number;
  noZone: number;
  onRate: number;
  under: number;
  over: number;
  /** Sum of diffCents over the underpriced rows: the per-visit revenue the
   *  current card says is not being collected. Not an amount anybody is owed
   *  -- see the note on this in the report UI. */
  underSumCents: number;
  /** Sum over the overpriced rows, negative by construction. */
  overSumCents: number;
  handPriced: number;
}

export interface DriftReport {
  rows: DriftRow[];
  summary: DriftSummary;
}

/**
 * Compare every service against what its zone charges today.
 *
 * `multipliers` is the organization's `frequency_multipliers` map. A frequency
 * missing from it falls back to 1 rather than throwing: an unknown frequency
 * is a data problem worth seeing the rest of the report about, and 1 is the
 * weekly baseline the rest of the pricing code already assumes.
 */
export function computePricingDrift(
  subs: DriftSubscription[],
  multipliers: Record<string, number>,
): DriftReport {
  const rows: DriftRow[] = subs.map((s) => {
    const handPriced = s.priceOverriddenAt != null;
    const base = {
      subscriptionId: s.id,
      clientId: s.clientId,
      clientName: s.clientName,
      frequency: s.frequency,
      paidCents: s.priceCents,
      handPriced,
      pricedAt: s.pricedAt,
      pricedFromZoneId: s.pricedFromZoneId,
      priceOverriddenAt: s.priceOverriddenAt,
    };

    if (!s.zone) {
      return {
        ...base,
        outcome: "no_zone" as const,
        zoneId: null,
        zoneName: null,
        todayCents: null,
        diffCents: null,
        ratio: null,
        areaCapped: false,
      };
    }

    const mult = Number(multipliers[s.frequency] ?? 1) || 1;
    const priced = computeZoneVisitPrice(s.zone, {
      dogCount: s.dogCount ?? 1,
      boundaryAreaSqm: s.boundaryAreaSqm,
      multiplier: mult,
    });
    const today = priced.recurringCents;
    const diff = today - s.priceCents;

    return {
      ...base,
      outcome: diff === 0 ? ("on_rate" as const) : diff > 0 ? ("under" as const) : ("over" as const),
      zoneId: s.zone.id,
      zoneName: s.zone.name,
      todayCents: today,
      diffCents: diff,
      ratio: s.priceCents > 0 ? today / s.priceCents : null,
      areaCapped: priced.areaCapped,
    };
  });

  const summary: DriftSummary = {
    total: rows.length,
    noZone: rows.filter((r) => r.outcome === "no_zone").length,
    onRate: rows.filter((r) => r.outcome === "on_rate").length,
    under: rows.filter((r) => r.outcome === "under").length,
    over: rows.filter((r) => r.outcome === "over").length,
    underSumCents: rows
      .filter((r) => r.outcome === "under")
      .reduce((n, r) => n + (r.diffCents ?? 0), 0),
    overSumCents: rows
      .filter((r) => r.outcome === "over")
      .reduce((n, r) => n + (r.diffCents ?? 0), 0),
    handPriced: rows.filter((r) => r.handPriced).length,
  };

  return { rows, summary };
}

/**
 * Worst first, by ratio rather than by dollars.
 *
 * A $26 service the card prices at $489 is an 18x fault and the single most
 * important row in the report; a $90 service the card prices at $108 is a
 * rounding argument. Sorting by `diffCents` puts the second above the first
 * whenever the dollar gap is bigger, which is exactly backwards for finding
 * misconfigured zones.
 *
 * Rows with no ratio -- no zone, or a customer paying nothing -- sort last.
 * They are not "least severe"; they are unrankable on this axis, and the
 * report lists them under their own heading rather than at the bottom of a
 * list that implies an ordering.
 */
export function sortBySeverity(rows: DriftRow[]): DriftRow[] {
  return [...rows].sort((a, b) => {
    if (a.ratio == null && b.ratio == null) return 0;
    if (a.ratio == null) return 1;
    if (b.ratio == null) return -1;
    // Distance from 1 in either direction: paying half the card is as wrong as
    // paying double it, and a report that only ranked underpricing would be a
    // collections tool rather than a correctness one.
    return Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio));
  });
}
