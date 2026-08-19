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
async function redetectBestEffort(supabase: any, orgId: string, actorUserId?: string | null): Promise<number> {
  try {
    const { redetectZonesForOrg } = await import("@/lib/zones-redetect.server");
    const updated = await redetectZonesForOrg(supabase, orgId, actorUserId);
    console.info(`[zones] redetect for org ${orgId}: ${updated} properties re-assigned`);
    return updated;
  } catch (e) {
    console.error(`[zones] redetect failed for org ${orgId}:`, e);
    return 0;
  }
}

// ── ZONE ZIPs ARE US 5-DIGIT ZIPs ─────────────────────────────────────────
//
// Owner QA, 2026-08-19: "When entering a zip code for zones, it should
// automatically assume it's a United States zip code."
//
// The one fact everything below follows from: a zone matches a property by
// EXACT STRING EQUALITY on the property's postal code — `z.zip_codes.includes(
// pc)` in src/lib/zone-match.ts, and `_zip = ANY(z.zip_codes)` in the
// public_quote RPC. Nothing normalizes either side at match time. So a chip
// that is not character-for-character the 5-digit string a property carries is
// a zone that covers nothing, and covers nothing SILENTLY: no error, no empty
// state, just a dispatcher wondering why an address in the zone was never
// assigned to it. The old rule here — strip anything outside [0-9A-Za-z-] and
// keep whatever is left — accepted "787", "ABC", "M5V" and "78701-1234" as
// equal citizens of that set.
//
// Four decisions, and why:
//
//  1. ZIP+4 ("78701-1234") keeps its 5-digit base and drops the +4. The +4
//     identifies a delivery segment, not an area, and no property row in this
//     product stores one — so the full ZIP+4 string is a chip that can never
//     equal any postal_code we hold, while "78701" is exactly the thing the
//     person meant to serve. Nine straight digits ("787011234") is the same
//     value with the hyphen dropped and is read the same way. We do NOT try
//     this on an 8-digit run: 5+4 is the only unambiguous reading of nine.
//
//  2. Four digits are padded with one leading zero ("1810" -> "01810").
//     This is the one real US quirk: ZIPs in MA/RI/NH/ME/VT/CT/NJ/PR start
//     with 0, and every spreadsheet that treats a ZIP column as a number eats
//     it. A 4-digit token is NEVER a valid US ZIP, so padding overrides no
//     valid input; and the corruption it repairs is systematic (numeric
//     coercion strips leading zeros — it never drops a trailing digit),
//     whereas the competing reading, "a typo that lost one of five digits",
//     is not systematic and would give no basis for guessing WHICH digit.
//     The tie-breaker is that the guess is visible and reversible: the chip
//     renders "01810", so an owner who meant something else sees it and can
//     remove it. Rejecting instead would be defensible but makes an owner in
//     Massachusetts retype a pasted list by hand.
//
//  3. Anything still not five digits — "787", "ABC", a Canadian "M5V 3A8" —
//     is REFUSED and named. Not accepted (that is the bug), and not silently
//     dropped either: a paste of twenty ZIPs where two are bad has to say
//     which two, or the owner saves a zone believing it covers twenty areas.
//     Note that letters are never stripped out of a token to salvage the
//     digits around them; "M5V" is reported as "M5V", not turned into "5".
//
//  4. Shape only, not existence. We do not carry a ZIP registry, so "00000"
//     passes. The fault being fixed is chips that CANNOT match, not chips
//     that match nothing today.
//
// Deliberately NOT built: any notion of a country. The owner asked for the
// opposite of international support. If a Canadian operator ever appears, the
// place to start is a per-org country on the organization, not a selector on
// this field — but do not build it before there is one.

/** Split typed or pasted input into candidate tokens. */
export function splitZipInput(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * One token -> a US 5-digit ZIP, or null when it is not one.
 * Wrapping punctuation (CSV quotes, parens) is stripped; letters are not.
 */
export function normalizeUsZip(token: string): string | null {
  const t = String(token)
    .trim()
    .replace(/^[^0-9A-Za-z]+/, "")
    .replace(/[^0-9A-Za-z]+$/, "");
  if (!t) return null;
  // ZIP+4, hyphenated (a 4-digit base here is a zero-eaten ZIP+4) or as the
  // nine digits it is without one.
  const hyphenated = /^(\d{4,5})-(\d{4})$/.exec(t);
  const nineDigits = /^(\d{5})\d{4}$/.exec(t);
  const base = hyphenated ? hyphenated[1] : nineDigits ? nineDigits[1] : t;
  const padded = /^\d{4}$/.test(base) ? `0${base}` : base;
  return /^\d{5}$/.test(padded) ? padded : null;
}

/**
 * Normalize a list of tokens, keeping the ones that could not be read so the
 * caller can SAY SO. Order is preserved and duplicates collapse.
 */
export function parseUsZips(tokens: string[]): { zips: string[]; rejected: string[] } {
  const zips: string[] = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    const zip = normalizeUsZip(token);
    if (zip) {
      if (!zips.includes(zip)) zips.push(zip);
    } else {
      const shown = String(token).trim();
      if (shown && !rejected.includes(shown)) rejected.push(shown);
    }
  }
  return { zips, rejected };
}

/** The message shown for refused tokens, shared by the drawer and the server. */
export function rejectedZipMessage(rejected: string[]): string {
  const list = rejected.map((r) => `"${r}"`).join(", ");
  return `${rejected.length === 1 ? "That is not a US ZIP code" : "Those are not US ZIP codes"}: ${list}. Zone ZIPs are 5 digits, e.g. 78701.`;
}

