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

// ── An EXISTING client's plans (#728, owner decision 2026-11-10) ───────────
//
// "Yes, dispatchers can manage plans at the set price". A dispatcher holds
// manage_plans: they add a plan to a client who already exists, at the set
// price this file works out, and pause, resume and end plans. They do not
// hold manage_pricing, so the subscriptions write policy still refuses their
// own key, and the server writes for them as the service role, through the two
// functions below, which never write a row outside the caller's business.

/** A schedule the business has no set price for (every 3+ weeks, every X days):
 *  the zone multipliers name weekly, every two weeks, twice weekly and monthly. */
export const NO_PLAN_SET_PRICE_SCHEDULE =
  "This schedule has no set price. Choose weekly, every 2 weeks, twice weekly or monthly, or ask somebody who sets prices to add it.";
/** What a person without manage_pricing is told when they try to edit a plan. */
export const PLAN_EDIT_IS_PRICING =
  "Only someone who sets prices can edit a plan's price or terms. You can pause, resume or end it, or add a new plan at the set price.";
/** Deleting a plan is not on the dispatcher's list (add, pause, resume, end). */
export const PLAN_DELETE_IS_PRICING =
  "Only someone who sets prices can delete a plan. End it instead; its history is kept.";

/** The zone multiplier's name for a schedule, or null when the business has
 *  no set price for it. Every 2 weeks is stored as weekly + interval 2 by the
 *  drawer and as biweekly by older rows; both are the biweekly price. */
export function setPriceFrequency(input: {
  frequency: string;
  intervalWeeks?: number | null;
}): PlanSetPriceInput["frequency"] | null {
  switch (input.frequency) {
    case "weekly": {
      const n = input.intervalWeeks ?? 1;
      if (n === 1) return "weekly";
      if (n === 2) return "biweekly";
      return null;
    }
    case "biweekly":
    case "twice_weekly":
    case "monthly":
    case "one_time":
      return input.frequency;
    default:
      return null;
  }
}

export type ExistingClientPlanInput = {
  orgId: string;
  clientId: string;
  propertyId: string;
  frequency: string;
  intervalWeeks?: number | null;
  serviceId?: string | null;
  dogCount?: number | null;
  unitCount?: number | null;
};

/**
 * The set price of a plan on a client who already exists: the property's own
 * address, pin and yard, the client's account type, and the business's zones
 * and services. Read with the CALLER's key, so another business's client or
 * property is simply not found.
 */
export async function existingClientPlanSetPrice(
  db: any,
  input: ExistingClientPlanInput,
): Promise<PlanSetPrice & { accountType: "residential" | "commercial" }> {
  const [{ data: client, error: cErr }, { data: property, error: pErr }] = await Promise.all([
    db
      .from("clients")
      .select("id, organization_id, account_type")
      .eq("id", input.clientId)
      .eq("organization_id", input.orgId)
      .maybeSingle(),
    db
      .from("properties")
      .select("id, organization_id, client_id, postal_code, latitude, longitude, boundary_area_sqm")
      .eq("id", input.propertyId)
      .eq("organization_id", input.orgId)
      .maybeSingle(),
  ]);
  if (cErr) throw new Error(cErr.message);
  if (pErr) throw new Error(pErr.message);
  if (!client) throw new Error("That client was not found.");
  if (!property || property.client_id !== client.id)
    throw new Error("That property is not this client's.");
  const accountType: "residential" | "commercial" =
    client.account_type === "commercial" ? "commercial" : "residential";

  const frequency = setPriceFrequency(input);
  if (!frequency) {
    // A walk, a sit or a groom is priced per visit by its service whatever the
    // schedule; only a zone-priced plan needs the multiplier's name.
    let zonePriced = true;
    if (input.serviceId) {
      const { data: svc } = await db
        .from("services")
        .select("service_line, price_unit")
        .eq("id", input.serviceId)
        .maybeSingle();
      zonePriced = !svc || isZonePriced(svc);
    }
    if (zonePriced)
      return { cents: null, zoneId: null, reason: NO_PLAN_SET_PRICE_SCHEDULE, accountType };
  }

  let stationCount = 0;
  if (accountType === "commercial") {
    const { count } = await db
      .from("waste_stations")
      .select("id", { count: "exact", head: true })
      .eq("property_id", property.id)
      .eq("organization_id", input.orgId);
    stationCount = count ?? 0;
  }

  const set = await planSetPriceCents(db, {
    orgId: input.orgId,
    accountType,
    frequency: frequency ?? "weekly",
    serviceId: input.serviceId ?? null,
    postalCode: property.postal_code ?? "",
    latitude: property.latitude ?? undefined,
    longitude: property.longitude ?? undefined,
    boundaryAreaSqm:
      property.boundary_area_sqm != null ? Number(property.boundary_area_sqm) : undefined,
    dogCount: accountType === "residential" ? Math.max(1, input.dogCount ?? 1) : 1,
    unitCount: accountType === "commercial" ? Math.max(1, input.unitCount ?? 1) : undefined,
    stationCount: accountType === "commercial" ? stationCount : undefined,
  });
  return { ...set, accountType };
}

/**
 * Change a plan's status or end it as the service role, for a caller who
 * manages plans but not prices. Only the columns a pause, resume or end
 * writes may be passed, never a price; the update is filtered on the
 * caller's business AND the status the caller saw, so another business's plan,
 * or one that moved underneath them, is written nowhere.
 */
const LIFECYCLE_COLUMNS = new Set([
  "status",
  "paused_at",
  "ends_on",
  "end_reason",
  "end_notes",
  "ended_by",
  "last_changed_by",
  "last_changed_at",
]);

export async function updatePlanLifecycleAsServer(
  orgId: string,
  subscriptionId: string,
  patch: Record<string, unknown>,
  onlyIfStatus?: string,
): Promise<{ error: { message: string } | null }> {
  for (const column of Object.keys(patch))
    if (!LIFECYCLE_COLUMNS.has(column))
      return { error: { message: `A plan change may not write ${column}` } };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let q = (supabaseAdmin as any)
    .from("subscriptions")
    .update(patch)
    .eq("id", subscriptionId)
    .eq("organization_id", orgId);
  if (onlyIfStatus) q = q.eq("status", onlyIfStatus);
  const { data, error } = await q.select("id");
  if (error) return { error };
  if (!data?.length) return { error: { message: "That plan was not found, or it just changed. Refresh and try again." } };
  return { error: null };
}
