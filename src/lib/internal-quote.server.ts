// The zone quote for a new client's plan: the price the business's own zones
// and frequency multipliers give, worked out on the server.
//
// Two callers. getInternalQuote shows it on the new-client wizard's Plan step;
// onboardClient books a plan at it for a caller who does not set prices
// (#728), the way a dispatcher's one-off is booked at the set price (#616).
// One function, so what the screen showed and what the server writes cannot
// drift apart.

export type InternalQuoteInput = {
  postalCode: string;
  accountType?: "residential" | "commercial";
  dogCount: number;
  frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly";
  boundaryAreaSqm?: number;
  latitude?: number;
  longitude?: number;
  unitCount?: number;
  stationCount?: number;
};

export async function internalQuote(supabase: any, orgId: string, data: InternalQuoteInput) {
  const { data: org, error: oErr } = await supabase
    .from("organizations")
    .select("currency, frequency_multipliers")
    .eq("id", orgId)
    .single();
  if (oErr) throw new Error(oErr.message);

  const { data: zones, error: zErr } = await supabase
    .from("zones")
    .select(
      "id, name, priority, account_type, postal_prefix, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, area_max_charge_cents, commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, commercial_per_station_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
    )
    .eq("organization_id", orgId);
  if (zErr) throw new Error(zErr.message);

  const { matchZone } = await import("@/lib/zone-match");
  const z = matchZone((zones ?? []) as any[], {
    postalCode: data.postalCode,
    point:
      data.latitude != null && data.longitude != null
        ? { lat: data.latitude, lng: data.longitude }
        : null,
    accountType: data.accountType ?? null,
  });

  if (!z) return { available: false as const };
  const { perVisitMultiplier } = await import("@/lib/frequency-multipliers");
  const mult = perVisitMultiplier(org.frequency_multipliers as any, data.frequency);
  const mode = (z.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre";

  // A commercial account (an HOA, a park) is priced from the zone's
  // commercial rates: base + per unit + per acre + per station, then the
  // frequency multiplier. The wizard used to ask for a quote only for a
  // residential account, so a commercial plan was saved with no zone and a
  // price somebody typed (#658, R2-21).
  if (data.accountType === "commercial") {
    const { computeCommercialZonePrice, zoneHasCommercialPricing } = await import("@/lib/pricing");
    const rated = zoneHasCommercialPricing(z as any);
    const price = rated
      ? computeCommercialZonePrice(z as any, {
          unitCount: data.unitCount ?? 0,
          stationCount: data.stationCount ?? 0,
          boundaryAreaSqm: data.boundaryAreaSqm,
          multiplier: mult,
        })
      : null;
    return {
      available: true as const,
      quote: {
        zoneId: z.id as string,
        zoneName: z.name as string,
        pricingMode: "commercial" as const,
        areaBasisCents: price?.acreageCents ?? null,
        basePriceCents: price?.perVisitCents ?? null,
        perDogAddlCents: 0,
        // null: the zone has no commercial rates, so the office sets the
        // price; the zone is still the plan's.
        recurringPriceCents: price?.recurringCents ?? null,
        initialCleanupCents: z.initial_cleanup_cents ?? 0,
        currency: org.currency as string,
        commercial: price
          ? {
              baseCents: price.baseCents,
              unitCents: price.unitCents,
              acreageCents: price.acreageCents,
              stationCents: price.stationCents,
            }
          : null,
      },
    };
  }

  const { computeZoneVisitPrice } = await import("@/lib/pricing");
  const price = computeZoneVisitPrice(
    {
      base_price_cents: z.base_price_cents,
      per_dog_addl_cents: z.per_dog_addl_cents,
      pricing_mode: mode,
      price_per_sqft_cents: Number(z.price_per_sqft_cents ?? 0),
      price_per_acre_cents: z.price_per_acre_cents,
      area_min_charge_cents: z.area_min_charge_cents,
      area_max_charge_cents: z.area_max_charge_cents,
    },
    { dogCount: data.dogCount, boundaryAreaSqm: data.boundaryAreaSqm, multiplier: mult },
  );
  return {
    available: true as const,
    quote: {
      zoneId: z.id as string,
      zoneName: z.name as string,
      pricingMode: mode,
      areaBasisCents: price.areaBasisCents,
      basePriceCents: price.perVisitCents,
      perDogAddlCents: z.per_dog_addl_cents ?? 0,
      recurringPriceCents: price.recurringCents,
      initialCleanupCents: z.initial_cleanup_cents ?? 0,
      currency: org.currency as string,
      commercial: null,
    },
  };
}
