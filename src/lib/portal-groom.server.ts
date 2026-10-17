// The customer portal's Grooming page, server side. Every read is scoped to
// the portal session's own client and runs on the service role, like
// portal.functions.ts. Nothing here books a visit: a request lands in the
// office's Concerns inbox and the office books it with the start time and
// groomer it chooses.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { PortalSession } from "@/lib/portal-auth.server";
import {
  COAT_TYPES,
  DEFAULT_GROOM_BUFFER_MIN,
  petSize,
  type CoatType,
  type PetSize,
} from "@/lib/groom";
import {
  GROOM_WINDOWS,
  groomRequestQuote,
  groomRequestRefusal,
  type GroomRequestAddon,
  type GroomWindow,
} from "@/lib/groom-request";
import { customerCanRequestService, serviceLinesOrDefault } from "@/lib/service-lines";
import { orgToday } from "@/lib/org-day";

type Db = SupabaseClient<Database>;

function coatOf(value: unknown): CoatType | null {
  return typeof value === "string" && (COAT_TYPES as readonly string[]).includes(value)
    ? (value as CoatType)
    : null;
}

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export async function loadPortalGroom(db: Db, session: PortalSession) {
  const org = must(
    await db
      .from("organizations")
      .select("service_lines, timezone, groom_buffer_min, work_days")
      .eq("id", session.organizationId)
      .maybeSingle(),
  );
  if (!org || !serviceLinesOrDefault(org.service_lines).includes("mobile_grooming")) {
    return { visible: false as const };
  }

  const props =
    must(
      await db
        .from("properties")
        .select("id, street, city")
        .eq("organization_id", session.organizationId)
        .eq("client_id", session.clientId)
        .is("archived_at", null),
    ) ?? [];
  const propertyIds = props.map((p) => p.id);

  const [dogs, services, rules, addons, requests] = await Promise.all([
    propertyIds.length
      ? db
          .from("dogs")
          .select("id, name, breed, weight_class, weight_lb, coat_type, property_id")
          .eq("organization_id", session.organizationId)
          .in("property_id", propertyIds)
          .not("active", "is", false)
          .order("name")
      : Promise.resolve({ data: [], error: null }),
    db
      .from("services")
      .select("id, name, price_unit, base_price_cents, extra_pet_cents, default_duration_min")
      .eq("organization_id", session.organizationId)
      .eq("service_line", "mobile_grooming")
      .eq("active", true)
      .order("name"),
    db
      .from("service_size_rules")
      .select("service_id, size, coat_type, duration_min, price_cents")
      .eq("organization_id", session.organizationId),
    db
      .from("addon_services")
      .select("id, name, description, unit_price_cents, duration_min, service_line")
      .eq("organization_id", session.organizationId)
      .eq("active", true)
      .order("name"),
    db
      .from("qc_tickets")
      .select(
        "id, status, requested_on, requested_time, requested_time_end, dog_id, service_id, quoted_cents, quoted_minutes, resolution_note, created_at, booked_visit:visits!qc_tickets_booked_visit_id_fkey(scheduled_on, start_time)",
      )
      .eq("organization_id", session.organizationId)
      .eq("client_id", session.clientId)
      .eq("category", "groom_request")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  for (const res of [dogs, services, rules, addons, requests]) {
    if (res.error) throw new Error(res.error.message);
  }

  const where = new Map(props.map((p) => [p.id, [p.street, p.city].filter(Boolean).join(", ")]));
  return {
    visible: true as const,
    // Whether a client may ask for a groom here. Off while mobile grooming is
    // not a line a customer can request; the page then shows past requests
    // and vaccine records only.
    canRequest: customerCanRequestService("mobile_grooming"),
    today: orgToday(org.timezone),
    workDays: (org.work_days as number[] | null) ?? [0, 1, 2, 3, 4, 5, 6],
    bufferMin: org.groom_buffer_min ?? DEFAULT_GROOM_BUFFER_MIN,
    pets: (dogs.data ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      breed: d.breed,
      size: petSize(
        d.weight_class,
        d.weight_lb == null ? null : Number(d.weight_lb),
      ) as PetSize | null,
      coat_type: coatOf(d.coat_type),
      address: where.get(d.property_id) ?? null,
    })),
    services: (services.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      price_unit: s.price_unit as "visit" | "hour" | "night",
      base_price_cents: s.base_price_cents,
      extra_pet_cents: s.extra_pet_cents,
      default_duration_min: s.default_duration_min,
    })),
    rules: (rules.data ?? []).map((r) => ({
      service_id: r.service_id,
      size: r.size as PetSize,
      coat_type: coatOf(r.coat_type),
      duration_min: r.duration_min,
      price_cents: r.price_cents,
    })),
    addons: (addons.data ?? [])
      .filter((a) => !a.service_line || a.service_line === "mobile_grooming")
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        unit_price_cents: a.unit_price_cents,
        duration_min: a.duration_min ?? 0,
      })),
    requests: (requests.data ?? []).map((r) => {
      const booked = Array.isArray(r.booked_visit) ? r.booked_visit[0] : r.booked_visit;
      return {
        id: r.id,
        status: r.status,
        requestedOn: r.requested_on,
        from: r.requested_time,
        until: r.requested_time_end,
        dogId: r.dog_id,
        serviceId: r.service_id,
        quotedCents: r.quoted_cents,
        quotedMinutes: r.quoted_minutes,
        note: r.resolution_note,
        bookedOn: (booked?.scheduled_on as string | undefined) ?? null,
        bookedAt: (booked?.start_time as string | null | undefined) ?? null,
      };
    }),
  };
}

