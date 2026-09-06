// Pure zone-pricing math shared by the internal quote (New Client wizard).
//
// A zone's price components always SUM: base price + per-extra-dog + area
// charge (per-sqft or per-acre, when the zone prices by area and a boundary
// was drawn). Finding #3: the area charge was previously used INSTEAD of the
// base price, so a $20-base + $5/acre commercial zone quoted a 0.057-acre
// yard at $0.28/visit.

export interface ZonePricingFields {
  base_price_cents: number | null;
  per_dog_addl_cents: number | null;
  pricing_mode: "flat" | "per_sqft" | "per_acre" | null;
  price_per_sqft_cents: number | null;
  price_per_acre_cents: number | null;
  area_min_charge_cents: number | null;
  /** Ceiling on the area component. See computeZoneVisitPrice for why this is
   *  not optional in practice even though the column is nullable. */
  area_max_charge_cents?: number | null;
}

export interface VisitPriceInput {
  dogCount: number;
  boundaryAreaSqm?: number | null;
  /** Frequency multiplier (1 = weekly baseline). */
  multiplier?: number;
}

export interface VisitPriceResult {
  /** Raw area-based charge before the minimum was applied (null when area pricing wasn't used). */
  areaBasisCents: number | null;
  /** True when the zone's ceiling bound the area charge down. Quote screens
   *  show this, because a capped price and an uncapped one that happens to
   *  land on the same number are different facts about the zone. */
  areaCapped: boolean;
  /** Full per-visit price before the frequency multiplier: base + area + extra dogs. */
  perVisitCents: number;
  /** Per-visit price after the frequency multiplier. */
  recurringCents: number;
}

export const SQFT_PER_SQM = 10.7639;
export const SQM_PER_ACRE = 4046.8564;

export function computeZoneVisitPrice(zone: ZonePricingFields, input: VisitPriceInput): VisitPriceResult {
  const mode = zone.pricing_mode ?? "flat";
  const dogAddl = Math.max(0, input.dogCount - 1) * (zone.per_dog_addl_cents ?? 0);

  let areaBasisCents: number | null = null;
  let areaCharge = 0;
  let areaCapped = false;
  if (mode !== "flat" && input.boundaryAreaSqm) {
    const raw =
      mode === "per_sqft"
        ? Math.round(input.boundaryAreaSqm * SQFT_PER_SQM * (zone.price_per_sqft_cents ?? 0))
        : Math.round((input.boundaryAreaSqm / SQM_PER_ACRE) * (zone.price_per_acre_cents ?? 0));
    areaBasisCents = raw;
    areaCharge = Math.max(raw, zone.area_min_charge_cents ?? 0);

    // The ceiling. `area_min_charge_cents` is a FLOOR and was the only bound
    // this function had, so an area rate multiplied by a big enough lot
    // returned an arbitrarily large per-visit price with nothing to stop it.
    // Measured on real data before this was added: a per_sqft zone at
    // 0.75c/sqft quoted $287.92 per visit for a 35,700 sqft yard, against the
    // $26.00 that customer actually pays. Nobody was ever charged it, because
    // the zone is only read when a subscription is created and these
    // subscriptions predate the rate -- which is to say the arithmetic was
    // never wrong in production only because it was never used in production.
    //
    // Applied AFTER the floor deliberately. A zone saved with min > max is
    // misconfigured either way, and of the two answers the lower one is the
    // one that cannot generate a $489 invoice. Save-time validation rejects
    // that pair so the case should not arise.
    const cap = zone.area_max_charge_cents ?? 0;
    if (cap > 0 && areaCharge > cap) {
      areaCharge = cap;
      areaCapped = true;
    }
  }

  const perVisitCents = (zone.base_price_cents ?? 0) + areaCharge + dogAddl;
  const recurringCents = Math.round(perVisitCents * (input.multiplier ?? 1));
  return { areaBasisCents, areaCapped, perVisitCents, recurringCents };
}

// ── Commercial (HOA) zone pricing ───────────────────────────────────────────
// Commercial properties price by units and grounds, not dogs:
// per-visit = commercial base + per-unit x units + per-acre x acres, then the
// frequency multiplier. Every component SUMS (same rule as residential).

export interface CommercialZonePricingFields {
  commercial_base_cents: number | null;
  commercial_per_unit_cents: number | null;
  commercial_per_acre_cents: number | null;
  // Per-waste-station rate (C2): HOA quotes bill by dispenser count too.
  commercial_per_station_cents?: number | null;
}

export interface CommercialPriceInput {
  /** TOTAL units on the property, not dog-owning units (C2). */
  unitCount: number;
  boundaryAreaSqm?: number | null;
  /** Active waste-station count on the property. */
  stationCount?: number;
  /** Frequency multiplier (1 = weekly baseline). */
  multiplier?: number;
}

export interface CommercialPriceResult {
  baseCents: number;
  /** per-unit rate x unit count. */
  unitCents: number;
  /** per-acre rate x acres from the drawn boundary (0 when no boundary). */
  acreageCents: number;
  /** per-station rate x active station count (0 when unconfigured/none). */
  stationCents: number;
  /** Full per-visit price before the frequency multiplier. */
  perVisitCents: number;
  /** Per-visit price after the frequency multiplier. */
  recurringCents: number;
}

/** True when the zone has any commercial pricing component configured. */
export function zoneHasCommercialPricing(zone: CommercialZonePricingFields): boolean {
  return (
    (zone.commercial_base_cents ?? 0) > 0 ||
    (zone.commercial_per_unit_cents ?? 0) > 0 ||
    (zone.commercial_per_acre_cents ?? 0) > 0 ||
    (zone.commercial_per_station_cents ?? 0) > 0
  );
}

export function computeCommercialZonePrice(
  zone: CommercialZonePricingFields,
  input: CommercialPriceInput,
): CommercialPriceResult {
  const baseCents = zone.commercial_base_cents ?? 0;
  const unitCents = Math.max(0, input.unitCount) * (zone.commercial_per_unit_cents ?? 0);
  // Clamp like unitCount: a negative drawn-boundary area must never discount.
  const areaSqm = Math.max(0, input.boundaryAreaSqm ?? 0);
  const acreageCents = areaSqm
    ? Math.round((areaSqm / SQM_PER_ACRE) * (zone.commercial_per_acre_cents ?? 0))
    : 0;
  const stationCents = Math.max(0, input.stationCount ?? 0) * (zone.commercial_per_station_cents ?? 0);
  const perVisitCents = baseCents + unitCents + acreageCents + stationCents;
  const recurringCents = Math.round(perVisitCents * (input.multiplier ?? 1));
  return { baseCents, unitCents, acreageCents, stationCents, perVisitCents, recurringCents };
}
