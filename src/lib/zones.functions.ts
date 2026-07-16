import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await resolveCaller(supabase, userId)).orgId;
}

// Retroactive zone detection (QA round 8): after any zone change, re-run
// detection across the org's properties so pre-existing clients pick up the
// new boundaries without someone re-saving each address. Best effort — a
// redetect failure must never fail the zone save itself.
async function redetectBestEffort(supabase: any, orgId: string): Promise<number> {
  try {
    const { redetectZonesForOrg } = await import("@/lib/zones-redetect.server");
    const updated = await redetectZonesForOrg(supabase, orgId);
    console.info(`[zones] redetect for org ${orgId}: ${updated} properties re-assigned`);
    return updated;
  } catch (e) {
    console.error(`[zones] redetect failed for org ${orgId}:`, e);
    return 0;
  }
}

function normalizeZips(input: string[] | undefined): string[] {
  if (!input) return [];
  const cleaned = input
    .map((z) => String(z).trim().replace(/[^0-9A-Za-z-]/g, ""))
    .filter((z) => z.length > 0);
  return Array.from(new Set(cleaned));
}

export const listZones = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await (supabase as any)
      .from("zones")
      .select(
        "id, name, priority, postal_prefix, zip_codes, account_type, price_note, latitude, longitude, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
      )
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return { zones: data ?? [] };
  });

const polygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).min(1),
  })
  .nullable();

const zoneWriteSchema = z.object({
  name: z.string().min(1).max(120),
  zipCodes: z.array(z.string()).optional(),
  postalPrefix: z.string().max(20).optional().nullable(),
  accountType: z.enum(["residential", "commercial"]).optional().nullable(),
  priceNote: z.string().max(200).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  basePriceCents: z.number().int().min(0).optional(),
  perDogAddlCents: z.number().int().min(0).optional(),
  initialCleanupCents: z.number().int().min(0).optional(),
  pricingMode: z.enum(["flat", "per_sqft", "per_acre"]).optional(),
  pricePerSqftCents: z.number().min(0).max(10000).optional(),
  pricePerAcreCents: z.number().int().min(0).optional(),
  areaMinChargeCents: z.number().int().min(0).optional(),
  // Commercial (HOA) pricing: base + per-unit x units + per-acre x acres.
  commercialBaseCents: z.number().int().min(0).optional().nullable(),
  commercialPerUnitCents: z.number().int().min(0).optional().nullable(),
  commercialPerAcreCents: z.number().int().min(0).optional().nullable(),
  // Overlap tie-breaker: higher priority wins among zones matching at the
  // same specificity level (see src/lib/zone-match.ts).
  priority: z.number().int().min(-999).max(999).optional(),
  geoMatchMode: z.enum(["zip", "radius", "polygon", "drive_time"]).optional(),
  boundary: polygonSchema.optional(),
  centerLatitude: z.number().min(-90).max(90).nullable().optional(),
  centerLongitude: z.number().min(-180).max(180).nullable().optional(),
  radiusMeters: z.number().int().min(100).max(200000).nullable().optional(),
  driveTimeMinutes: z.number().int().min(1).max(180).nullable().optional(),
});

export const createZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => zoneWriteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    const { data: row, error } = await (supabase as any)
      .from("zones")
      .insert({
        organization_id: orgId,
        priority: data.priority ?? 0,
        name: data.name,
        zip_codes: normalizeZips(data.zipCodes),
        postal_prefix: data.postalPrefix || null,
        account_type: data.accountType ?? null,
        price_note: data.priceNote || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        base_price_cents: data.basePriceCents ?? 2500,
        per_dog_addl_cents: data.perDogAddlCents ?? 500,
        initial_cleanup_cents: data.initialCleanupCents ?? 0,
        pricing_mode: data.pricingMode ?? "flat",
        price_per_sqft_cents: data.pricePerSqftCents ?? 0,
        price_per_acre_cents: data.pricePerAcreCents ?? 0,
        area_min_charge_cents: data.areaMinChargeCents ?? 0,
        commercial_base_cents: data.commercialBaseCents ?? null,
        commercial_per_unit_cents: data.commercialPerUnitCents ?? null,
        commercial_per_acre_cents: data.commercialPerAcreCents ?? null,
        geo_match_mode: data.geoMatchMode ?? "zip",
        boundary: (data.boundary as any) ?? null,
        center_latitude: data.centerLatitude ?? null,
        center_longitude: data.centerLongitude ?? null,
        radius_meters: data.radiusMeters ?? null,
        drive_time_minutes: data.driveTimeMinutes ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // A new zone can capture existing properties immediately.
    const propertiesUpdated = await redetectBestEffort(supabase, orgId);
    return { id: row.id as string, propertiesUpdated };
  });

const updateZoneSchema = zoneWriteSchema.extend({ id: z.string().uuid() }).partial({ name: true });

export const updateZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateZoneSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    const patch: Record<string, any> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.zipCodes !== undefined) patch.zip_codes = normalizeZips(data.zipCodes);
    if (data.postalPrefix !== undefined) patch.postal_prefix = data.postalPrefix || null;
    if (data.accountType !== undefined) patch.account_type = data.accountType ?? null;
    if (data.priceNote !== undefined) patch.price_note = data.priceNote || null;
    if (data.latitude !== undefined) patch.latitude = data.latitude;
    if (data.longitude !== undefined) patch.longitude = data.longitude;
    if (data.basePriceCents !== undefined) patch.base_price_cents = data.basePriceCents;
    if (data.perDogAddlCents !== undefined) patch.per_dog_addl_cents = data.perDogAddlCents;
    if (data.initialCleanupCents !== undefined)
      patch.initial_cleanup_cents = data.initialCleanupCents;
    if (data.pricingMode !== undefined) patch.pricing_mode = data.pricingMode;
    if (data.pricePerSqftCents !== undefined) patch.price_per_sqft_cents = data.pricePerSqftCents;
    if (data.pricePerAcreCents !== undefined) patch.price_per_acre_cents = data.pricePerAcreCents;
    if (data.areaMinChargeCents !== undefined) patch.area_min_charge_cents = data.areaMinChargeCents;
    if (data.commercialBaseCents !== undefined) patch.commercial_base_cents = data.commercialBaseCents;
    if (data.commercialPerUnitCents !== undefined)
      patch.commercial_per_unit_cents = data.commercialPerUnitCents;
    if (data.commercialPerAcreCents !== undefined)
      patch.commercial_per_acre_cents = data.commercialPerAcreCents;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.geoMatchMode !== undefined) patch.geo_match_mode = data.geoMatchMode;
    if (data.boundary !== undefined) patch.boundary = data.boundary as any;
    if (data.centerLatitude !== undefined) patch.center_latitude = data.centerLatitude;
    if (data.centerLongitude !== undefined) patch.center_longitude = data.centerLongitude;
    if (data.radiusMeters !== undefined) patch.radius_meters = data.radiusMeters;
    if (data.driveTimeMinutes !== undefined) patch.drive_time_minutes = data.driveTimeMinutes;

    const { error } = await supabase
      .from("zones")
      .update(patch as any)
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);

    // Changed coverage/priority can re-assign existing properties.
    const propertiesUpdated = await redetectBestEffort(supabase, orgId);
    return { ok: true, propertiesUpdated };
  });

export const deleteZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    const { error } = await supabase
      .from("zones")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);

    // Properties in the deleted zone can fall to another zone (or none).
    const propertiesUpdated = await redetectBestEffort(supabase, orgId);
    return { ok: true, propertiesUpdated };
  });
