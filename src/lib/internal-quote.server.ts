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
  /** The pet-waste service the plan is for, whose standard price applies
   *  where no zone overrides it (#860). Omitted: the default pet-waste
   *  service (defaultPetWasteService). */
  serviceId?: string;
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
  const pinned =
    data.latitude != null && data.longitude != null
      ? { lat: data.latitude, lng: data.longitude }
      : null;
  const z =
    matchZone((zones ?? []) as any[], {
      postalCode: data.postalCode,
      point: pinned,
      accountType: data.accountType ?? null,
    }) ??
    // No pin, and no zone lists the ZIP. A drawn area that lists no ZIPs
    // (made in setup before it filled them, or saved with its chips removed)
    // could only ever be reached by a pin, so an address typed by hand fell
    // through to "No zone matches ZIP 48226" inside a 10-mile circle on
    // Detroit (onboarding audit 2026-11-09, D1). Place the ZIP at its Census
    // center -- the point "Fill ZIPs from the area" asks of the same shape --
    // and ask the matcher again, so its precedence still decides.
    (pinned
      ? null
      : await matchByZipCenter(supabase, orgId, (zones ?? []) as any[], data, matchZone));

  const { perVisitMultiplier } = await import("@/lib/frequency-multipliers");
  const mult = perVisitMultiplier(org.frequency_multipliers as any, data.frequency);

  // #860: the service's standard price, which a zone may override. Read for a
  // residential yard only; a commercial account is priced by zone rates.
  const { loadPetWasteStandard, petWasteVisitRate } = await import("@/lib/standard-price");
  const standard =
    data.accountType === "commercial"
      ? null
      : await loadPetWasteStandard(supabase, orgId, data.serviceId ?? null);

  if (!z) {
    // Outside every zone there is no override to apply, so the office is
    // offered the standard price (#860). It used to be "No zone matches ZIP
    // 48933. Set price manually below." with the standard price saved and
    // never read. A commercial account has no standard to fall back on.
    const rate = petWasteVisitRate(standard, null);
    if (!rate) return { available: false as const };
    const perVisit = rate.baseCents + Math.max(0, data.dogCount - 1) * rate.perDogCents;
    return {
      available: true as const,
      quote: {
        zoneId: null,
        zoneName: null,
        priceSource: "standard" as const,
        pricingMode: "flat" as const,
        areaBasisCents: null,
        basePriceCents: perVisit,
        perDogAddlCents: rate.perDogCents,
        recurringPriceCents: Math.round(perVisit * mult),
        initialCleanupCents: 0,
        currency: org.currency as string,
        commercial: null,
      },
    };
  }
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
        priceSource: "zone" as const,
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

  // The zone's override when it has one, the standard price when it does
  // not (#860). Neither: no price, which the Plan step asks a person for.
  const rate = petWasteVisitRate(standard, z);
  if (!rate && mode === "flat") {
    return {
      available: true as const,
      quote: {
        zoneId: z.id as string,
        zoneName: z.name as string,
        priceSource: null,
        pricingMode: mode,
        areaBasisCents: null,
        basePriceCents: null,
        perDogAddlCents: 0,
        recurringPriceCents: null,
        initialCleanupCents: z.initial_cleanup_cents ?? 0,
        currency: org.currency as string,
        commercial: null,
      },
    };
  }
  const { computeZoneVisitPrice } = await import("@/lib/pricing");
  const price = computeZoneVisitPrice(
    {
      base_price_cents: rate?.baseCents ?? 0,
      per_dog_addl_cents: rate?.perDogCents ?? 0,
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
      priceSource: rate?.source ?? null,
      pricingMode: mode,
      areaBasisCents: price.areaBasisCents,
      basePriceCents: price.perVisitCents,
      perDogAddlCents: rate?.perDogCents ?? 0,
      recurringPriceCents: price.recurringCents,
      initialCleanupCents: z.initial_cleanup_cents ?? 0,
      currency: org.currency as string,
      commercial: null,
    },
  };
}

/** The zone a ZIP's Census center falls in, for an address with no pin.
 *  Null when no drawn zone's search box holds the ZIP's center, or when the
 *  lookup fails: the Plan step then says no zone matches, as it did before. */
async function matchByZipCenter(
  supabase: any,
  orgId: string,
  zones: any[],
  data: InternalQuoteInput,
  matchZone: typeof import("@/lib/zone-match").matchZone,
) {
  const zip = data.postalCode.trim().match(/^(\d{5})(?:-\d{4})?$/)?.[1];
  if (!zip) return null;
  const { zoneShape } = await import("@/lib/lead-service-area");
  const { zipCentroidsForShape } = await import("@/lib/zone-zip-fill.server");
  for (const zone of zones) {
    if (zone.enabled === false) continue;
    const shape = zoneShape(zone);
    if (!shape) continue;
    try {
      const found = await zipCentroidsForShape(supabase, orgId, shape);
      if (found.status !== "ok") continue;
      const c = found.centroids.find((x) => x.zip === zip);
      if (!c) continue;
      return matchZone(zones, {
        postalCode: zip,
        point: { lat: c.lat, lng: c.lng },
        accountType: data.accountType ?? null,
      });
    } catch (e) {
      console.error(`[internal-quote] ZIP center lookup failed for org ${orgId}:`, e);
    }
  }
  return null;
}
