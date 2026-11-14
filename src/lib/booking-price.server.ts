// What a one-off visit costs at the price the business already set (#616).
//
// A dispatcher books (the booking permission) but does not set prices
// (manage_pricing). So a dispatcher's one-off is booked at this price and no
// other, and createOneOffVisit refuses a typed price that differs from it.
//
// The set price is the one the portal's auto-accept already books at
// (portal.functions.ts, requestOneOffVisit): the extra cleanup at
// organizations.one_off_price_cents, anything else at its service's own price
// for the property's dogs through servicePriceCents. No service named means
// the business's default, which is pet waste (ensure_default_services).
//
// #860: a pet-waste one-off with no extra-visit price set is booked at the
// standard price instead (the service's, from Settings → Services), or at the
// override of the zone the property is in. The same rule as a new plan
// (standard-price.ts), for one visit at the property's dogs.
//
// Null when there is no set price: no extra-visit price, no standard price
// and no zone override, or a service with none. Somebody who sets prices
// books that one.

import { ONE_OFF_PRICE_SETTING, isZonePriced, servicePriceCents } from "@/lib/services";

export type OneOffGridPrice = { cents: number; reason: null } | { cents: null; reason: string };

// Names the field that fixes it (#641): Business defaults and the Services
// pet-waste price look like the one-off price and are not.
export const NO_ONE_OFF_PRICE = `This business has no one-off price set yet. It is set in ${ONE_OFF_PRICE_SETTING}. Until then, somebody who sets prices has to book this visit.`;
/** Someone who sets prices left the price blank and there is no set price. */
export const ENTER_A_ONE_OFF_PRICE = `Enter a price for this visit, or set one for every extra visit in ${ONE_OFF_PRICE_SETTING}.`;
export const NO_SERVICE_PRICE =
  "This service has no price yet, so somebody who sets prices has to book this visit.";

export async function oneOffGridPriceCents(
  db: any,
  input: { orgId: string; propertyId: string; serviceId?: string | null },
): Promise<OneOffGridPrice> {
  let service: {
    service_line: string;
    price_unit: string;
    base_price_cents: number | null;
    extra_pet_cents: number | null;
    default_duration_min: number | null;
  } | null = null;
  if (input.serviceId) {
    const { data, error } = await db
      .from("services")
      .select(
        "id, organization_id, active, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
      )
      .eq("id", input.serviceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || data.organization_id !== input.orgId || !data.active)
      throw new Error("That service is not offered");
    service = data;
  }

  if (!service || isZonePriced(service as { service_line: any })) {
    const { data: org, error } = await db
      .from("organizations")
      .select("one_off_price_cents")
      .eq("id", input.orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const cents = org?.one_off_price_cents as number | null | undefined;
    if (cents != null) return { cents, reason: null };
    const standard = await standardOneOffCents(db, input, (service as any)?.id ?? null);
    return standard == null
      ? { cents: null, reason: NO_ONE_OFF_PRICE }
      : { cents: standard, reason: null };
  }

  // The same pet count bookOneOffVisit prices with: the property's dogs for
  // a residential client, one for a commercial one.
  const { data: prop, error: pErr } = await db
    .from("properties")
    .select("id, organization_id, client:clients(account_type)")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!prop || prop.organization_id !== input.orgId)
    throw new Error("That property is not in your organization");
  const client = Array.isArray(prop.client) ? prop.client[0] : prop.client;
  if (client?.account_type === "commercial") {
    const cents = servicePriceCents(service as any, { pets: 1 });
    return cents == null ? { cents: null, reason: NO_SERVICE_PRICE } : { cents, reason: null };
  }
  const { count, error } = await db
    .from("dogs")
    .select("id", { count: "exact", head: true })
    .eq("property_id", input.propertyId)
    .eq("organization_id", input.orgId)
    .not("active", "is", false)
    .eq("species", "dog");
  if (error) throw new Error(error.message);
  const cents = servicePriceCents(service as any, { pets: Math.max(1, count ?? 1) });
  return cents == null ? { cents: null, reason: NO_SERVICE_PRICE } : { cents, reason: null };
}

/** One pet-waste visit at the standard price, or the property's zone override
 *  (#860), for the property's active dogs. Null when neither is set. */
async function standardOneOffCents(
  db: any,
  input: { orgId: string; propertyId: string },
  serviceId: string | null,
): Promise<number | null> {
  const { loadPetWasteStandard, petWasteVisitRate, rateVisitCents } =
    await import("@/lib/standard-price");
  const { data: prop, error: pErr } = await db
    .from("properties")
    .select("id, organization_id, zone_id")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!prop || prop.organization_id !== input.orgId)
    throw new Error("That property is not in your organization");
  let zone: { base_price_cents: number | null; per_dog_addl_cents: number | null } | null = null;
  if (prop.zone_id) {
    const { data: z, error: zErr } = await db
      .from("zones")
      .select("id, organization_id, base_price_cents, per_dog_addl_cents, pricing_mode")
      .eq("id", prop.zone_id)
      .maybeSingle();
    if (zErr) throw new Error(zErr.message);
    // An area-priced zone has no one-visit figure without the yard's area;
    // its flat part is not offered as if it were the whole price.
    if (z && z.organization_id === input.orgId && (z.pricing_mode ?? "flat") === "flat") zone = z;
  }
  const rate = petWasteVisitRate(await loadPetWasteStandard(db, input.orgId, serviceId), zone);
  if (!rate) return null;
  const { count, error } = await db
    .from("dogs")
    .select("id", { count: "exact", head: true })
    .eq("property_id", input.propertyId)
    .eq("organization_id", input.orgId)
    .not("active", "is", false)
    .eq("species", "dog");
  if (error) throw new Error(error.message);
  return rateVisitCents(rate, Math.max(1, count ?? 1));
}

/** What a booking without manage_pricing is refused with when the price was changed. */
export function priceOverrideRefusal(gridCents: number): string {
  return `Only someone who sets prices can change this price. The set price is $${(gridCents / 100).toFixed(2)}.`;
}
