import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ACCESS_CODE_MAX,
  ACCESS_METHODS,
  ALARM_NOTES_MAX,
  KEY_TAG_MAX,
  cleanKeyTag,
} from "@/lib/walk-access";

// yard_size is derived from the boundary by a DB trigger now; the field is
// still accepted (older forms send it) but never written.
const yardSize = z.enum(["small", "medium", "large", "xlarge"]).optional();

// GeoJSON Polygon: coordinates = [ [ [lng, lat], ... ] ]  first == last
const polygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)).min(1),
  })
  .nullable();

const createPropSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().max(120).optional(),
  accountType: z.enum(["residential", "commercial"]).optional(),
  commercialSections: z.array(z.string().max(120)).max(100).optional(),
  buildingLabels: z.array(z.string().max(120)).max(200).optional(),
  // C2: commercial properties can declare they have units + the total count,
  // so zone pricing uses TOTAL units (not dog-owning units).
  hasUnits: z.boolean().optional(),
  totalUnits: z.number().int().min(0).max(100000).optional().nullable(),
  street: z.string().min(1).max(200),
  unit: z.string().max(40).optional(),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  // On update, absent leaves the stored gate code alone and null clears it.
  // The drawer sends it only when the user changed it (gateCodeSave), so an
  // editor who could not load the codes does not wipe it.
  gateCode: z.string().max(ACCESS_CODE_MAX).nullable().optional(),
  parkingNotes: z.string().max(1000).optional(),
  // Provider-resolved coordinates (skip Nominatim when present) + whether
  // the address came from the search provider or manual entry.
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  addressSource: z.enum(["matched", "manual"]).optional(),
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
  // Service boundary sketched during creation (UX round 4: no more
  // save-then-reopen to draw the yard).
  boundary: polygonSchema.optional(),
  // How the walker gets in (#410). Sent only by a drawer that shows the
  // walker-access fields; absent means "leave the stored value alone", so a
  // pet-waste business's saves never touch these columns. The drawer also
  // leaves out a code the user did not change, so an editor who could not
  // load the codes does not wipe them. Null still clears.
  accessMethod: z.enum(ACCESS_METHODS).nullable().optional(),
  keyHeld: z.boolean().optional(),
  keyTag: z.string().max(KEY_TAG_MAX).nullable().optional(),
  lockBoxCode: z.string().max(ACCESS_CODE_MAX).nullable().optional(),
  keyLocation: z.string().max(200).nullable().optional(),
  alarmNotes: z.string().max(ALARM_NOTES_MAX).nullable().optional(),
});

/** The walker-access columns to write: only the fields the form sent. */
function walkAccessPatch(
  data: Pick<
    z.infer<typeof createPropSchema>,
    "accessMethod" | "keyHeld" | "keyTag" | "lockBoxCode" | "keyLocation" | "alarmNotes"
  >,
) {
  const patch: {
    access_method?: string | null;
    key_held?: boolean;
    key_tag?: string | null;
    lock_box_code?: string | null;
    key_location?: string | null;
    alarm_notes?: string | null;
  } = {};
  if (data.accessMethod !== undefined) patch.access_method = data.accessMethod;
  if (data.keyHeld !== undefined) patch.key_held = data.keyHeld;
  if (data.keyTag !== undefined) patch.key_tag = cleanKeyTag(data.keyTag);
  if (data.lockBoxCode !== undefined) patch.lock_box_code = data.lockBoxCode?.trim() || null;
  if (data.keyLocation !== undefined) patch.key_location = data.keyLocation?.trim() || null;
  if (data.alarmNotes !== undefined) patch.alarm_notes = data.alarmNotes?.trim() || null;
  return patch;
}

