import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidLabel } from "@/lib/dna-linkage";

async function orgId(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles").select("organization_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

export const listStations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid().optional(), clientId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("waste_stations")
      .select("*")
      .order("sort_order")
      .order("station_number")
      .order("label");
    if (data.propertyId) q = q.eq("property_id", data.propertyId);
    if (data.clientId) q = q.eq("client_id", data.clientId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const stations = rows ?? [];
    // Last-serviced per station: newest visit date across its service logs.
    // Populated by record_visit_station_service() on visit completion (G7).
    const ids = stations.map((s: any) => s.id);
    const lastServiced: Record<string, string> = {};
    if (ids.length) {
      const { data: logs } = await context.supabase
        .from("station_service_logs")
        .select("waste_station_id, serviced_at, visits(scheduled_on)")
        .in("waste_station_id", ids);
      for (const l of (logs ?? []) as any[]) {
        const when = l.visits?.scheduled_on ?? (l.serviced_at ? String(l.serviced_at).slice(0, 10) : null);
        if (!when) continue;
        const cur = lastServiced[l.waste_station_id];
        if (!cur || when > cur) lastServiced[l.waste_station_id] = when;
      }
    }
    return {
      stations: stations.map((s: any) => ({
        ...s,
        last_serviced_on: lastServiced[s.id] ?? null,
      })),
    };
  });

export const upsertStation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid().optional(),
    clientId: z.string().uuid(),
    propertyId: z.string().uuid(),
    label: z.string().min(1).max(120),
    // Optional note ("behind the mail kiosk"); the map marker is the location.
    locationDescription: z.string().max(300).optional().nullable(),
    linerSize: z.string().max(60).optional().nullable(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    // Must match one of the property's commercial_sections values.
    section: z.string().max(120).optional().nullable(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
    .refine((v) => (v.latitude == null) === (v.longitude == null), {
      message: "Latitude and longitude must be set together",
    })
    .parse(d))
  .handler(async ({ data, context }) => {
    if (!isValidLabel(data.label)) {
      throw new Error("Enter a station label (not blank or a placeholder).");
    }
    const org = await orgId(context.supabase, context.userId);
    // capacity_liners is intentionally no longer written (QA round 8).
    const payload: any = {
      organization_id: org,
      client_id: data.clientId,
      property_id: data.propertyId,
      label: data.label,
      location_description: data.locationDescription ?? null,
      liner_size: data.linerSize ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      section: data.section ?? null,
      active: data.active ?? true,
      sort_order: data.sortOrder ?? 0,
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await context.supabase.from("waste_stations").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase.from("waste_stations").insert(payload).select("id").single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const deleteStation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("waste_stations").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Renumber a property's stations to a clean 1..n integer sequence (G7).
export const renumberStations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: n, error } = await context.supabase.rpc("renumber_property_stations", {
      _property_id: data.propertyId,
    });
    if (error) throw new Error(error.message);
    return { renumbered: (n as number) ?? 0 };
  });

export const getVisitStations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: visit, error: ve } = await context.supabase
      .from("visits").select("id, property_id, client_id").eq("id", data.visitId).single();
    if (ve) throw new Error(ve.message);
    const [stations, logs] = await Promise.all([
      context.supabase.from("waste_stations").select("*").eq("property_id", visit.property_id).eq("active", true).order("sort_order").order("label"),
      context.supabase.from("station_service_logs").select("*").eq("visit_id", data.visitId),
    ]);
    if (stations.error) throw new Error(stations.error.message);
    if (logs.error) throw new Error(logs.error.message);
    return { stations: stations.data ?? [], logs: logs.data ?? [] };
  });

export const logStationService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    visitId: z.string().uuid(),
    wasteStationId: z.string().uuid(),
    bagsCollected: z.number().int().min(0).max(9999).default(0),
    linerReplaced: z.boolean().default(false),
    refillBagsAdded: z.number().int().min(0).max(9999).default(0),
    notes: z.string().max(500).optional(),
    photoUrl: z.string().url().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("log_station_service", {
      _visit_id: data.visitId,
      _waste_station_id: data.wasteStationId,
      _bags_collected: data.bagsCollected,
      _liner_replaced: data.linerReplaced,
      _refill_bags_added: data.refillBagsAdded,
      _notes: data.notes ?? undefined,
      _photo_url: data.photoUrl ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

// ---------- Facilities & Manifests ----------

export const listFacilities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("waste_disposal_facilities").select("*").order("name");
    if (error) throw new Error(error.message);
    return { facilities: data ?? [] };
  });

export const upsertFacility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(200),
    address: z.string().max(300).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
    active: z.boolean().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const org = await orgId(context.supabase, context.userId);
    const payload: any = {
      organization_id: org,
      name: data.name,
      address: data.address ?? null,
      notes: data.notes ?? null,
      active: data.active ?? true,
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await context.supabase.from("waste_disposal_facilities").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase.from("waste_disposal_facilities").insert(payload).select("id").single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const listManifests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ from: z.string().optional(), to: z.string().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("waste_disposal_manifests")
      .select("*, waste_disposal_facilities(name), staff(display_name)")
      .order("disposed_on", { ascending: false })
      .order("disposed_at", { ascending: false })
      .limit(200);
    if (data.from) q = q.gte("disposed_on", data.from);
    if (data.to) q = q.lte("disposed_on", data.to);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { manifests: rows ?? [] };
  });

export const createManifest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    facilityId: z.string().uuid().optional().nullable(),
    disposedOn: z.string(),
    weightLbs: z.number().min(0).max(100000).optional(),
    bagCount: z.number().int().min(0).max(100000).optional(),
    ticketNumber: z.string().max(120).optional(),
    notes: z.string().max(500).optional(),
    // A waste-receipts storage path ({org}/{ts}.{ext}), not a full URL —
    // display signs it on demand (punch list #16).
    photoUrl: z.string().max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const org = await orgId(context.supabase, context.userId);
    const { data: staffRow } = await context.supabase
      .from("staff").select("id").eq("user_id", context.userId).eq("organization_id", org).maybeSingle();
    const { data: row, error } = await context.supabase.from("waste_disposal_manifests").insert({
      organization_id: org,
      staff_id: staffRow?.id ?? null,
      facility_id: data.facilityId ?? null,
      disposed_on: data.disposedOn,
      weight_lbs: data.weightLbs ?? null,
      bag_count: data.bagCount ?? null,
      ticket_number: data.ticketNumber ?? null,
      notes: data.notes ?? null,
      photo_url: data.photoUrl ?? null,
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const deleteManifest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("waste_disposal_manifests").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
