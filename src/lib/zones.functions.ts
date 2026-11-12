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
async function redetectBestEffort(
  supabase: any,
  orgId: string,
  actorUserId?: string | null,
): Promise<number> {
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
        "id, name, priority, postal_prefix, zip_codes, account_type, price_note, latitude, longitude, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, area_max_charge_cents, commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, commercial_per_station_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
      )
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    const activeClients = await activeClientCounts(supabase, orgId);
    return {
      zones: (data ?? []).map((z: any) => ({
        ...z,
        active_clients: activeClients?.[z.id] ?? 0,
      })),
      // Null when the counts could not be read: the switch then asks before
      // turning any zone off rather than assuming it is empty.
      activeClientsKnown: activeClients !== null,
    };
  });

// Clients with an active service on a property in each zone (#449). The
// confirm before turning a zone off shows this number. Null on a failed read.
async function activeClientCounts(
  supabase: any,
  orgId: string,
): Promise<Record<string, number> | null> {
  // Paged (BUG-23): a single read stops at 1000 rows, and a short count here
  // could be a 0 that skips the confirm.
  const { fetchAllPages } = await import("@/lib/supabase-paging.server");
  const { activeClientsByZone } = await import("@/lib/zone-enabled");
  try {
    const [props, subs] = await Promise.all([
      fetchAllPages<{ id: string; client_id: string | null; zone_id: string | null }>((from, to) =>
        supabase
          .from("properties")
          .select("id, client_id, zone_id")
          .eq("organization_id", orgId)
          .not("zone_id", "is", null)
          .is("archived_at", null)
          .order("id")
          .range(from, to),
      ),
      fetchAllPages<{ client_id: string | null; property_id: string | null }>((from, to) =>
        supabase
          .from("subscriptions")
          .select("id, client_id, property_id")
          .eq("organization_id", orgId)
          .eq("status", "active")
          .order("id")
          .range(from, to),
      ),
    ]);
    return activeClientsByZone(props, subs);
  } catch (e) {
    console.error("[zones] active client count failed", e);
    return null;
  }
}

// Turn a zone on or off without touching its shape, ZIPs or pricing (#449).
// Owner only, here and in the database (tg_zones_enabled_owner_only). Saves on
// its own, not through updateZone, because the switch saves the moment it is
// pressed and must not carry a half-edited drawer with it.
export const setZoneEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId, role } = await resolveCaller(supabase, userId);
    const { canToggleZone } = await import("@/lib/zone-enabled");
    if (!canToggleZone(role)) throw new Error("Only an owner can turn a zone on or off.");

    const { data: row, error } = await (supabase as any)
      .from("zones")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id, name")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Zone not found.");

    const counts = await activeClientCounts(supabase, orgId);
    const activeClients = counts?.[data.id] ?? null;
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        actorUserId: userId,
        kind: data.enabled ? "zone.turned_on" : "zone.turned_off",
        summary: `Zone ${row.name} turned ${data.enabled ? "on" : "off"}`,
        meta: { zone_id: data.id, enabled: data.enabled, active_clients: activeClients },
      });
    } catch (e) {
      console.warn("[zones] toggle activity log failed", (e as Error).message);
    }

    // Turning a zone on lets it claim addresses added while it was off.
    // Turning one off moves nobody: redetect leaves its properties in place.
    const propertiesUpdated = await redetectBestEffort(supabase, orgId, userId);
    return { ok: true, enabled: data.enabled, propertiesUpdated };
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
  // Nullable, because NULL is a real answer ("no ceiling") and it is what
  // every zone written before 2026-09 carries. `requireAreaCeiling` below is
  // what stops a NEW area-priced zone being saved that way.
  areaMaxChargeCents: z.number().int().min(0).optional().nullable(),
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

