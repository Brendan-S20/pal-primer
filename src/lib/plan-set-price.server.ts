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
//     wizard asked, with the business's frequency multipliers. Since #860
//     that is the zone's override inside a zone that has one, and the
//     service's standard price everywhere else (standard-price.ts).
//
// Null when there is no set price: no zone covers the address, the zone has no
// rates for this kind of account, the service has no price, or the plan is a
// one-time job (the wizard never quotes one). Somebody who sets prices books
// that one, and the refusal says so.

import { isZonePriced, servicePriceCents } from "@/lib/services";
import { internalQuote } from "@/lib/internal-quote.server";

export const NO_PLAN_SET_PRICE_ZONE =
  "No pricing zone covers this address and there is no standard price in Settings → Services, so there is no set price for this plan. Save the client with the plan skipped, and ask somebody who sets prices to add it.";
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
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
  });
  if (!q.available) return none(NO_PLAN_SET_PRICE_ZONE);
  const cents = q.quote.recurringPriceCents;
  if (cents == null) return none(NO_PLAN_SET_PRICE_RATES);
  return { cents, zoneId: q.quote.zoneId ?? null, reason: null };
}

/**
 * Write a plan at the set price, as the service role (#728).
 *
 * The subscriptions write policy is manage_pricing and stays so, so a
 * dispatcher's own key cannot write this row. onboardClient calls this only
 * after planSetPriceCents has fixed the price and zone, and only for the
 * client and property it has just created with the caller's own key. The
 * service role is not asked to trust that: the client and property are read
 * back here and must both belong to the caller's business, and the property
 * to the client, before anything is written.
 */
export async function insertPlanAtSetPrice(row: {
  organization_id: string;
  client_id: string;
  property_id: string;
  price_cents: number;
  [column: string]: unknown;
}): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const [{ data: client, error: cErr }, { data: property, error: pErr }] = await Promise.all([
    admin.from("clients").select("id, organization_id").eq("id", row.client_id).maybeSingle(),
    admin
      .from("properties")
      .select("id, organization_id, client_id")
      .eq("id", row.property_id)
      .maybeSingle(),
  ]);
  if (cErr) return { data: null, error: cErr };
  if (pErr) return { data: null, error: pErr };
  if (
    !client ||
    !property ||
    client.organization_id !== row.organization_id ||
    property.organization_id !== row.organization_id ||
    property.client_id !== row.client_id
  )
    return { data: null, error: { message: "That client is not in your organization" } };
  return admin.from("subscriptions").insert(row).select("id").single();
}