export type PortalGroom = Extract<Awaited<ReturnType<typeof loadPortalGroom>>, { visible: true }>;

export type PortalGroomRequestInput = {
  dogId: string;
  serviceId: string;
  addons: GroomRequestAddon[];
  day: string;
  window: GroomWindow;
  message: string;
};

/**
 * Price the groom with the office's rules, then ask portal_request_groom,
 * which refuses what the office could not book and hands back the first
 * request on a second tap. Only the call that created the request tells the
 * office.
 */
export async function requestGroomFromPortal(
  db: Db,
  session: PortalSession,
  token: string,
  input: PortalGroomRequestInput,
): Promise<{ ticketId: string; alreadyAsked: boolean; cents: number | null; minutes: number }> {
  const page = await loadPortalGroom(db, session);
  if (!page.visible) throw new Error(groomRequestRefusal("grooming_not_offered"));
  if (!page.canRequest) throw new Error(groomRequestRefusal("groom_requests_off"));
  const pet = page.pets.find((p) => p.id === input.dogId);
  if (!pet) throw new Error(groomRequestRefusal("pet_not_found"));
  const service = page.services.find((s) => s.id === input.serviceId);
  if (!service) throw new Error(groomRequestRefusal("service_not_offered"));
  if (input.addons.some((a) => !page.addons.some((x) => x.id === a.addonServiceId))) {
    throw new Error(groomRequestRefusal("addon_not_offered"));
  }

  const quote = groomRequestQuote({
    service,
    rules: page.rules,
    pet,
    addons: page.addons,
    picked: input.addons,
    bufferMin: page.bufferMin,
  });
  const window = GROOM_WINDOWS[input.window];
  const { data: rows, error } = await db.rpc("portal_request_groom", {
    _token: token,
    _dog_id: input.dogId,
    _service_id: input.serviceId,
    _addons: input.addons.map((a) => ({
      addon_service_id: a.addonServiceId,
      quantity: a.quantity,
    })),
    _on: input.day,
    // The SQL function takes NULL for these: any time of day, and no price
    // or length the rules could work out.
    _from: window.from as string,
    _until: window.until as string,
    _message: input.message,
    _quoted_cents: quote.cents as number,
    _quoted_minutes: (quote.minutes > 0 ? Math.min(quote.minutes, 720) : null) as number,
  });
  if (error) throw new Error(groomRequestRefusal(error.message));
  const row = ((rows ?? []) as Array<{ ticket_id: string; created: boolean }>)[0];
  if (!row?.ticket_id) throw new Error("That request couldn't be saved. Please try again.");
  const result = { ticketId: row.ticket_id, cents: quote.cents, minutes: quote.minutes };
  if (!row.created) return { ...result, alreadyAsked: true };

  const { formatDay } = await import("@/lib/format");
  const when = `${formatDay(input.day)}${window.from ? `, ${window.label.toLowerCase()}` : ""}`;
  const what = `${service.name} for ${pet.name}`;
  try {
    const { notifyOfficeOfConcern } = await import("@/lib/portal.functions");
    await notifyOfficeOfConcern(
      db,
      token,
      "one_off_request",
      input.message,
      when,
      false,
      `Groom (${what})`,
    );
  } catch (e) {
    console.error("groom request office email failed", (e as Error).message);
  }
  try {
    const { data: cl } = await db
      .from("clients")
      .select("display_name")
      .eq("id", session.clientId)
      .maybeSingle();
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles(["owner", "office_manager"], {
      orgId: session.organizationId,
      type: "concern",
      title: `Groom requested: ${cl?.display_name ?? "a client"}`,
      body: `${what}, ${when}${input.message ? `: ${input.message.slice(0, 120)}` : ""}`,
      link: "/concerns",
      eventKey: `groom-request:${row.ticket_id}`,
    });
  } catch (e) {
    console.error("groom request in-app notification failed", (e as Error).message);
  }
  return { ...result, alreadyAsked: false };
}
