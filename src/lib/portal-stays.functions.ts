import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { cleanMeds, medsProblem, readMeds, type PetCare } from "@/lib/pets";
import {
  arrivalWindowProblem,
  DEFAULT_OVERNIGHT_ARRIVAL,
  stayDatesProblem,
  stayKindFor,
  stayWindowsProblem,
  type StayKind,
  type StayStatus,
} from "@/lib/stays";
import { walkReportEmail } from "@/lib/walk-report";
import { windowLabel } from "@/lib/walk-windows";

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
};
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
export function portalStayVisitOf(
  row: any,
  timezone: string,
  photos: PortalStayVisit["photos"],
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
    const { portalVisitPhotos } = await import("@/lib/portal-visit-photos.server");
    const photos = await portalVisitPhotos(
      sb,
      visits.filter((v) => v.status === "completed").map((v) => v.id),
    );
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
            portalStayVisitOf(v, org.timezone || "America/Chicago", photos.get(v.id) ?? []),
          ),
      })),
    };
  });

export const portalRequestStay = createServerFn({ method: "POST" })
  .inputValidator((d) => portalStayRequestSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token);
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