export const createProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createPropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id, account_type")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    // Address-provider coordinates win; only fall back to the free OSM
    // geocoder for manual entries without a resolved point.
    let geo: { latitude: number; longitude: number } | null =
      data.latitude != null && data.longitude != null
        ? { latitude: data.latitude, longitude: data.longitude }
        : null;
    if (!geo) {
      const { geocodeAddress } = await import("./geocode.server");
      geo = await geocodeAddress({
        street: data.street,
        city: data.city,
        region: data.region,
        postal_code: data.postalCode,
      });
    }

    // Auto-assign a service zone from the address (spec: automatic zone
    // lookup with manual override kept separate).
    const autoZoneId = await detectZoneId(supabase, client.organization_id, {
      postalCode: data.postalCode,
      point:
        geo?.latitude != null && geo?.longitude != null
          ? { lat: geo.latitude, lng: geo.longitude }
          : null,
      accountType: data.accountType ?? (client.account_type as any) ?? null,
    });

    const { data: row, error } = await supabase
      .from("properties")
      .insert({
        client_id: data.clientId,
        organization_id: client.organization_id,
        label: data.label || null,
        account_type: data.accountType ?? null,
        commercial_sections: data.commercialSections?.length ? data.commercialSections : null,
        building_labels: data.buildingLabels?.length ? data.buildingLabels : null,
        has_units: data.hasUnits ?? false,
        total_units: data.hasUnits ? (data.totalUnits ?? null) : null,
        street: data.street,
        unit: data.unit || null,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        parking_notes: data.parkingNotes || null,
        address_source: data.addressSource ?? "manual",
        auto_zone_id: autoZoneId,
        zone_id: autoZoneId,
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
        boundary: (data.boundary as any) ?? null,
        boundary_area_sqm: data.boundary ? polygonAreaSqm(data.boundary as any) : null,
        ...walkAccessPatch(data),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    if (data.boundary) {
      // Boundary drives yard size (DB trigger) and the time estimate.
      const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
      await recomputePropertyEstimate(supabase, row.id as string);
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: client.organization_id,
      clientId: data.clientId,
      propertyId: row.id as string,
      actorUserId: context.userId,
      kind: "property.created",
      summary: `Added property ${data.street}, ${data.city} ${data.postalCode}`,
    });
    return { id: row.id as string };
  });

export async function detectZoneId(
  supabase: any,
  orgId: string,
  input: {
    postalCode?: string | null;
    point?: { lat: number; lng: number } | null;
    accountType?: "residential" | "commercial" | null;
  },
): Promise<string | null> {
  const { data: zones, error } = await supabase
    .from("zones")
    .select(
      "id, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
    )
    .eq("organization_id", orgId);
  if (error) return null;
  const { matchZone } = await import("@/lib/zone-match");
  const z = matchZone((zones ?? []) as any[], input);
  return z ? (z.id as string) : null;
}

const updatePropSchema = createPropSchema.omit({ clientId: true }).extend({
  propertyId: z.string().uuid(),
});

