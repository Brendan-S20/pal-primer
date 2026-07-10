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
  if (mode !== "flat" && input.boundaryAreaSqm) {
    const raw =
      mode === "per_sqft"
        ? Math.round(input.boundaryAreaSqm * SQFT_PER_SQM * (zone.price_per_sqft_cents ?? 0))
        : Math.round((input.boundaryAreaSqm / SQM_PER_ACRE) * (zone.price_per_acre_cents ?? 0));
    areaBasisCents = raw;
    areaCharge = Math.max(raw, zone.area_min_charge_cents ?? 0);
  }

  const perVisitCents = (zone.base_price_cents ?? 0) + areaCharge + dogAddl;
  const recurringCents = Math.round(perVisitCents * (input.multiplier ?? 1));
  return { areaBasisCents, perVisitCents, recurringCents };
}