// Client-side validation is an affordance, not a guarantee: a server function
// is an HTTP endpoint and takes whatever is posted to it. The same rules run
// here, and a bad value is REJECTED rather than dropped — dropping it would
// write a zone that is not the zone the caller asked for and say nothing.
// (See zoneWriteSchema.zipCodes for where this surfaces as a validation
// error; this stays as defence in depth for any direct handler use.)
function normalizeZips(input: string[] | undefined): string[] {
  const { zips, rejected } = parseUsZips(input ?? []);
  if (rejected.length) throw new Error(rejectedZipMessage(rejected));
  return zips;
}

export const listZones = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await (supabase as any)
      .from("zones")
      .select(
        "id, name, priority, postal_prefix, zip_codes, account_type, price_note, latitude, longitude, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, commercial_per_station_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
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

// Real names only ("12" was accepted as a zone name — QA round 3, C5/I11).
const zoneNameSchema = z
  .string()
  .trim()
  .min(2, "Zone name needs at least 2 characters")
  .max(120)
  .regex(/[A-Za-z]/, "Zone name must include letters, not just numbers");

// ZIPs are validated where every write goes through, so create and update
// answer identically and the caller gets a field-shaped error instead of a
// thrown string.
export const zipCodesSchema = z
  .array(z.string())
  .optional()
  .superRefine((v, ctx) => {
    const { rejected } = parseUsZips(v ?? []);
    if (rejected.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: rejectedZipMessage(rejected) });
    }
  });

const zoneWriteSchema = z.object({
  name: zoneNameSchema,
  zipCodes: zipCodesSchema,
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
  commercialPerStationCents: z.number().int().min(0).optional().nullable(),
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

// Map coverage is required at creation (QA round 3, C5): ZIP-only zones can't
// be drawn on the overview map, break point-based detection for addresses
// with missing/misfiled ZIPs, and were the root of the "zone with no
// coordinates" weather and map bugs. ZIPs stay as exact-match signals on top.
function hasGeometry(d: {
  geoMatchMode?: string;
  boundary?: { coordinates?: number[][][] } | null;
  centerLatitude?: number | null;
  centerLongitude?: number | null;
  radiusMeters?: number | null;
  driveTimeMinutes?: number | null;
}): boolean {
  const centered = d.centerLatitude != null && d.centerLongitude != null;
  if (d.geoMatchMode === "polygon") return !!d.boundary?.coordinates?.[0]?.length;
  if (d.geoMatchMode === "radius") return centered && !!d.radiusMeters;
  if (d.geoMatchMode === "drive_time") return centered && !!d.driveTimeMinutes;
  return false;
}

const zoneCreateSchema = zoneWriteSchema.superRefine((d, ctx) => {
  if (!hasGeometry(d)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Map coverage is required. Draw a polygon or set a center point with a radius or drive time.",
    });
  }
});

export const createZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => zoneCreateSchema.parse(d))
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
        commercial_per_station_cents: data.commercialPerStationCents ?? null,
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
    const propertiesUpdated = await redetectBestEffort(supabase, orgId, userId);
    return { id: row.id as string, propertiesUpdated };
  });

const updateZoneSchema = zoneWriteSchema.extend({ id: z.string().uuid() }).partial({ name: true });

export const updateZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateZoneSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");

    // A zone that has map coverage must keep it (C5: ZIP-only coverage is no
    // longer allowed). Merge the patch over the current row and reject
    // transitions from covered to uncovered. Legacy zones that never had
    // coverage can still update pricing while they wait for a map.
    const { data: existing, error: exErr } = await (supabase as any)
      .from("zones")
      .select("geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes")
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .single();
    if (exErr) throw new Error(exErr.message);
    const touchesGeometry =
      data.geoMatchMode !== undefined ||
      data.boundary !== undefined ||
      data.centerLatitude !== undefined ||
      data.centerLongitude !== undefined ||
      data.radiusMeters !== undefined ||
      data.driveTimeMinutes !== undefined;
    if (touchesGeometry) {
      const merged = {
        geoMatchMode: data.geoMatchMode ?? existing.geo_match_mode ?? "zip",
        boundary: data.boundary !== undefined ? data.boundary : existing.boundary,
        centerLatitude:
          data.centerLatitude !== undefined
            ? data.centerLatitude
            : existing.center_latitude != null
              ? Number(existing.center_latitude)
              : null,
        centerLongitude:
          data.centerLongitude !== undefined
            ? data.centerLongitude
            : existing.center_longitude != null
              ? Number(existing.center_longitude)
              : null,
        radiusMeters: data.radiusMeters !== undefined ? data.radiusMeters : existing.radius_meters,
        driveTimeMinutes:
          data.driveTimeMinutes !== undefined ? data.driveTimeMinutes : existing.drive_time_minutes,
      };
      if (!hasGeometry(merged)) {
        throw new Error(
          "Map coverage is required. Draw a polygon or set a center point with a radius or drive time.",
        );
      }
    }

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
    if (data.commercialPerStationCents !== undefined)
      patch.commercial_per_station_cents = data.commercialPerStationCents;
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
    const propertiesUpdated = await redetectBestEffort(supabase, orgId, userId);
    return { ok: true, propertiesUpdated };
  });

// Center the coverage map on a typed ZIP (G5: "map centering on ZIP entry")
// so drawing coverage starts near the zone instead of a continent view.
export const geocodePostal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ postalCode: z.string().trim().min(3).max(20) }).parse(d))
  .handler(async ({ data }) => {
    const { geocodeAddress } = await import("@/lib/geocode.server");
    const geo = await geocodeAddress({ postal_code: data.postalCode });
    return { point: geo ? { latitude: geo.latitude, longitude: geo.longitude } : null };
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
    const propertiesUpdated = await redetectBestEffort(supabase, orgId, userId);
    return { ok: true, propertiesUpdated };
  });