export const updateProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updatePropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: current, error: curErr } = await supabase
      .from("properties")
      .select(
        "organization_id, client_id, zone_override_reason, street, city, postal_code, auto_zone_id, zone_id, has_units, total_units, boundary_area_sqm, do_not_enter_if_dog_out, hazard_notes, clients(account_type)",
      )
      .eq("id", data.propertyId)
      .single();
    if (curErr) throw new Error(curErr.message);

    // The caller cannot select gate_code. The stored value is read with the
    // service role only to tell whether it changed, and only for a property
    // the caller's own query just returned. It is never sent back.
    const gateCodeSent = data.gateCode !== undefined;
    const nextGateCode = gateCodeSent ? data.gateCode?.trim() || null : undefined;
    let gateCodeBefore: string | null = null;
    if (gateCodeSent) {
      const { storedGateCode } = await import("@/lib/field-notify.server");
      gateCodeBefore = await storedGateCode(data.propertyId, current.organization_id);
    }

    // Provider-resolved coordinates win; otherwise re-geocode via OSM when
    // the address might have changed (cheap, keeps lat/lng fresh).
    let geo: { latitude: number; longitude: number } | null =
      data.latitude != null && data.longitude != null
        ? { latitude: data.latitude, longitude: data.longitude }
        : null;
    if (!geo) {
      const { geocodeAddress } = await import("./geocode.server");
      geo = await geocodeAddress({
        street: data.street,
        city: data.city,
        region: data.region,
        postal_code: data.postalCode,
      });
    }

    // Only overwrite coordinates when geocoding actually resolved, so a
    // transient geocoder miss doesn't blank out a good pin.
    const geoPatch =
      geo?.latitude != null && geo?.longitude != null
        ? { latitude: geo.latitude, longitude: geo.longitude }
        : {};

    // Refresh the detected zone; the effective zone follows it only while
    // there is no manual override in place.
    const autoZoneId = await detectZoneId(supabase, current.organization_id, {
      postalCode: data.postalCode,
      point:
        geo?.latitude != null && geo?.longitude != null
          ? { lat: geo.latitude, lng: geo.longitude }
          : null,
      accountType: data.accountType ?? ((current as any).clients?.account_type as any) ?? null,
    });
    // A property in a zone that is turned off stays in it (#449), whatever is
    // edited: the same rule redetectZonesForOrg follows.
    let inOffZone = false;
    if ((current as any).zone_id) {
      const { data: currentZone, error: zoneErr } = await (supabase as any)
        .from("zones")
        .select("enabled")
        .eq("id", (current as any).zone_id)
        .maybeSingle();
      // A failed read keeps the zone: leaving a client where they are is
      // safe, moving them out of a zone that may be off is not.
      inOffZone = !!zoneErr || currentZone?.enabled === false;
    }
    const { zonePatchAfterEdit } = await import("@/lib/zone-enabled");
    const zonePatch = zonePatchAfterEdit({
      autoZoneId,
      hasOverride: !!current.zone_override_reason,
      inOffZone,
    });

    const { error } = await supabase
      .from("properties")
      .update({
        label: data.label || null,
        account_type: data.accountType ?? null,
        commercial_sections: data.commercialSections?.length ? data.commercialSections : null,
        building_labels: data.buildingLabels?.length ? data.buildingLabels : null,
        has_units: data.hasUnits ?? false,
        total_units: data.hasUnits ? (data.totalUnits ?? null) : null,
        street: data.street,
        unit: data.unit || null,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        ...(gateCodeSent ? { gate_code: nextGateCode } : {}),
        parking_notes: data.parkingNotes || null,
        address_source: data.addressSource ?? "manual",
        ...zonePatch,
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
        ...walkAccessPatch(data),
        ...geoPatch,
      })
      .eq("id", data.propertyId);
    if (error) throw new Error(error.message);

    // A tech going there TODAY hears that the gate code, the do-not-enter
    // rule or the hazard notes changed (never the code itself: a push is on
    // a lock screen). Never throws.
    const { notifyAccessChanged } = await import("@/lib/field-notify.server");
    await notifyAccessChanged({
      propertyId: data.propertyId,
      // A gate code left out of the save did not change.
      before: { ...(current as any), gate_code: gateCodeBefore },
      after: {
        gate_code: gateCodeSent ? nextGateCode : gateCodeBefore,
        do_not_enter_if_dog_out: !!data.doNotEnterIfDogOut,
        hazard_notes: data.hazardNotes || null,
      },
      actorUserId: context.userId,
    });

    // The property's total_units is the single source of truth for commercial
    // unit counts (no double entry): when it changes, active subscriptions on
    // this property follow it — unit_count always, and price_cents too when
    // the service's zone carries commercial rates (unit-priced HOAs must not
    // keep billing the old count). Manual/no-zone prices are left alone and
    // every price change is activity-logged with before/after (I6).
    const newTotalUnits = data.hasUnits ? (data.totalUnits ?? null) : null;
    if (newTotalUnits != null && newTotalUnits !== (current as any).total_units) {
      try {
        const [subsRes, stationsRes, orgRes] = await Promise.all([
          supabase
            .from("subscriptions")
            .select("id, unit_count, price_cents, frequency, zone_id")
            .eq("property_id", data.propertyId)
            .eq("status", "active"),
          (supabase as any)
            .from("waste_stations")
            .select("id")
            .eq("property_id", data.propertyId)
            .neq("active", false),
          supabase
            .from("organizations")
            .select("frequency_multipliers")
            .eq("id", current.organization_id)
            .maybeSingle(),
        ]);
        const stationCount = (stationsRes.data ?? []).length;
        const multipliers = ((orgRes.data as any)?.frequency_multipliers ?? {}) as Record<
          string,
          number
        >;
        const { computeCommercialZonePrice, zoneHasCommercialPricing } =
          await import("@/lib/pricing");
        const { perVisitMultiplier } = await import("@/lib/frequency-multipliers");
        const { logActivity } = await import("@/lib/activity.server");
        for (const sub of subsRes.data ?? []) {
          let pricePatch: Record<string, number> = {};
          if (sub.zone_id) {
            const { data: zone } = await (supabase as any)
              .from("zones")
              .select(
                "commercial_base_cents, commercial_per_unit_cents, commercial_per_acre_cents, commercial_per_station_cents",
              )
              .eq("id", sub.zone_id)
              .maybeSingle();
            if (zone && zoneHasCommercialPricing(zone)) {
              const mult = perVisitMultiplier(multipliers, sub.frequency);
              const price = computeCommercialZonePrice(zone, {
                unitCount: newTotalUnits,
                boundaryAreaSqm: (current as any).boundary_area_sqm,
                stationCount,
                multiplier: mult,
              });
              if (price.recurringCents !== sub.price_cents) {
                pricePatch = { price_cents: price.recurringCents };
              }
            }
          }
          const { error: subErr } = await supabase
            .from("subscriptions")
            .update({ unit_count: newTotalUnits, ...pricePatch })
            .eq("id", sub.id);
          if (subErr) {
            console.warn("unit_count sync failed:", subErr.message);
            continue;
          }
          if (pricePatch.price_cents != null) {
            await logActivity(supabase, {
              orgId: current.organization_id,
              clientId: current.client_id,
              propertyId: data.propertyId,
              subscriptionId: sub.id,
              actorUserId: context.userId,
              kind: "service.price_changed",
              summary: `Changed service price from $${((sub.price_cents ?? 0) / 100).toFixed(2)} to $${(pricePatch.price_cents / 100).toFixed(2)} per visit (property units ${(current as any).total_units ?? "unset"} → ${newTotalUnits})`,
              meta: {
                source: "property_total_units_change",
                before: { unit_count: sub.unit_count, price_cents: sub.price_cents },
                after: { unit_count: newTotalUnits, price_cents: pricePatch.price_cents },
              },
            });
          }
        }
      } catch (syncErr) {
        console.warn("total_units propagation failed:", (syncErr as Error).message);
      }
    }

    const { logActivity } = await import("@/lib/activity.server");
    const addressChanged =
      current.street !== data.street ||
      current.city !== data.city ||
      current.postal_code !== data.postalCode;
    await logActivity(supabase, {
      orgId: current.organization_id,
      clientId: current.client_id,
      propertyId: data.propertyId,
      actorUserId: context.userId,
      kind: "property.updated",
      summary: addressChanged
        ? `Changed property address from ${current.street}, ${current.city} to ${data.street}, ${data.city}`
        : `Updated property ${data.street}, ${data.city}`,
      meta: addressChanged
        ? {
            before: {
              street: current.street,
              city: current.city,
              postal_code: current.postal_code,
            },
            after: { street: data.street, city: data.city, postal_code: data.postalCode },
          }
        : {},
    });
    if ("auto_zone_id" in zonePatch && autoZoneId !== current.auto_zone_id) {
      await logActivity(supabase, {
        orgId: current.organization_id,
        clientId: current.client_id,
        propertyId: data.propertyId,
        actorUserId: context.userId,
        kind: "zone.detected",
        summary: `Detected zone changed for ${data.street}`,
        meta: { before: current.auto_zone_id, after: autoZoneId },
      });
    }
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

    // One call for the whole page: a single Geocodio batch request when a key
    // is configured, the old 1/s Nominatim loop when it is not.
    const { geocodeAddresses } = await import("./geocode.server");
    const geos = await geocodeAddresses(
      rows.map((r) => ({
        street: r.street,
        city: r.city,
        region: r.region,
        postal_code: r.postal_code,
      })),
    );
    let updated = 0;
    for (const [i, r] of rows.entries()) {
      const geo = geos[i];
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
        "id, label, street, city, region, postal_code, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, earliest_service_time, latest_service_time, service_duration_min, visit_contact_name, visit_contact_phone, visit_contact_email, boundary, boundary_area_sqm, archived_at, account_type, commercial_sections, building_labels, has_units, total_units, auto_zone_id, zone_id, zone_override_reason, est_override_reason, est_override_at, parking_notes, access_notes, latitude, longitude, unit, address_source, access_method, key_held",
      )
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    const { accessFor, accessLoaded, readPropertyAccess } = await import("@/lib/property-access");
    const access = await readPropertyAccess(
      supabase,
      (rows ?? []).map((r) => r.id),
    );
    return {
      properties: (rows ?? []).map((r) => ({
        ...r,
        ...accessFor(access, r.id),
        // The drawer sends the codes only when they were loaded or typed.
        access_codes_loaded: accessLoaded(access, r.id),
      })),
    };
  });

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

