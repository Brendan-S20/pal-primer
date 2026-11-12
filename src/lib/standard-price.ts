// One standard price per service, and a zone may override it (#860).
//
// Decision (Brendan, 2026-11-10): "Approve, but this should be a setting".
//
//   * Each service has ONE standard price, set in Settings → Services. For a
//     pet-waste service that is services.base_price_cents (+ extra_pet_cents
//     per extra dog), the same two columns every other line already priced
//     from. It is the only place the base price is set.
//   * A zone MAY override it. zones.base_price_cents is nullable since
//     migration 20261111151000: NULL means "no override, charge the
//     standard". A zone that has one wins, and only for an address inside
//     that zone. Outside every zone there is no override to apply, so the
//     office's quote is the standard price.
//   * Every reader goes through `petWasteVisitRate`: the new-client wizard
//     and onboardClient (internal-quote.server.ts), the plan form on a
//     client's Services tab, the office's one-off price
//     (booking-price.server.ts), the Zones drawer's "Standard: $X", and the
//     Services list. The online signup's public_quote applies the same rule
//     in SQL (COALESCE(zone, service)), and
//     tests/one-standard-price-a-zone-may-override.test.ts holds the two
//     copies to the same words.
//   * Changing the standard price changes what NEW plans are offered.
//     A plan's price is subscriptions.price_cents, written when the plan is
//     made, and nothing here reads or rewrites it.
//
// Pure, so the screens, the server and the tests share one copy.

import { PET_WASTE_SERVICE_NAME } from "@/lib/services";
import {
  computeZoneVisitPrice,
  type VisitPriceInput,
  type VisitPriceResult,
  type ZonePricingFields,
} from "@/lib/pricing";

/** The two columns a service's standard price lives in. */
export type StandardPriceService = {
  base_price_cents: number | null;
  extra_pet_cents: number | null;
};

/** The two columns a zone's override lives in. A NULL base is no override. */
export type ZonePriceOverride = {
  base_price_cents?: number | null;
  per_dog_addl_cents?: number | null;
};

export type PetWasteRate = {
  /** The first dog's per-visit price, before any cadence multiplier. */
  baseCents: number;
  /** Each extra dog, per visit. */
  perDogCents: number;
  /** Which setting it came from, so a screen can say which price applies. */
  source: "zone" | "standard";
};

const isCents = (c: unknown): c is number => typeof c === "number" && Number.isInteger(c) && c >= 0;

/** Whether a zone overrides the standard price. */
export function zoneOverridesPrice(zone: ZonePriceOverride | null | undefined): boolean {
  return !!zone && isCents(zone.base_price_cents);
}

/**
 * The per-visit rate for a pet-waste visit at an address:
 *
 *   the zone the address is in, when that zone has an override;
 *   otherwise the service's standard price;
 *   otherwise null ("no price yet"), never a number made up here.
 *
 * Pass `zone` only when the address is inside it. A zone the address is not
 * in is not an override for it, which is the whole of "an override applies
 * only inside its zone".
 */
export function petWasteVisitRate(
  service: StandardPriceService | null | undefined,
  zone: ZonePriceOverride | null | undefined,
): PetWasteRate | null {
  if (zone && zoneOverridesPrice(zone)) {
    return {
      baseCents: zone.base_price_cents as number,
      perDogCents: isCents(zone.per_dog_addl_cents) ? zone.per_dog_addl_cents : 0,
      source: "zone",
    };
  }
  if (service && isCents(service.base_price_cents)) {
    return {
      baseCents: service.base_price_cents,
      perDogCents: isCents(service.extra_pet_cents) ? service.extra_pet_cents : 0,
      source: "standard",
    };
  }
  return null;
}

/** One visit for this many dogs at a rate, before any cadence multiplier. */
export function rateVisitCents(
  rate: Pick<PetWasteRate, "baseCents" | "perDogCents">,
  dogs: number,
) {
  const n = Number.isFinite(dogs) && dogs >= 1 ? Math.floor(dogs) : 1;
  return rate.baseCents + (n - 1) * rate.perDogCents;
}

/** A zone's pricing columns as any reader has them: the override pair plus
 *  the area rate. Every field optional, because the readers select
 *  different subsets. */
export type ZoneVisitPricing = Omit<Partial<ZonePricingFields>, keyof ZonePriceOverride> &
  ZonePriceOverride;

export type PetWasteZoneVisitPrice = VisitPriceResult & {
  /** The first dog's per-visit base the price was built from. */
  baseCents: number;
  /** Each extra dog, per visit. */
  perDogCents: number;
  /** The area charge in perVisitCents (0 when the zone is flat). */
  areaCents: number;
  /** Where the base came from: the zone's override, the standard price, or
   *  nothing (an area-priced zone with neither, which charges its area). */
  source: "zone" | "standard" | null;
};