const zoneCreateSchema = zoneWriteSchema
  .extend({
    // Fill the ZIPs the drawn shape holds, on the server, before the row is
    // written: the same fill as the Zones drawer's "Fill ZIPs from the area".
    // Setup step 2 asks for it (onboarding audit 2026-11-09, D1: setup made a
    // 10-mile circle that listed no ZIPs, so the signup page, the lead form
    // and the first client's Plan step could not quote it). The drawer does
    // not: it shows the owner each chip and sends the list they kept.
    fillZipsFromShape: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
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

    requireAreaCeiling(data.pricingMode ?? "flat", data.areaMaxChargeCents);
    const zipCodes = normalizeZips(data.zipCodes);
    const zipsFilled = data.fillZipsFromShape
      ? await fillZipsBestEffort(supabase, orgId, data, zipCodes)
      : 0;
    const { data: row, error } = await (supabase as any)
      .from("zones")
      .insert({
        organization_id: orgId,
        priority: data.priority ?? 0,
        name: data.name,
        zip_codes: zipCodes,
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
        area_max_charge_cents: data.areaMaxChargeCents ?? null,
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
    return { id: row.id as string, propertiesUpdated, zipsFilled };
  });

/**
 * Add the ZIPs a new zone's drawn shape holds to `zipCodes`, in place, and
 * say how many were added. Best effort: a lookup that fails leaves the list
 * as the caller sent it and the zone is still saved, because an area with no
 * ZIPs still quotes an address in it (internalQuote places a ZIP at its
 * Census center) and Zones offers "Fill ZIPs from the area" afterwards.
 */
async function fillZipsBestEffort(
  supabase: any,
  orgId: string,
  d: {
    geoMatchMode?: string;
    boundary?: { coordinates?: number[][][] } | null;
    centerLatitude?: number | null;
    centerLongitude?: number | null;
    radiusMeters?: number | null;
    driveTimeMinutes?: number | null;
  },
  zipCodes: string[],
): Promise<number> {
  if (!d.geoMatchMode || d.geoMatchMode === "zip") return 0;
  try {
    const { zipsInsideShape } = await import("@/lib/zone-zip-fill.server");
    const fill = await zipsInsideShape(supabase, orgId, {
      mode: d.geoMatchMode,
      polygon: d.boundary ?? null,
      centerLat: d.centerLatitude ?? null,
      centerLng: d.centerLongitude ?? null,
      radiusMeters: d.radiusMeters ?? null,
      driveTimeMinutes: d.driveTimeMinutes ?? null,
    });
    let added = 0;
    for (const zip of fill.inside) {
      if (zipCodes.includes(zip)) continue;
      zipCodes.push(zip);
      added++;
    }
    return added;
  } catch (e) {
    console.error(`[zones] ZIP fill for a new zone failed for org ${orgId}:`, e);
    return 0;
  }
}

/**
 * An area-priced zone must declare a ceiling.
 *
 * `area_min_charge_cents` is a FLOOR, and until 2026-09 it was the only bound
 * the quote had: a per-sqft or per-acre rate times a large enough lot returned
 * an arbitrarily large per-visit price. On this database a 0.75c/sqft zone
 * computes $287.92 for a 35,700 sqft yard whose owner pays $26.00.
 *
 * Enforced on the WRITE rather than backfilled, because the cap is a price and
 * a price the software picked would be a price the software invented. Existing
 * zones keep quoting exactly as they do today until somebody edits one, at
 * which point they have to answer the question.
 *
 * `flat` zones are unaffected -- they have no area component to bound.
 */
function requireAreaCeiling(mode: string | null | undefined, maxCents: number | null | undefined) {
  if (mode !== "per_sqft" && mode !== "per_acre") return;
  if (maxCents == null || maxCents <= 0) {
    throw new Error(
      "A zone that prices by area needs a maximum area charge. Without one, a large property quotes an unbounded price: one yard in this database would quote $287.92 a visit. Set the most you would ever charge for the area component.",
    );
  }
}

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
      .select(
        "geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, pricing_mode, area_max_charge_cents",
      )
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .single();
    if (exErr) throw new Error(exErr.message);

    // Merged, not read from the patch: changing a flat zone to per_sqft
    // without touching the cap, and clearing the cap without touching the
    // mode, are both ways to end up area-priced with no ceiling.
    requireAreaCeiling(
      data.pricingMode !== undefined ? data.pricingMode : existing.pricing_mode,
      data.areaMaxChargeCents !== undefined
        ? data.areaMaxChargeCents
        : existing.area_max_charge_cents,
    );

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
    if (data.areaMinChargeCents !== undefined)
      patch.area_min_charge_cents = data.areaMinChargeCents;
    if (data.areaMaxChargeCents !== undefined)
      patch.area_max_charge_cents = data.areaMaxChargeCents;
    if (data.commercialBaseCents !== undefined)
      patch.commercial_base_cents = data.commercialBaseCents;
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
    // Zone ZIPs are US ZIPs (see the note at the top of this file), so the
    // country is said: a bare "78701" is a postcode somewhere else too.
    const geo = await geocodeAddress({ postal_code: data.postalCode, country: "United States" });
    return {
      point: geo ? { latitude: geo.latitude, longitude: geo.longitude } : null,
      // The town the ZIP is in, offered as a new zone's name.
      place: geo?.place ?? null,
    };
  });