/** Geocode an address before the property exists (UX round 4): centers the
 * create-mode boundary sketch for manually typed addresses. Same geocoder
 * the create path uses, so the preview pin matches what save would compute. */
export const geocodePreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        street: z.string().min(1).max(200),
        city: z.string().min(1).max(120),
        region: z.string().max(120).optional(),
        postalCode: z.string().min(1).max(20),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { geocodeAddress } = await import("./geocode.server");
    const geo = await geocodeAddress({
      street: data.street,
      city: data.city,
      region: data.region,
      postal_code: data.postalCode,
    });
    return { point: geo ? { latitude: geo.latitude, longitude: geo.longitude } : null };
  });

export const getPropertyBoundary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("properties")
      .select(
        "id, client_id, street, city, postal_code, latitude, longitude, boundary, boundary_area_sqm, yard_size, clients(id, display_name)",
      )
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

    // Boundary drives the derived yard size (DB trigger) and the estimated
    // time; keep the estimate in sync unless a manual override is in place.
    const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
    await recomputePropertyEstimate(context.supabase, data.propertyId);

    try {
      const { data: propRow } = await context.supabase
        .from("properties")
        .select("client_id, street")
        .eq("id", data.propertyId)
        .single();
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(context.supabase, {
        orgId,
        clientId: propRow?.client_id ?? null,
        propertyId: data.propertyId,
        actorUserId: context.userId,
        kind: "boundary.updated",
        summary: data.boundary
          ? `Updated the service boundary${propRow?.street ? ` at ${propRow.street}` : ""}`
          : `Removed the service boundary${propRow?.street ? ` at ${propRow.street}` : ""}`,
        meta: { area_sqm: area },
      });
    } catch {}

    return { ok: true, area_sqm: area };
  });

