// What a new client's plan costs at the price the business already set (#728).
//
// A dispatcher books (the booking permission) but does not set prices
// (manage_pricing). The one-off half of that was #616 (booking-price.server.ts).
// This is the plan half: the new-client wizard's Plan step was refused to a
// dispatcher outright, by the subscriptions write policy, so the front desk
// could add a household and could not start its service.
//
// The set price is exactly what the wizard's Plan step shows before anybody
// types over it:
//   * a service that is not zone-priced (a walk, a sit, a groom): its own
//     price for the pets, through servicePriceCents, as the wizard does;
//   * anything else: the zone quote (internalQuote), the same function the
//     wizard asked, with the business's frequency multipliers.
//
// Null when there is no set price: no zone covers the address, the zone has no
// rates for this kind of account, the service has no price, or the plan is a
// one-time job (the wizard never quotes one). Somebody who sets prices books
// that one, and the refusal says so.

import { isZonePriced, servicePriceCents } from "@/lib/services";
import { internalQuote } from "@/lib/internal-quote.server";

export const NO_PLAN_SET_PRICE_ZONE =
  "No pricing zone covers this address, so there is no set price for this plan. Save the client with the plan skipped, and ask somebody who sets prices to add it.";
export const NO_PLAN_SET_PRICE_RATES =
  "The pricing zone for this address has no rates for this kind of account, so there is no set price for this plan. Save the client with the plan skipped, and ask somebody who sets prices to add it.";
export const NO_PLAN_SET_PRICE_SERVICE =
  "This service has no price yet, so there is no set price for this plan. Save the client with the plan skipped, and ask somebody who sets prices to add it.";
export const NO_PLAN_SET_PRICE_ONE_TIME =
  "A one-time job has no set price. Book it as a one-off visit from the client's Visits tab once the client is saved.";
/** The billing cadence is a billing decision, which a dispatcher does not make. */
export const PLAN_CADENCE_IS_BILLING =
  "Only someone who manages billing can bill a plan in advance. Save it billed after each visit, and ask them to change it.";

export type PlanSetPrice =
  | { cents: number; zoneId: string | null; reason: null }
  | { cents: null; zoneId: null; reason: string };

export type PlanSetPriceInput = {
  orgId: string;
  accountType: "residential" | "commercial";
  frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly" | "one_time";
  serviceId?: string | null;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  boundaryAreaSqm?: number;
  dogCount: number;
  unitCount?: number;
  stationCount?: number;
};

export async function planSetPriceCents(db: any, input: PlanSetPriceInput): Promise<PlanSetPrice> {
  const none = (reason: string): PlanSetPrice => ({ cents: null, zoneId: null, reason });

  if (input.serviceId) {
    const { data: service, error } = await db
      .from("services")
      .select(
        "id, organization_id, active, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
      )
      .eq("id", input.serviceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Another business's service, or one that is switched off, is not this
    // business's set price for anything.
    if (!service || service.organization_id !== input.orgId || !service.active)
      throw new Error("That service is not offered");
    if (!isZonePriced(service)) {
      const cents = servicePriceCents(service, { pets: Math.max(1, input.dogCount) });
      return cents == null
        ? none(NO_PLAN_SET_PRICE_SERVICE)
        : { cents, zoneId: null, reason: null };
    }
  }

  if (input.frequency === "one_time") return none(NO_PLAN_SET_PRICE_ONE_TIME);

  const q = await internalQuote(db, input.orgId, {
    postalCode: input.postalCode,
    accountType: input.accountType,
    dogCount: Math.max(1, input.dogCount),
    frequency: input.frequency,
    boundaryAreaSqm: input.boundaryAreaSqm,
    latitude: input.latitude,
    longitude: input.longitude,
    ...(input.accountType === "commercial"
      ? { unitCount: input.unitCount ?? 1, stationCount: input.stationCount ?? 0 }
      : {}),
  });
  if (!q.available) return none(NO_PLAN_SET_PRICE_ZONE);
  const cents = q.quote.recurringPriceCents;
  if (cents == null) return none(NO_PLAN_SET_PRICE_RATES);
  return { cents, zoneId: q.quote.zoneId, reason: null };
}
