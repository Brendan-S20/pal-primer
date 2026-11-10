import { customerCanRequestStay } from "@/lib/service-lines";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import {
  cleanMeds,
  medsProblem,
  PET_SPECIES,
  readMeds,
  SPECIES_NOTE_MAX,
  type PetCare,
} from "@/lib/pets";
import {
  arrivalWindowProblem,
  DEFAULT_OVERNIGHT_ARRIVAL,
  stayDatesProblem,
  stayKindFor,
  stayWindowsProblem,
  type StayKind,
  type StayStatus,
} from "@/lib/stays";
import { careLine, type CareRow } from "@/lib/sit-report";
import { walkReportEmail } from "@/lib/walk-report";
import { windowLabel } from "@/lib/walk-windows";

// The platform switch (#531). Server-only, so imported inside the handler.
async function loadAvailability() {
  const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
  return loadServiceLineAvailability();
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const tokenSchema = z.object({ token: z.string().uuid() });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const portalStayRequestSchema = tokenSchema.extend({
  requestKey: z.string().uuid(),
  propertyId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windows: z.array(z.object({ earliestTime: clock, latestTime: clock })).max(4),
  arrival: z.object({ earliestTime: clock, latestTime: clock }).default(DEFAULT_OVERNIGHT_ARRIVAL),
  petIds: z.array(z.string().uuid()).min(1).max(30),
  notes: z.string().trim().max(1000),
  care: z
    .array(
      z.object({
        petId: z.string().uuid(),
        feeding: z.string().max(500),
        otherCare: z.string().max(1000),
        meds: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(80),
              dose: z.string().max(80).nullable(),
              times: z.array(clock).max(6),
              notes: z.string().max(200).nullable(),
            }),
          )
          .max(20),
      }),
    )
    .max(30),
});

export type PortalStayVisit = {
  id: string;
  day: string;
  status: string;
  window: string | null;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  reportNote?: string;
  photos: Array<{ url: string; kind: string }>;
  /** What each pet got, on a completed visit. Empty before the visit is done. */
  care: PortalCareLine[];
};
export type PortalCareLine = { id: string; pet: string; line: string };
export type PortalStay = {
  id: string;
  startsOn: string;
  endsOn: string;
  kind: StayKind;
  status: StayStatus;
  serviceName: string;
  depositCents: number | null;
  depositInvoiceId: string | null;
  depositDue: boolean;
  visits: PortalStayVisit[];
};
export type PortalStayPet = {
  id: string;
  propertyId: string;
  name: string;
  species: string;
  species_note: string | null;
  care: PetCare;
};

const one = (v: any): any => (Array.isArray(v) ? v[0] : v);

/** Explicit output allowlist. Only completed visits disclose a client report
 *  or photos. Private fields on a fetched row never enter the response. */
/** One line per care-log row, oldest first. A note the sitter typed is kept
 *  when the shared line does not already include it. */
export function portalCareLines(
  rows: Array<CareRow & { id: string }>,
  pets: Array<{ id: string; name: string }>,
  timezone: string,
): PortalCareLine[] {
  const names = new Map(pets.map((p) => [p.id, (p.name ?? "").trim() || "Pet"]));
  return [...rows]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((r) => {
      const line = careLine(r, timezone);
      const note = (r.note ?? "").trim();
      const already = note && line.includes(note);
      const withNote =
        note && r.status !== "missed" && r.kind !== "meds" && !already ? `${line}. ${note}` : line;
      return {
        id: r.id,
        pet: r.pet_id ? (names.get(r.pet_id) ?? "Pet") : "All pets",
        line: withNote,
      };
    });
}

export function portalStayVisitOf(
  row: any,
  timezone: string,
  photos: PortalStayVisit["photos"],
  care: PortalCareLine[] = [],
): PortalStayVisit {
  const completed = row.status === "completed";
  const report = walkReportEmail({
    startedAt: row.started_at,
    completedAt: completed ? row.completed_at : null,
    timezone,
    pee: null,
    poo: null,
    dogNames: [],
    walkerName: null,
    reportNote: completed ? row.report_note : null,
  });
  const sub = one(row.subscriptions);
  return {
    id: row.id,
    day: row.scheduled_on,
    status: row.status,
    window: windowLabel(sub?.earliest_time, sub?.latest_time),
    startTime: report.startTime,
    endTime: report.endTime,
    durationMin: report.durationMin,
    reportNote: report.reportNote,
    photos: completed ? photos : [],
    care: completed ? care : [],
  };
}