// ── Archive / delete (client detail refactor) ───────────────────────────────
//
// Properties with history are archived, never deleted; deletion is allowed
// only when nothing references the property (no visits, no services, no
// invoice lines through those services).

export const setPropertyArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ propertyId: z.string().uuid(), archived: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("properties")
      .update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", data.propertyId)
      .select("id, organization_id, client_id, street");
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Property not found");

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: row.organization_id,
      clientId: row.client_id,
      propertyId: row.id,
      actorUserId: userId,
      kind: data.archived ? "property.archived" : "property.unarchived",
      summary: `${data.archived ? "Archived" : "Restored"} property ${row.street}`,
    });
    return { ok: true };
  });

export const deletePropertyIfNoHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("id, organization_id, client_id, street, city")
      .eq("id", data.propertyId)
      .single();
    if (pErr) throw new Error(pErr.message);

    const { count: visitCount, error: vErr } = await supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("property_id", prop.id);
    if (vErr) throw new Error(vErr.message);
    const { count: subCount, error: sErr } = await supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("property_id", prop.id);
    if (sErr) throw new Error(sErr.message);
    if ((visitCount ?? 0) > 0 || (subCount ?? 0) > 0)
      throw new Error("This property has history. Archive it instead of deleting.");

    // Nothing operational references it: clear dependents, then the row.
    const { error: dErr } = await supabase.from("dogs").delete().eq("property_id", prop.id);
    if (dErr) throw new Error(dErr.message);
    const { error: wErr } = await supabase
      .from("waste_stations")
      .delete()
      .eq("property_id", prop.id);
    if (wErr) throw new Error(wErr.message);
    const { error } = await supabase.from("properties").delete().eq("id", prop.id);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: prop.organization_id,
      clientId: prop.client_id,
      actorUserId: userId,
      kind: "property.deleted",
      summary: `Deleted property ${prop.street}, ${prop.city ?? ""} (no history)`,
    });
    return { ok: true };
  });

