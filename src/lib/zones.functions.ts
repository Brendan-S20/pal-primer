import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
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
    const { data, error } = await supabase
      .from("zones")
      .select(
        "id, name, postal_prefix, zip_codes, account_type, price_note, latitude, longitude, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
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
    const orgId = await resolveOrgId(supabase, userId);
    const { data: row, error } = await supabase
      .from("zones")
      .insert({
        organization_id: orgId,
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
    return { id: row.id as string };
  });

const updateZoneSchema = zoneWriteSchema.extend({ id: z.string().uuid() }).partial({ name: true });

export const updateZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateZoneSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
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
    return { ok: true };
  });

export const deleteZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { error } = await supabase
      .from("zones")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