/** One read shared by Requests, Visits and the stay deposit links. */
export const portalListStays = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    const { data: org, error: orgError } = await sb
      .from("organizations")
      .select("service_lines, timezone, currency")
      .eq("id", session.organizationId)
      .single();
    if (orgError) throw new Error(orgError.message);
    const empty = {
      offered: false,
      canRequest: false,
      currency: org.currency,
      services: [] as Array<{ id: string; name: string; price_unit: string }>,
      properties: [] as Array<{ id: string; street: string }>,
      pets: [] as PortalStayPet[],
      stays: [] as PortalStay[],
    };
    if (!org.service_lines?.includes("pet_sitting")) return empty;
    const [services, properties, stays] = await Promise.all([
      sb
        .from("services")
        .select("id, name, price_unit")
        .eq("organization_id", session.organizationId)
        .eq("service_line", "pet_sitting")
        .eq("active", true)
        .order("name"),
      sb
        .from("properties")
        .select("id, street, dogs(id, name, species, species_note, active)")
        .eq("organization_id", session.organizationId)
        .eq("client_id", session.clientId)
        .is("archived_at", null),
      sb
        .from("stays")
        .select(
          "id, starts_on, ends_on, kind, status, service_id, deposit_cents, deposit_invoice_id, services(name)",
        )
        .eq("organization_id", session.organizationId)
        .eq("client_id", session.clientId)
        .order("starts_on", { ascending: false })
        .limit(50),
    ]);
    for (const r of [services, properties, stays]) if (r.error) throw new Error(r.error.message);
    const petRows = (properties.data ?? []).flatMap((p) =>
      (p.dogs ?? []).filter((d) => d.active !== false).map((d) => ({ ...d, propertyId: p.id })),
    );
    const care = petRows.length
      ? await sb
          .from("pet_care_instructions")
          .select("pet_id, feeding, meds, other_care")
          .eq("organization_id", session.organizationId)
          .in(
            "pet_id",
            petRows.map((p) => p.id),
          )
      : { data: [], error: null };
    if (care.error) throw new Error(care.error.message);
    const careByPet = new Map((care.data ?? []).map((c) => [c.pet_id, c]));
    const pets: PortalStayPet[] = petRows.map((p) => {
      const c = careByPet.get(p.id);
      return {
        id: p.id,
        propertyId: p.propertyId,
        name: p.name,
        species: p.species,
        species_note: p.species_note,
        care: {
          feeding: c?.feeding ?? null,
          meds: readMeds(c?.meds),
          other_care: c?.other_care ?? null,
        },
      };
    });
    const rows = stays.data ?? [];
    const { fetchAllPages } = await import("@/lib/supabase-paging.server");
    const visits = rows.length
      ? await fetchAllPages<any>((a, b) =>
          sb
            .from("visits")
            .select(
              "id, scheduled_on, status, started_at, completed_at, report_note, subscriptions!inner(stay_id, earliest_time, latest_time)",
            )
            .eq("organization_id", session.organizationId)
            .eq("client_id", session.clientId)
            .in(
              "subscriptions.stay_id",
              rows.map((s) => s.id),
            )
            .order("id")
            .range(a, b),
        )
      : [];
    const completedIds = visits.filter((v) => v.status === "completed").map((v) => v.id);
    const { portalVisitPhotos } = await import("@/lib/portal-visit-photos.server");
    const photos = await portalVisitPhotos(sb, completedIds);
    const logged = completedIds.length
      ? await sb
          .from("care_log")
          .select("id, visit_id, pet_id, kind, med_name, status, missed_reason, note, at")
          .eq("organization_id", session.organizationId)
          .in("visit_id", completedIds)
      : { data: [] as any[], error: null };
    if (logged.error) throw new Error(logged.error.message);
    const careByVisit = new Map<string, any[]>();
    for (const row of logged.data ?? []) {
      const list = careByVisit.get(row.visit_id) ?? [];
      list.push(row);
      careByVisit.set(row.visit_id, list);
    }
    const depIds = rows.map((s) => s.deposit_invoice_id).filter((id): id is string => !!id);
    const deposits = depIds.length
      ? await sb
          .from("invoices")
          .select("id, status")
          .eq("organization_id", session.organizationId)
          .eq("client_id", session.clientId)
          .in("id", depIds)
      : { data: [], error: null };
    if (deposits.error) throw new Error(deposits.error.message);
    const due = new Set((deposits.data ?? []).filter((i) => i.status === "open").map((i) => i.id));
    return {
      offered: true,
      canRequest: customerCanRequestStay(await loadAvailability()),
      currency: org.currency,
      services: services.data ?? [],
      properties: (properties.data ?? []).map((p) => ({ id: p.id, street: p.street })),
      pets,
      stays: rows.map((s): PortalStay => ({
        id: s.id,
        startsOn: s.starts_on,
        endsOn: s.ends_on,
        kind: s.kind as StayKind,
        status: s.status as StayStatus,
        serviceName: one(s.services)?.name ?? "Pet sitting",
        depositCents: s.deposit_cents,
        depositInvoiceId: s.deposit_invoice_id,
        depositDue: due.has(s.deposit_invoice_id ?? ""),
        visits: visits
          .filter((v) => one(v.subscriptions)?.stay_id === s.id)
          .sort(
            (a, b) =>
              a.scheduled_on.localeCompare(b.scheduled_on) ||
              (one(a.subscriptions)?.earliest_time ?? "").localeCompare(
                one(b.subscriptions)?.earliest_time ?? "",
              ),
          )
          .map((v) =>
            portalStayVisitOf(
              v,
              org.timezone || "America/Chicago",
              photos.get(v.id) ?? [],
              portalCareLines(careByVisit.get(v.id) ?? [], pets, org.timezone || "America/Chicago"),
            ),
          ),
      })),
    };
  });