// ── Zone override (client detail refactor) ──────────────────────────────────
//
// auto_zone_id is what the matcher detected; zone_id is what actually
// applies. Overriding requires a reason and records who did it. Clearing
// the override snaps the effective zone back to the detected one.

export const setPropertyZoneOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        propertyId: z.string().uuid(),
        zoneId: z.string().uuid().nullable(),
        reason: z.string().min(1).max(300).optional(),
      })
      .refine((v) => v.zoneId === null || !!v.reason, {
        message: "An override needs a reason",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    await requirePermission(supabase, userId, "manage_pricing");

    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("id, organization_id, client_id, street, auto_zone_id")
      .eq("id", data.propertyId)
      .single();
    if (pErr) throw new Error(pErr.message);

    const patch =
      data.zoneId === null
        ? {
            zone_id: prop.auto_zone_id,
            zone_override_reason: null,
            zone_override_by: null,
          }
        : {
            zone_id: data.zoneId,
            zone_override_reason: data.reason!,
            zone_override_by: userId,
          };
    const { error } = await supabase.from("properties").update(patch).eq("id", prop.id);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: prop.organization_id,
      clientId: prop.client_id,
      propertyId: prop.id,
      actorUserId: userId,
      kind: data.zoneId === null ? "zone.override_cleared" : "zone.overridden",
      summary:
        data.zoneId === null
          ? `Cleared zone override on ${prop.street}`
          : `Overrode zone on ${prop.street}: ${data.reason}`,
      meta: { zone_id: data.zoneId, auto_zone_id: prop.auto_zone_id },
    });
    return { ok: true };
  });

// ── Estimated-time override (client detail refactor) ────────────────────────
//
// service_duration_min doubles as the authorized override slot: null means
// "use the computed estimate", a value means an override and must carry a
// reason. Clearing it returns the property to auto-calculation.

export const setPropertyEstimateOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        propertyId: z.string().uuid(),
        minutes: z.number().int().min(1).max(600).nullable(),
        reason: z.string().min(1).max(300).optional(),
      })
      .refine((v) => v.minutes === null || !!v.reason, {
        message: "An override needs a reason",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    await requirePermission(supabase, userId, "manage_pricing");

    const { data: rows, error } = await supabase
      .from("properties")
      .update(
        data.minutes === null
          ? // Back to auto: clear the override marker, then recompute below.
            {
              est_override_reason: null,
              est_override_by: null,
              est_override_at: null,
            }
          : {
              service_duration_min: data.minutes,
              est_override_reason: data.reason!,
              est_override_by: userId,
              est_override_at: new Date().toISOString(),
            },
      )
      .eq("id", data.propertyId)
      .select("id, organization_id, client_id, street");
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Property not found");

    if (data.minutes === null) {
      const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
      await recomputePropertyEstimate(supabase, row.id);
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: row.organization_id,
      clientId: row.client_id,
      propertyId: row.id,
      actorUserId: userId,
      kind: data.minutes === null ? "estimate.override_cleared" : "estimate.overridden",
      summary:
        data.minutes === null
          ? `Returned ${row.street} to auto-calculated time`
          : `Set time override on ${row.street} to ${data.minutes} min: ${data.reason}`,
    });
    return { ok: true };
  });
