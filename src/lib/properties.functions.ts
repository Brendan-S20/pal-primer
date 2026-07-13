import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const yardSize = z.enum(["small", "medium", "large", "xlarge"]).optional();

const createPropSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().max(120).optional(),
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  gateCode: z.string().max(60).optional(),
  yardSize,
  invisibleFence: z.boolean().optional(),
  escapeRisk: z.boolean().optional(),
  dogInYardDuringService: z.boolean().optional(),
  aggressiveDog: z.boolean().optional(),
  beesWasps: z.boolean().optional(),
  sharpObjects: z.boolean().optional(),
  slipperySurfaces: z.boolean().optional(),
  doNotEnterIfDogOut: z.boolean().optional(),
  hazardNotes: z.string().max(1000).optional(),
  // P3.5 billing-vs-property contact split: an optional on-site contact who
  // gets visit notifications while the client's primary contact keeps
  // receiving bills (landlord/tenant, property manager, HOA).
  visitContactName: z.string().max(120).optional(),
  visitContactPhone: z.string().max(30).optional(),
  visitContactEmail: z.string().email().max(200).optional().or(z.literal("")),
});

export const createProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createPropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { geocodeAddress } = await import("./geocode.server");
    const geo = await geocodeAddress({
      street: data.street,
      city: data.city,
      region: data.region,
      postal_code: data.postalCode,
    });

    const { data: row, error } = await supabase
      .from("properties")
      .insert({
        client_id: data.clientId,
        organization_id: client.organization_id,
        label: data.label || null,
        street: data.street,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        yard_size: data.yardSize ?? null,
        invisible_fence: !!data.invisibleFence,
        escape_risk: !!data.escapeRisk,
        dog_in_yard_during_service: !!data.dogInYardDuringService,
        aggressive_dog: !!data.aggressiveDog,
        bees_wasps: !!data.beesWasps,
        sharp_objects: !!data.sharpObjects,
        slippery_surfaces: !!data.slipperySurfaces,
        do_not_enter_if_dog_out: !!data.doNotEnterIfDogOut,
        hazard_notes: data.hazardNotes || null,
        visit_contact_name: data.visitContactName || null,
        visit_contact_phone: data.visitContactPhone || null,
        visit_contact_email: data.visitContactEmail || null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const updatePropSchema = createPropSchema.omit({ clientId: true }).extend({
  propertyId: z.string().uuid(),
});

export const updateProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updatePropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Re-geocode when the address might have changed (cheap, keeps lat/lng fresh).
    const { geocodeAddress } = await import("./geocode.server");
    const geo = await geocodeAddress({
      street: data.street,
      city: data.city,
      region: data.region,
      postal_code: data.postalCode,
    });

    // Only overwrite coordinates when geocoding actually resolved, so a
    // transient geocoder miss doesn't blank out a good pin.
    const geoPatch =
      geo?.latitude != null && geo?.longitude != null
        ? { latitude: geo.latitude, longitude: geo.longitude }
        : {};

    const { error } = await supabase
      .from("properties")
      .update({
        label: data.label || null,
        street: data.street,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        yard_size: data.yardSize ?? null,
        invisible_fence: !!data.invisibleFence,
        escape_risk: !!data.escapeRisk,
        dog_in_yard_during_service: !!data.dogInYardDuringService,
        aggressive_dog: !!data.aggressiveDog,
        bees_wasps: !!data.beesWasps,
        sharp_objects: !!data.sharpObjects,
        slippery_surfaces: !!data.slipperySurfaces,
        do_not_enter_if_dog_out: !!data.doNotEnterIfDogOut,
        hazard_notes: data.hazardNotes || null,
        visit_contact_name: data.visitContactName || null,
        visit_contact_phone: data.visitContactPhone || null,
        visit_contact_email: data.visitContactEmail || null,
        ...geoPatch,
      })
      .eq("id", data.propertyId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const backfillPropertyGeocodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ limit: z.number().int().min(1).max(200).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("properties")
      .select("id, street, city, region, postal_code")
      .is("latitude", null)
      .limit(data.limit ?? 50);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) return { updated: 0, remaining: 0 };

    const { geocodeAddress } = await import("./geocode.server");
    let updated = 0;
    for (const r of rows) {
      const geo = await geocodeAddress({
        street: r.street,
        city: r.city,
        region: r.region,
        postal_code: r.postal_code,
      });
      if (!geo) continue;
      const { error: uErr } = await supabase
        .from("properties")
        .update({ latitude: geo.latitude, longitude: geo.longitude })
        .eq("id", r.id);
      if (!uErr) updated += 1;
    }
    const { count } = await supabase
      .from("properties")
      .select("id", { count: "exact", head: true })
      .is("latitude", null);
    return { updated, remaining: count ?? 0 };
  });

export const listPropertiesForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("properties")
      .select(
        "id, label, street, city, region, postal_code, gate_code, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, earliest_service_time, latest_service_time, service_duration_min, visit_contact_name, visit_contact_phone, visit_contact_email",
      )
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: rows ?? [] };
  });

// GeoJSON Polygon: coordinates = [ [ [lng, lat], ... ] ]  first == last
const polygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)).min(1),
  })
  .nullable();

// Shoelace on lat/lng, projected as equirectangular around the polygon centroid.
function polygonAreaSqm(poly: { coordinates: number[][][] } | null): number | null {
  if (!poly) return null;
  const ring = poly.coordinates[0];
  if (!ring || ring.length < 4) return null;
  const R = 6378137;
  const latMean = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const cosLat = Math.cos(latMean);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const x1 = xi * (Math.PI / 180) * R * cosLat;
    const y1 = yi * (Math.PI / 180) * R;
    const x2 = xj * (Math.PI / 180) * R * cosLat;
    const y2 = yj * (Math.PI / 180) * R;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

export const getPropertyBoundary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("properties")
      .select("id, client_id, street, city, postal_code, latitude, longitude, boundary, boundary_area_sqm, yard_size, clients(id, display_name)")
      .eq("id", data.propertyId)
      .single();
    if (error) throw new Error(error.message);
    return { property: row };
  });

export const updatePropertyBoundary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        propertyId: z.string().uuid(),
        boundary: polygonSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgRes = await context.supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    const orgId = orgRes.data?.organization_id as string | undefined;
    if (!orgId) throw new Error("No organization");
    const area = polygonAreaSqm(data.boundary as any);
    const { error } = await context.supabase
      .from("properties")
      .update({
        boundary: data.boundary as any,
        boundary_area_sqm: area,
      } as any)
      .eq("id", data.propertyId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true, area_sqm: area };
  });