export const portalRequestStay = createServerFn({ method: "POST" })
  .inputValidator((d) => portalStayRequestSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token);
    if (!customerCanRequestStay(await loadAvailability()))
      throw new Error("Pet sitting is coming soon.");
    const sb = await admin();
    const { data: service, error } = await sb
      .from("services")
      .select("price_unit")
      .eq("id", data.serviceId)
      .eq("organization_id", session.organizationId)
      .eq("service_line", "pet_sitting")
      .eq("active", true)
      .single();
    if (error || !service) throw new Error("Choose a pet sitting service.");
    const kind = stayKindFor(service.price_unit);
    const problem =
      stayDatesProblem(kind, data.startsOn, data.endsOn) ??
      (kind === "overnight"
        ? arrivalWindowProblem(data.arrival)
        : stayWindowsProblem(data.windows));
    if (problem) throw new Error(problem);
    for (const c of data.care) {
      if (!data.petIds.includes(c.petId)) throw new Error("Care must be for a pet on this stay.");
      const problem = medsProblem(c.meds);
      if (problem) throw new Error(problem);
    }
    const { data: id, error: requestError } = await sb.rpc("portal_request_stay", {
      _org_id: session.organizationId,
      _client_id: session.clientId,
      _request_key: data.requestKey,
      _input: {
        propertyId: data.propertyId,
        serviceId: data.serviceId,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        windows: data.windows.map((w) => ({ earliest: w.earliestTime, latest: w.latestTime })),
        arrivalEarliest: data.arrival.earliestTime,
        arrivalLatest: data.arrival.latestTime,
        petIds: [...new Set(data.petIds)],
        notes: data.notes,
        care: data.care.map((c) => ({ ...c, meds: cleanMeds(c.meds) })),
      } as Json,
    });
    if (requestError) throw new Error(requestError.message);
    return { id };
  });