// The ZIPs inside a drawn shape (owner, 2026-10-01: "it does not auto insert
// all the zip codes that are within that"). The database answers only "which
// ZIP centers are in this box"; which of those are INSIDE is decided by
// classifyZipCentroids, which asks zone-match.ts -- the same code that assigns
// properties -- so the fill and the matcher are one rule. See
// src/lib/zone-zip-fill.ts and 20261001120000_a-zone-you-drew-named-no-zips.sql.
const zipShapeSchema = z.object({
  mode: z.enum(["radius", "drive_time", "polygon"]),
  polygon: polygonSchema.optional(),
  centerLat: z.number().min(-90).max(90).nullable().optional(),
  centerLng: z.number().min(-180).max(180).nullable().optional(),
  radiusMeters: z.number().min(1).max(200000).nullable().optional(),
  driveTimeMinutes: z.number().min(1).max(180).nullable().optional(),
});

export const zipsInZoneShape = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => zipShapeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { zipsInsideShape } = await import("@/lib/zone-zip-fill.server");
    return zipsInsideShape(supabase, orgId, data);
  });

/**
 * Fill every drawn area that lists no ZIPs, in one click (#793).
 *
 * #778 fills a NEW setup area's ZIPs. An area saved before it still lists
 * none, so the signup page and lead form -- which match a visitor by ZIP
 * alone -- quote nobody in it. This is the owner's way out without opening
 * each one: the same inside-the-shape fill as "Fill ZIPs from the area",
 * applied only to areas whose list is empty, never adding a ZIP another zone
 * already quotes (see src/lib/zone-zip-backfill.ts). `dryRun` returns the
 * plan and writes nothing.
 */
export const fillEmptyZoneZips = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ dryRun: z.boolean().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    const { planOrgZoneZipBackfill, applyZoneZipBackfill } =
      await import("@/lib/zone-zip-backfill.server");
    const { backfillSummary } = await import("@/lib/zone-zip-backfill");
    const plan = await planOrgZoneZipBackfill(supabase, orgId);
    if (data.dryRun) return { plan, written: [] as string[], propertiesUpdated: 0, summary: null };
    const written = await applyZoneZipBackfill(supabase, orgId, plan);
    const propertiesUpdated =
      written.length > 0 ? await redetectBestEffort(supabase, orgId, userId) : 0;
    return { plan, written, propertiesUpdated, summary: backfillSummary(plan, written) };
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

/** Viewport for an unplaced new zone; scoped to the caller's organization. */
export const getNewZoneCenter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: org, error } = await supabase
      .from("organizations")
      .select("contact_address, latitude, longitude")
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    const { newZoneCenter } = await import("@/lib/new-zone-center");
    const { geocodeAddress } = await import("@/lib/geocode.server");
    return newZoneCenter(org, (address) => geocodeAddress({ street: address }));
  });