/**
 * THE per-visit price of a residential pet-waste visit in a zone (#860
 * review): every screen that prices one calls this, so the new-client wizard,
 * the dispatcher's set price, a quote and the client's plan form cannot
 * disagree.
 *
 *   base   = the zone's override when it has one, else the standard price
 *            (petWasteVisitRate);
 *   + area = the zone's area charge, when the zone prices by yard size,
 *            whether or not it overrides the base;
 *   + dogs = extra dogs at the same rate the base came from.
 *
 * Before the review, an area-priced zone with no override was priced three
 * ways: standard + area (wizard), $0 + area (quotes) and standard with no
 * area (plan form).
 *
 * Null when there is no price: no override and no standard price, and no
 * area charge to fall back on (no zone, or a flat zone).
 */
export function petWasteZoneVisitPrice(
  service: StandardPriceService | null | undefined,
  zone: ZoneVisitPricing | null | undefined,
  input: VisitPriceInput,
): PetWasteZoneVisitPrice | null {
  const rate = petWasteVisitRate(service, zone ?? null);
  const mode = zone?.pricing_mode ?? "flat";
  if (!rate && (!zone || mode === "flat")) return null;
  const baseCents = rate?.baseCents ?? 0;
  const perDogCents = rate?.perDogCents ?? 0;
  const r = computeZoneVisitPrice(
    {
      base_price_cents: baseCents,
      per_dog_addl_cents: perDogCents,
      pricing_mode: zone ? mode : "flat",
      price_per_sqft_cents: Number(zone?.price_per_sqft_cents ?? 0),
      price_per_acre_cents: zone?.price_per_acre_cents ?? 0,
      area_min_charge_cents: zone?.area_min_charge_cents ?? 0,
      area_max_charge_cents: zone?.area_max_charge_cents ?? null,
    },
    input,
  );
  const dogs = Math.max(0, input.dogCount - 1) * perDogCents;
  return {
    ...r,
    baseCents,
    perDogCents,
    areaCents: r.perVisitCents - baseCents - dogs,
    source: rate?.source ?? null,
  };
}

type CatalogRow = StandardPriceService & {
  id: string;
  name: string;
  service_line: string;
  active: boolean;
  created_at?: string | null;
};

/**
 * The pet-waste service a plan with no service named is priced from: the
 * active one the seed named "Pet waste removal", else the first active
 * pet-waste service by name. public_quote picks the same one in SQL.
 */
export function defaultPetWasteService<S extends CatalogRow>(services: readonly S[]): S | null {
  const pw = services
    .filter((s) => s.active && s.service_line === "pet_waste")
    .sort(
      (a, b) =>
        Number(b.name === PET_WASTE_SERVICE_NAME) - Number(a.name === PET_WASTE_SERVICE_NAME) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
  return pw[0] ?? null;
}

/**
 * The pet-waste standard price for a plan: the named pet-waste service's, or
 * the business's default pet-waste service's when none is named. Server-side;
 * `db` is a Supabase client scoped to the caller (RLS) or the service role.
 */
export async function loadPetWasteStandard(
  db: any,
  orgId: string,
  serviceId?: string | null,
): Promise<(StandardPriceService & { id: string; name: string }) | null> {
  const { data, error } = await db
    .from("services")
    .select("id, name, service_line, active, base_price_cents, extra_pet_cents")
    .eq("organization_id", orgId)
    .eq("service_line", "pet_waste");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as CatalogRow[];
  if (serviceId) {
    const named = rows.find((r) => r.id === serviceId);
    if (named) return named;
  }
  return defaultPetWasteService(rows);
}

/** The zone drawer's line beside its override. */
export function standardPriceLine(standardCents: number | null): string {
  return standardCents == null
    ? "Standard: not set yet (Settings → Services)"
    : `Standard: $${(standardCents / 100).toFixed(2)}`;
}

/**
 * What setup's first area gets as its own price (#860 review): nothing when
 * the price setup was given IS the standard price, so the area follows
 * Settings → Services; an override only when the two differ (an owner who
 * had already set a different standard, then typed another number here).
 * Spread into createZone's input.
 */
export function setupZoneOverride(
  typed: { basePriceCents: number; perDogAddlCents: number },
  standard: { baseCents: number | null; perDogCents: number | null },
): { basePriceCents?: number; perDogAddlCents?: number } {
  if (
    standard.baseCents === typed.basePriceCents &&
    (standard.perDogCents ?? 0) === typed.perDogAddlCents
  )
    return {};
  return { basePriceCents: typed.basePriceCents, perDogAddlCents: typed.perDogAddlCents };
}