// ── A client adds a pet (#411) ─────────────────────────────────────────────
//
// A sitter's client often has a cat the office has never heard of: a scooping
// or walking business only ever recorded dogs, and the portal showed "Contact
// the office to add a pet" in place of the whole stay request. This lets the
// client add the pet from the request form itself: name, and dog / cat /
// other ("rabbit").
//
// Only where a stay can be requested: a business that runs pet sitting, with
// the platform's sitting switch on. A pet-waste or walking business's portal
// is unchanged. The pet lands at one of the client's own homes; nothing else
// about it (temperament, vet, care) is the client's to set here, and care is
// sent with the stay request as before, staged until the office confirms.
//
// Written as the service role after the portal session and the home's owner
// are checked, as every portal write is. A second press of the button, or a
// replay, finds the active pet of that name at that home and returns it
// rather than adding a twin.

export const PORTAL_PET_NAME_MAX = 60;

export const portalAddPetSchema = tokenSchema.extend({
  propertyId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Enter your pet's name.")
    .max(PORTAL_PET_NAME_MAX, `Keep the name to ${PORTAL_PET_NAME_MAX} characters.`),
  species: z.enum(PET_SPECIES),
  speciesNote: z
    .string()
    .trim()
    .max(SPECIES_NOTE_MAX, `Keep the kind of pet to ${SPECIES_NOTE_MAX} characters.`)
    .nullable()
    .optional(),
});

export type PortalAddPetInput = z.infer<typeof portalAddPetSchema>;

/** What the dogs row holds for the pet a client typed. species_note only for
 *  "other", and empty becomes null. */
export function portalPetRow(input: Pick<PortalAddPetInput, "name" | "species" | "speciesNote">): {
  name: string;
  species: (typeof PET_SPECIES)[number];
  species_note: string | null;
} {
  const note = input.species === "other" ? (input.speciesNote ?? "").trim() : "";
  return { name: input.name.trim(), species: input.species, species_note: note || null };
}

export const portalAddPet = createServerFn({ method: "POST" })
  .inputValidator((d) => portalAddPetSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token);
    if (!customerCanRequestStay(await loadAvailability()))
      throw new Error("Pet sitting is coming soon.");
    const sb = await admin();
    const { data: org, error: orgError } = await sb
      .from("organizations")
      .select("service_lines")
      .eq("id", session.organizationId)
      .single();
    if (orgError) throw new Error(orgError.message);
    if (!org.service_lines?.includes("pet_sitting"))
      throw new Error("Contact the office to add a pet.");
    const { data: home, error: homeError } = await sb
      .from("properties")
      .select("id")
      .eq("id", data.propertyId)
      .eq("organization_id", session.organizationId)
      .eq("client_id", session.clientId)
      .is("archived_at", null)
      .maybeSingle();
    if (homeError) throw new Error(homeError.message);
    if (!home) throw new Error("Choose one of your homes.");
    const row = portalPetRow(data);
    const { data: existing, error: existingError } = await sb
      .from("dogs")
      .select("id, name, species")
      .eq("property_id", home.id)
      .eq("active", true)
      .ilike(
        "name",
        row.name.replace(/[\\%_]/g, (c) => `\\${c}`),
      );
    if (existingError) throw new Error(existingError.message);
    const twin = (existing ?? []).find((d) => (d.species ?? "dog") === row.species);
    if (twin) return { id: twin.id as string, added: false };
    const { data: pet, error } = await sb
      .from("dogs")
      .insert({ organization_id: session.organizationId, property_id: home.id, ...row })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    // The pet is added either way; the history line is best-effort.
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(sb, {
        orgId: session.organizationId,
        clientId: session.clientId,
        propertyId: home.id,
        actorUserId: null,
        actorLabel: "Client (portal)",
        kind: "dog.added",
        summary: `Client added ${row.species === "dog" ? "dog" : "pet"} ${row.name} from the portal`,
        meta: { pet_id: pet.id, species: row.species, source: "portal" },
      });
    } catch {
      // Best-effort: the pet is already saved.
    }
    return { id: pet.id as string, added: true };
  });
