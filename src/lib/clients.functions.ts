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
  if (!data) throw new Error("No organization found for this user. Complete onboarding first.");
  return data.organization_id as string;
}

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("clients")
      .select(
        "id, display_name, account_type, primary_email, primary_phone, active, created_at, credit_balance_cents, churn_score",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const clients = data ?? [];
    const ids = clients.map((c: any) => c.id);

    // Fetch aggregate side-data in parallel; ignore individual failures.
    const [dogsRes, subsRes, invRes] = await Promise.all([
      ids.length
        ? supabase.from("dogs").select("client_id").in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase
            .from("subscriptions")
            .select("client_id, status")
            .in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase
            .from("invoices")
            .select("client_id, amount_cents, amount_paid_cents, status")
            .in("client_id", ids)
            .eq("status", "open")
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const dogsByClient = new Map<string, number>();
    for (const d of dogsRes.data ?? []) {
      dogsByClient.set(d.client_id, (dogsByClient.get(d.client_id) ?? 0) + 1);
    }
    const activeSubsByClient = new Map<string, number>();
    for (const s of subsRes.data ?? []) {
      if (s.status === "active")
        activeSubsByClient.set(
          s.client_id,
          (activeSubsByClient.get(s.client_id) ?? 0) + 1,
        );
    }
    const balanceByClient = new Map<string, number>();
    for (const inv of invRes.data ?? []) {
      const owed = (inv.amount_cents ?? 0) - (inv.amount_paid_cents ?? 0);
      if (owed > 0)
        balanceByClient.set(
          inv.client_id,
          (balanceByClient.get(inv.client_id) ?? 0) + owed,
        );
    }

    return {
      clients: clients.map((c: any) => ({
        ...c,
        dog_count: dogsByClient.get(c.id) ?? 0,
        active_subscription_count: activeSubsByClient.get(c.id) ?? 0,
        outstanding_cents: balanceByClient.get(c.id) ?? 0,
      })),
    };
  });


const createClientSchema = z.object({
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
});

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => createClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: row, error } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id, portal_token")
      .single();
    if (error) throw new Error(error.message);

    // Fire welcome email (best-effort; never block client creation)
    if (data.primaryEmail) {
      try {
        const appUrl = process.env.APP_URL || "https://pal-primer.lovable.app";
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: row.id as string,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${row.id}`,
          templateData: {
            portalUrl: row.portal_token ? `${appUrl}/portal/${row.portal_token}` : undefined,
          },
        });
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }
    return { id: row.id as string };
  });

const getClientSchema = z.object({ clientId: z.string().uuid() });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error } = await supabase
      .from("clients")
      .select("id, display_name, account_type, primary_email, primary_phone, active, created_at, notes, portal_token, sms_opt_out, referral_code, referred_by_client_id, referral_applied_at, review_asked_at, review_submitted_at")
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    return { client };
  });

// ---------- Internal quote (for authenticated onboarding wizard) ----------

const internalQuoteSchema = z.object({
  postalCode: z.string().trim().min(3).max(12),
  dogCount: z.coerce.number().int().min(1).max(20),
  frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]),
  boundaryAreaSqm: z.number().positive().max(1_000_000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pointInPolygon(point: { lat: number; lng: number }, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > point.lat) !== (yj > point.lat) && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export const getInternalQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => internalQuoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: org, error: oErr } = await supabase
      .from("organizations")
      .select("currency, frequency_multipliers")
      .eq("id", orgId)
      .single();
    if (oErr) throw new Error(oErr.message);

    const { data: zones, error: zErr } = await supabase
      .from("zones")
      .select("id, name, postal_prefix, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes")
      .eq("organization_id", orgId);
    if (zErr) throw new Error(zErr.message);

    const pc = data.postalCode.trim();
    const pt = data.latitude != null && data.longitude != null ? { lat: data.latitude, lng: data.longitude } : null;
    const DRIVE_M_PER_MIN = 800;

    const match = (zones ?? [])
      .map((z: any) => {
        const mode = (z.geo_match_mode ?? "zip") as string;
        // Geo match takes precedence when configured and we have a point
        if (pt) {
          if (mode === "polygon" && z.boundary?.coordinates?.[0]) {
            const ring = z.boundary.coordinates[0] as number[][];
            if (pointInPolygon(pt, ring)) return { z, rank: -2, prefLen: 0 };
          }
          if (mode === "radius" && z.center_latitude != null && z.center_longitude != null && z.radius_meters) {
            if (haversineMeters(pt, { lat: Number(z.center_latitude), lng: Number(z.center_longitude) }) <= z.radius_meters) return { z, rank: -1, prefLen: 0 };
          }
          if (mode === "drive_time" && z.center_latitude != null && z.center_longitude != null && z.drive_time_minutes) {
            if (haversineMeters(pt, { lat: Number(z.center_latitude), lng: Number(z.center_longitude) }) <= z.drive_time_minutes * DRIVE_M_PER_MIN) return { z, rank: -1, prefLen: 0 };
          }
        }
        const exact = Array.isArray(z.zip_codes) && z.zip_codes.includes(pc);
        const prefix = z.postal_prefix && pc.startsWith(z.postal_prefix);
        if (!exact && !prefix) return null;
        return { z, rank: exact ? 0 : 1, prefLen: (z.postal_prefix ?? "").length };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.rank - b.rank || b.prefLen - a.prefLen)[0] as any;

    if (!match) return { available: false as const };
    const z = match.z;
    const mult = Number((org.frequency_multipliers as any)?.[data.frequency] ?? 1);
    const dogAddl = Math.max(0, data.dogCount - 1) * (z.per_dog_addl_cents ?? 0);
    const mode = (z.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre";

    let baseVisit: number;
    let areaBasisCents: number | null = null;
    if (mode !== "flat" && data.boundaryAreaSqm) {
      const sqft = data.boundaryAreaSqm * 10.7639;
      const acres = data.boundaryAreaSqm / 4046.8564;
      const raw =
        mode === "per_sqft"
          ? Math.round(sqft * Number(z.price_per_sqft_cents ?? 0))
          : Math.round(acres * (z.price_per_acre_cents ?? 0));
      areaBasisCents = raw;
      baseVisit = Math.max(raw, z.area_min_charge_cents ?? 0);
    } else {
      baseVisit = z.base_price_cents ?? 0;
    }
    const perVisit = baseVisit + dogAddl;
    const recurring = Math.round(perVisit * mult);
    return {
      available: true as const,
      quote: {
        zoneId: z.id as string,
        zoneName: z.name as string,
        pricingMode: mode,
        areaBasisCents,
        basePriceCents: perVisit,
        perDogAddlCents: z.per_dog_addl_cents ?? 0,
        recurringPriceCents: recurring,
        initialCleanupCents: z.initial_cleanup_cents ?? 0,
        currency: org.currency as string,
      },
    };
  });

// ---------- Composite onboarding: client + property + dogs + subscription ----------

const onboardSchema = z.object({
  // client
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
  // property
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  gateCode: z.string().max(60).optional(),
  yardSize: z.enum(["small", "medium", "large", "xlarge"]).optional(),
  hazardNotes: z.string().max(1000).optional(),
  hazards: z
    .object({
      doNotEnterIfDogOut: z.boolean().optional(),
      aggressiveDog: z.boolean().optional(),
      escapeRisk: z.boolean().optional(),
      invisibleFence: z.boolean().optional(),
      dogInYardDuringService: z.boolean().optional(),
      beesWasps: z.boolean().optional(),
      sharpObjects: z.boolean().optional(),
      slipperySurfaces: z.boolean().optional(),
    })
    .optional(),
  boundary: z
    .object({
      type: z.literal("Polygon"),
      coordinates: z.array(z.array(z.array(z.number()))),
    })
    .optional(),
  boundaryAreaSqm: z.number().positive().max(1_000_000).optional(),
  // dogs
  dogs: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        breed: z.string().max(120).optional(),
        weightClass: z.string().max(40).optional(),
        temperament: z.enum(["friendly", "shy", "anxious", "aggressive", "unknown"]).optional(),
        notes: z.string().max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
  // subscription (optional — user may skip)
  subscription: z
    .object({
      frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
      priceCents: z.number().int().min(0),
      dogCount: z.number().int().min(1).optional(),
      unitCount: z.number().int().min(1).optional(),
      zoneId: z.string().uuid().optional(),
      billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
      preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    })
    .optional(),
});

export const onboardClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => onboardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    // 1) client
    const { data: cRow, error: cErr } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id, portal_token")
      .single();
    if (cErr) throw new Error(cErr.message);
    const clientId = cRow.id as string;

    // 2) property (best-effort geocode)
    let latitude: number | null = null;
    let longitude: number | null = null;
    try {
      const { geocodeAddress } = await import("./geocode.server");
      const geo = await geocodeAddress({
        street: data.street,
        city: data.city,
        region: data.region,
        postal_code: data.postalCode,
      });
      latitude = geo?.latitude ?? null;
      longitude = geo?.longitude ?? null;
    } catch {}

    const hz = data.hazards ?? {};
    const { data: pRow, error: pErr } = await supabase
      .from("properties")
      .insert({
        client_id: clientId,
        organization_id: orgId,
        street: data.street,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        yard_size: data.yardSize ?? null,
        do_not_enter_if_dog_out: !!hz.doNotEnterIfDogOut,
        aggressive_dog: !!hz.aggressiveDog,
        escape_risk: !!hz.escapeRisk,
        invisible_fence: !!hz.invisibleFence,
        dog_in_yard_during_service: !!hz.dogInYardDuringService,
        bees_wasps: !!hz.beesWasps,
        sharp_objects: !!hz.sharpObjects,
        slippery_surfaces: !!hz.slipperySurfaces,
        hazard_notes: data.hazardNotes || null,
        latitude,
        longitude,
        boundary: (data.boundary as any) ?? null,
        boundary_area_sqm: data.boundaryAreaSqm ?? null,
      })
      .select("id")
      .single();
    if (pErr) throw new Error(pErr.message);
    const propertyId = pRow.id as string;

    // 3) dogs
    if (data.dogs?.length) {
      const rows = data.dogs.map((d) => ({
        organization_id: orgId,
        property_id: propertyId,
        name: d.name,
        breed: d.breed || null,
        weight_class: d.weightClass || null,
        temperament: (d.temperament ?? "unknown") as any,
        notes: d.notes || null,
      }));
      const { error: dErr } = await supabase.from("dogs").insert(rows);
      if (dErr) throw new Error(dErr.message);
    }

    // 4) subscription
    if (data.subscription) {
      const s = data.subscription;
      const isRes = data.accountType === "residential";
      const { error: sErr } = await supabase.from("subscriptions").insert({
        organization_id: orgId,
        client_id: clientId,
        property_id: propertyId,
        account_type: data.accountType,
        frequency: s.frequency,
        price_cents: s.priceCents,
        dog_count: isRes ? (s.dogCount ?? data.dogs?.length ?? 1) : null,
        unit_count: !isRes ? (s.unitCount ?? 1) : null,
        zone_id: s.zoneId ?? null,
        billing_cadence: s.billingCadence ?? "postpaid",
        preferred_weekdays: s.preferredWeekdays?.length ? s.preferredWeekdays : null,
      });
      if (sErr) throw new Error(sErr.message);
    }

    // welcome email (best-effort)
    if (data.primaryEmail) {
      try {
        const appUrl = process.env.APP_URL || "https://pal-primer.lovable.app";
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${clientId}`,
          templateData: {
            portalUrl: cRow.portal_token ? `${appUrl}/portal/${cRow.portal_token}` : undefined,
          },
        });
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }

    return { id: clientId };
  });
