// Book a groom for pets the office already has on file.
//
// One path for a single appointment and for every N weeks. The price and the
// length are the quote for these pets and these add-ons (groomQuote), stored
// on the visit so the route planner and the invoice read the same numbers.
// A customer cannot reach this: the portal, public signup and the receptionist
// leave mobile grooming out.

import {
  COAT_TYPES,
  groomQuote,
  groomQuoteSummary,
  petSize,
  type CoatType,
  type PetSize,
} from "@/lib/groom";
import { groomVaccineDecision, vaccineStatus, type VaccineRule } from "@/lib/vaccines";
import { loadVaccineSettings } from "@/lib/vaccines.server";

export type BookGroomInput = {
  orgId: string;
  actorUserId: string | null;
  clientId: string;
  propertyId: string;
  serviceId: string;
  petIds: string[];
  addons: { addonServiceId: string; quantity: number }[];
  scheduledOn: string;
  /** Null is one appointment. 6 is every 42 days. */
  everyWeeks: number | null;
  staffId: string | null;
  parkingNotes: string | null;
  acknowledgeWarning: boolean;
};

export type BookGroomResult = {
  visitId: string;
  subscriptionId: string;
  scheduledOn: string;
  minutes: number;
  cents: number;
  summary: string;
  visitCount: number;
  assigned: boolean;
  assignWarning: string | null;
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function asCoat(value: unknown): CoatType | null {
  return typeof value === "string" && (COAT_TYPES as readonly string[]).includes(value)
    ? (value as CoatType)
    : null;
}

function asSize(weightClass: unknown, weightLb: unknown): PetSize | null {
  const lb = weightLb == null || weightLb === "" ? null : Number(weightLb);
  return petSize(
    typeof weightClass === "string" ? weightClass : null,
    lb != null && Number.isFinite(lb) ? lb : null,
  );
}

export async function bookGroomAppointment(
  db: any,
  input: BookGroomInput,
): Promise<BookGroomResult> {
  const petIds = [...new Set(input.petIds)];
  if (petIds.length === 0) throw new Error("Choose at least one pet at this address.");

  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, organization_id, account_type, display_name")
    .eq("id", input.clientId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!client || client.organization_id !== input.orgId)
    throw new Error("That client is not in your organization.");

  const { data: prop, error: pErr } = await db
    .from("properties")
    .select("id, client_id, zone_id, auto_zone_id, total_units")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!prop || prop.client_id !== input.clientId)
    throw new Error("That property belongs to a different client.");

  const { data: svc, error: sErr } = await db
    .from("services")
    .select(
      "id, name, organization_id, active, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
    )
    .eq("id", input.serviceId)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (!svc || svc.organization_id !== input.orgId || !svc.active)
    throw new Error("That service is not offered.");
  if (svc.service_line !== "mobile_grooming")
    throw new Error("Book a groom from a mobile grooming service.");

  const { data: dogRows, error: dErr } = await db
    .from("dogs")
    .select("id, name, weight_class, weight_lb, coat_type")
    .eq("property_id", input.propertyId)
    .eq("organization_id", input.orgId)
    .in("id", petIds)
    .not("active", "is", false);
  if (dErr) throw new Error(dErr.message);
  const dogs = (dogRows ?? []) as Array<{
    id: string;
    name: string;
    weight_class: string | null;
    weight_lb: number | string | null;
    coat_type: string | null;
  }>;
  if (dogs.length !== petIds.length) throw new Error("Choose pets that live at this address.");

  const { data: ruleRows, error: rErr } = await db
    .from("service_size_rules")
    .select("size, coat_type, duration_min, price_cents")
    .eq("service_id", svc.id)
    .eq("organization_id", input.orgId);
  if (rErr) throw new Error(rErr.message);

  const wanted = new Map(input.addons.map((a) => [a.addonServiceId, a.quantity]));
  let addonRows: Array<{
    id: string;
    name: string;
    unit_price_cents: number;
    duration_min: number | null;
    service_line: string | null;
    active: boolean;
  }> = [];
  if (wanted.size > 0) {
    const { data, error } = await db
      .from("addon_services")
      .select("id, name, unit_price_cents, duration_min, service_line, active")
      .eq("organization_id", input.orgId)
      .in("id", [...wanted.keys()]);
    if (error) throw new Error(error.message);
    addonRows = data ?? [];
    if (addonRows.length !== wanted.size) throw new Error("That add-on is not on this groom.");
    for (const row of addonRows) {
      if (!row.active) throw new Error("That add-on is not on this groom.");
      if (row.service_line && row.service_line !== "mobile_grooming")
        throw new Error("That add-on is not on this groom.");
    }
  }

  const pets = dogs.map((d) => ({
    id: d.id,
    name: d.name,
    size: asSize(d.weight_class, d.weight_lb),
    coat_type: asCoat(d.coat_type),
  }));
  const quote = groomQuote({
    service: svc,
    rules: (ruleRows ?? []) as Array<{
      size: PetSize;
      coat_type: CoatType | null;
      duration_min: number;
      price_cents: number;
    }>,
    pets,
    addons: addonRows.map((row) => ({
      id: row.id,
      name: row.name,
      unit_price_cents: row.unit_price_cents,
      duration_min: row.duration_min ?? 0,
      quantity: wanted.get(row.id) ?? 1,
    })),
  });
  if (quote.cents == null || quote.minutes < 1)
    throw new Error("Set a price and a length for this groom before booking.");
  // The visit line is the pets. Add-ons are their own charges, and the invoice
  // reads both, so storing the combined total here would bill the add-ons twice.
  const petCents = quote.pets.reduce((sum, pet) => sum + (pet.cents ?? 0), 0);

  const settings = await loadVaccineSettings(db, input.orgId);
  if (settings.enabled && settings.rule !== "off") {
    const { data: records, error: vErr } = await db
      .from("pet_vaccinations")
      .select("dog_id, vaccine, expires_on, source, verified_at")
      .eq("organization_id", input.orgId)
      .in("dog_id", petIds);
    if (vErr) throw new Error(vErr.message);
    const byDog = new Map<string, typeof records>();
    for (const row of records ?? []) {
      const list = byDog.get(row.dog_id) ?? [];
      list.push(row);
      byDog.set(row.dog_id, list);
    }
    let warn = false;
    for (const id of petIds) {
      const status = vaccineStatus(byDog.get(id) ?? [], settings.required, input.scheduledOn);
      const decision = groomVaccineDecision(settings.rule as VaccineRule, status);
      if (decision === "block")
        throw new Error(
          "A required vaccine is expired or missing, and this business blocks the booking until it is current.",
        );
      if (decision === "warn") warn = true;
    }
    if (warn && !input.acknowledgeWarning)
      throw new Error("Confirm the vaccine warning to book this groom.");
  }

  if (input.parkingNotes != null) {
    const { error } = await db
      .from("properties")
      .update({ parking_notes: input.parkingNotes.trim() || null })
      .eq("id", input.propertyId)
      .eq("organization_id", input.orgId);
    if (error) throw new Error(error.message);
  }

  // Same cadence inheritance as a one-off: a new plan must not flip a prepaid
  // client to postpaid by taking the column default. Read before the insert,
  // or this plan would be the newest active row and answer about itself.
  let cadence: "postpaid" | "prepaid" = "postpaid";
  {
    const { data: newest } = await db
      .from("subscriptions")
      .select("billing_cadence")
      .eq("client_id", input.clientId)
      .eq("status", "active")
      .order("started_on", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const c = (newest as { billing_cadence?: string } | null)?.billing_cadence;
    if (c === "prepaid" || c === "postpaid") cadence = c;
  }

  const accountType = client.account_type === "commercial" ? "commercial" : "residential";
  const once = input.everyWeeks == null;
  const summary = groomQuoteSummary(svc.name, pets).slice(0, 240);
  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .insert({
      organization_id: input.orgId,
      client_id: input.clientId,
      property_id: input.propertyId,
      account_type: accountType,
      frequency: once ? "one_time" : "every_n_days",
      interval_days: once ? null : input.everyWeeks! * 7,
      price_cents: petCents,
      billing_cadence: cadence,
      service_id: svc.id,
      dog_count: accountType === "residential" ? pets.length : null,
      unit_count: accountType === "commercial" ? Math.max(1, prop.total_units ?? 1) : null,
      zone_id: prop.zone_id ?? prop.auto_zone_id ?? null,
      priced_from_zone_id: null,
      priced_at: new Date().toISOString(),
      started_on: input.scheduledOn,
      ends_on: once ? input.scheduledOn : null,
    })
    .select("id")
    .single();
  if (subErr) throw new Error(subErr.message);

  const through = once ? input.scheduledOn : addDays(input.scheduledOn, 60);
  const { error: gErr } = await db.rpc("generate_visits_for_subscription", {
    _org_id: input.orgId,
    _subscription_id: sub.id,
    _through: through,
  });
  if (gErr) {
    await db.from("subscriptions").delete().eq("id", sub.id).eq("organization_id", input.orgId);
    throw new Error(gErr.message);
  }

  const { data: visitRows, error: visitErr } = await db
    .from("visits")
    .select("id, scheduled_on")
    .eq("subscription_id", sub.id)
    .eq("organization_id", input.orgId)
    .order("scheduled_on", { ascending: true });
  if (visitErr) throw new Error(visitErr.message);
  const visits = (visitRows ?? []) as Array<{ id: string; scheduled_on: string }>;
  const first = visits.find((v) => v.scheduled_on === input.scheduledOn);
  if (!first) {
    await db.from("subscriptions").delete().eq("id", sub.id).eq("organization_id", input.orgId);
    throw new Error(
      `Nothing could be scheduled on ${input.scheduledOn}. It is a blackout day, outside your work days, or inside a hold on this client. The booking was not saved, so pick another date and try again.`,
    );
  }

  // The visit is already on the schedule. Throwing here would invite a second
  // booking of the same pets on the same day.
  let stampWarning: string | null = null;
  const { error: stampErr } = await db
    .from("visits")
    .update({
      duration_min: quote.minutes,
      price_cents: petCents,
      groom_summary: summary,
    })
    .eq("subscription_id", sub.id)
    .eq("organization_id", input.orgId);
  if (stampErr) stampWarning = stampErr.message;

  // A charge that fails must not look like the booking failed. The visit is
  // already on the schedule, and booking again would invoice it twice.
  let chargeWarning: string | null = null;
  for (const visit of visits) {
    if (chargeWarning) break;
    for (const addon of quote.addons) {
      if (addon.quantity < 1 || addon.cents == null) continue;
      const { error } = await db.rpc("create_addon_charge", {
        _client_id: input.clientId,
        _addon_service_id: addon.id,
        _quantity: addon.quantity,
        _visit_id: visit.id,
        _source: "office",
        _description: addon.name,
        _note: "Booked with the groom",
      });
      if (error) {
        chargeWarning = error.message;
        break;
      }
    }
  }

  let assigned = false;
  let assignWarning: string | null = null;
  if (input.staffId) {
    assigned = true;
    for (const visit of visits) {
      const { error } = await db.rpc("reassign_visit", {
        _visit_id: visit.id,
        _staff_id: input.staffId,
      });
      if (error) {
        assigned = false;
        assignWarning = error.message;
        break;
      }
    }
  }

  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(db, {
      orgId: input.orgId,
      clientId: input.clientId,
      propertyId: input.propertyId,
      subscriptionId: sub.id,
      actorUserId: input.actorUserId,
      kind: "visit.created",
      summary: `Booked ${summary} on ${input.scheduledOn} (${quote.minutes} min, $${(quote.cents / 100).toFixed(2)})`,
      meta: {
        minutes: quote.minutes,
        total_cents: quote.cents,
        every_weeks: input.everyWeeks,
      },
    });
  } catch {
    // The timeline is best-effort. The visit is booked either way.
  }

  return {
    visitId: first.id,
    subscriptionId: sub.id as string,
    scheduledOn: first.scheduled_on,
    minutes: quote.minutes,
    cents: quote.cents,
    summary,
    visitCount: visits.length,
    assigned,
    assignWarning: [assignWarning, chargeWarning, stampWarning].filter(Boolean).join(" ") || null,
  };
}
