import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

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
    // Full roster with contact info and balances — not for field techs.
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");
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
    const [propsRes, subsRes, invRes] = await Promise.all([
      ids.length
        ? supabase.from("properties").select("id, client_id, dogs(id)").in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase.from("subscriptions").select("client_id, status, frequency").in("client_id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabase
            .from("invoices")
            .select("client_id, total_cents, status")
            .in("client_id", ids)
            .eq("status", "open")
        : Promise.resolve({ data: [] as any[] }),
    ]);

    // Dogs live on properties (dogs.property_id), so aggregate through the
    // property → client relationship instead of a non-existent dogs.client_id.
    const dogsByClient = new Map<string, number>();
    for (const p of (propsRes.data ?? []) as Array<{ client_id: string; dogs: unknown[] | null }>) {
      const n = Array.isArray(p.dogs) ? p.dogs.length : 0;
      if (!p.client_id) continue;
      dogsByClient.set(p.client_id, (dogsByClient.get(p.client_id) ?? 0) + n);
    }
    const activeSubsByClient = new Map<string, number>();
    // Service-frequency label for the list view (punch list #15): distinct
    // active-subscription frequencies per client.
    const freqsByClient = new Map<string, string[]>();
    for (const s of subsRes.data ?? []) {
      if (s.status === "active") {
        activeSubsByClient.set(s.client_id, (activeSubsByClient.get(s.client_id) ?? 0) + 1);
        const f = (s as any).frequency as string | null;
        if (f) {
          const list = freqsByClient.get(s.client_id) ?? [];
          if (!list.includes(f)) list.push(f);
          freqsByClient.set(s.client_id, list);
        }
      }
    }
    // Same AR math as Dashboard "AR Open" and Reports "Outstanding" (finding #7).
    const { outstandingByClient } = await import("@/lib/ar");
    const balanceByClient = outstandingByClient((invRes.data ?? []) as any[]);

    return {
      clients: clients.map((c: any) => ({
        ...c,
        dog_count: dogsByClient.get(c.id) ?? 0,
        active_subscription_count: activeSubsByClient.get(c.id) ?? 0,
        frequencies: freqsByClient.get(c.id) ?? [],
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

    {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: row.id as string,
        actorUserId: userId,
        kind: "client.created",
        summary: `Created client ${data.displayName}`,
      });
    }

    // Fire welcome email (best-effort; never block client creation)
    if (data.primaryEmail) {
      try {
        const { buildPortalLink } = await import("@/lib/portal-links.server");
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: row.id as string,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${row.id}`,
          templateData: {
            portalUrl: await buildPortalLink(orgId, row.portal_token as string | null),
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
    // Contact info, notes, and the portal token — not for field techs.
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: client, error } = await supabase
      .from("clients")
      .select(
        "id, display_name, first_name, last_name, company, account_type, primary_email, primary_phone, active, created_at, notes, portal_token, sms_opt_out, email_opt_out, referral_code, referred_by_client_id, referral_applied_at, review_asked_at, review_submitted_at, tags, preferred_contact, referral_source, churn_score, autopay_paused",
      )
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    return { client };
  });

/** Edit-client drawer (client detail refactor): contact, status, tags,
 * preferences. Billing addresses live in Stripe, never here. */
export const updateClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        displayName: z.string().min(1).max(200).optional(),
        firstName: z.string().max(100).nullable().optional(),
        lastName: z.string().max(100).nullable().optional(),
        company: z.string().max(200).nullable().optional(),
        primaryEmail: z.string().email().max(200).or(z.literal("")).optional(),
        primaryPhone: z.string().max(40).optional(),
        accountType: z.enum(["residential", "commercial"]).optional(),
        active: z.boolean().optional(),
        tags: z.array(z.string().min(1).max(40)).max(30).optional(),
        preferredContact: z.enum(["sms", "email", "phone"]).nullable().optional(),
        referralSource: z.string().max(200).nullable().optional(),
        smsOptOut: z.boolean().optional(),
        emailOptOut: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "view_client_directory");

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const changed: string[] = [];
    if (data.firstName !== undefined || data.lastName !== undefined || data.company !== undefined) {
      // Display-name logic (QA follow-up 4.2): person name wins; company
      // stands in when there is no person name.
      if (data.firstName !== undefined) patch.first_name = data.firstName || null;
      if (data.lastName !== undefined) patch.last_name = data.lastName || null;
      if (data.company !== undefined) patch.company = data.company || null;
      const person = [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
      const derived = person || data.company || data.displayName || "";
      if (derived) patch.display_name = derived;
      changed.push("name");
    } else if (data.displayName !== undefined) {
      patch.display_name = data.displayName;
      changed.push("name");
    }
    if (data.primaryEmail !== undefined) {
      patch.primary_email = data.primaryEmail || null;
      changed.push("email");
    }
    if (data.primaryPhone !== undefined) {
      patch.primary_phone = data.primaryPhone || null;
      changed.push("phone");
    }
    if (data.accountType !== undefined) {
      patch.account_type = data.accountType;
      changed.push("client type");
    }
    if (data.active !== undefined) {
      patch.active = data.active;
      changed.push("status");
    }
    if (data.tags !== undefined) {
      patch.tags = data.tags;
      changed.push("tags");
    }
    if (data.preferredContact !== undefined) {
      patch.preferred_contact = data.preferredContact;
      changed.push("preferred contact");
    }
    if (data.referralSource !== undefined) {
      patch.referral_source = data.referralSource || null;
      changed.push("referral source");
    }
    if (data.smsOptOut !== undefined) {
      patch.sms_opt_out = data.smsOptOut;
      changed.push("SMS preference");
    }
    if (data.emailOptOut !== undefined) {
      patch.email_opt_out = data.emailOptOut;
      changed.push("email preference");
    }
    if (changed.length === 0) return { ok: true };

    // Before-image so the timeline can show before -> after (spec Stage 5).
    const { data: beforeRow } = await supabase
      .from("clients")
      .select(
        "display_name, first_name, last_name, company, primary_email, primary_phone, account_type, active, tags, preferred_contact, referral_source, sms_opt_out, email_opt_out",
      )
      .eq("id", data.clientId)
      .single();

    const { data: rows, error } = await supabase
      .from("clients")
      .update(patch as never)
      .eq("id", data.clientId)
      .select("id, organization_id");
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Client not found");

    const beforeChanged: Record<string, unknown> = {};
    const afterChanged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "updated_at") continue;
      beforeChanged[k] = (beforeRow as any)?.[k] ?? null;
      afterChanged[k] = v;
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: row.organization_id,
      clientId: row.id,
      actorUserId: userId,
      kind: "client.updated",
      summary: `Updated client ${changed.join(", ")}`,
      meta: { fields: changed, before: beforeChanged, after: afterChanged },
    });
    return { ok: true };
  });

/** Office notes on the client record (gate quirks, preferences, history). */
export const updateClientNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), notes: z.string().max(8000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { error } = await supabase
      .from("clients")
      .update({ notes: data.notes || null, updated_at: new Date().toISOString() })
      .eq("id", data.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Full visit history for the Visits tab: scheduled window vs actual
 * start/completion so "estimated" and "actually happened" never blur. */
export const listClientVisitHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ clientId: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const select =
      "id, subscription_id, property_id, scheduled_on, status, started_at, completed_at, eta_start, eta_end, skip_reason_code, skip_reason, rescheduled_from, is_deepclean, properties(street, earliest_service_time, latest_service_time), subscriptions(earliest_time, latest_time), staff:assigned_staff_id(display_name)";
    const limit = data.limit ?? 100;
    const today = new Date().toISOString().slice(0, 10);
    // Two windows so a heavily scheduled client (many future visits) can't
    // push real history out of a single desc-ordered page: the EARLIEST
    // upcoming visits (next-visit math needs the minimum) plus the LATEST
    // past ones.
    const [upcoming, past] = await Promise.all([
      supabase
        .from("visits")
        .select(select)
        .eq("client_id", data.clientId)
        .gte("scheduled_on", today)
        .order("scheduled_on", { ascending: true })
        .limit(limit),
      supabase
        .from("visits")
        .select(select)
        .eq("client_id", data.clientId)
        .lt("scheduled_on", today)
        .order("scheduled_on", { ascending: false })
        .limit(limit),
    ]);
    if (upcoming.error) throw new Error(upcoming.error.message);
    if (past.error) throw new Error(past.error.message);
    const rows = [...(upcoming.data ?? []), ...(past.data ?? [])].sort((a: any, b: any) =>
      a.scheduled_on < b.scheduled_on ? 1 : a.scheduled_on > b.scheduled_on ? -1 : 0,
    );
    return { visits: rows };
  });

/** Recent visit history for the client detail page (newest first). */
export const listRecentClientVisits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: rows, error } = await supabase
      .from("visits")
      .select(
        "id, scheduled_on, status, completed_at, skip_reason_code, properties(street), staff:assigned_staff_id(display_name)",
      )
      .eq("client_id", data.clientId)
      .order("scheduled_on", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    return { visits: rows ?? [] };
  });

/** Every dog across the client's properties, for the detail page. */
export const listDogsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: props, error: pErr } = await supabase
      .from("properties")
      .select("id, street")
      .eq("client_id", data.clientId);
    if (pErr) throw new Error(pErr.message);
    const ids = (props ?? []).map((p: any) => p.id);
    if (!ids.length) return { dogs: [] };
    const { data: dogs, error } = await supabase
      .from("dogs")
      .select("id, property_id, name, breed, weight_class, temperament, notes, active")
      .in("property_id", ids)
      .order("name");
    if (error) throw new Error(error.message);
    const streetById = new Map((props ?? []).map((p: any) => [p.id, p.street]));
    return {
      dogs: (dogs ?? []).map((d: any) => ({
        ...d,
        property_street: streetById.get(d.property_id) ?? "",
      })),
    };
  });

/**
 * Rotate a client's portal token, invalidating the old link and every device
 * session minted from it (finding #4). Use when a client reports their link
 * may have leaked.
 */
export const regeneratePortalLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_settings");
    const { data: newToken, error } = await context.supabase.rpc("regenerate_portal_token" as any, {
      _client_id: data.clientId,
    });
    if (error) throw new Error(error.message);
    try {
      const { data: c } = await context.supabase
        .from("clients")
        .select("organization_id")
        .eq("id", data.clientId)
        .single();
      if (c) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: c.organization_id,
          clientId: data.clientId,
          actorUserId: context.userId,
          kind: "portal.link_regenerated",
          summary: "Regenerated the client portal link (old link invalidated)",
        });
      }
    } catch {}
    return { portalToken: newToken as string };
  });

/**
 * Read the most recent unconsumed verification code for a client, so the
 * office can read it aloud when a client can't receive SMS/email. Returns null
 * if none is active. Gated + never exposed to the portal itself.
 */
export const readPortalVerificationCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    // Confirm the client is in the caller's org before touching it via admin.
    const { data: client } = await context.supabase
      .from("clients")
      .select("id")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!client) throw new Error("Client not found");
    // Stored codes are hashed, so we can't reveal an existing one — mint a
    // fresh single-use code the office reads aloud and the client enters.
    const { issueOfficeReadCode } = await import("@/lib/portal-auth.server");
    return issueOfficeReadCode(data.clientId);
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
      .select(
        "id, name, postal_prefix, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, pricing_mode, price_per_sqft_cents, price_per_acre_cents, area_min_charge_cents, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
      )
      .eq("organization_id", orgId);
    if (zErr) throw new Error(zErr.message);

    const { matchZone } = await import("@/lib/zone-match");
    const z = matchZone((zones ?? []) as any[], {
      postalCode: data.postalCode,
      point:
        data.latitude != null && data.longitude != null
          ? { lat: data.latitude, lng: data.longitude }
          : null,
    });

    if (!z) return { available: false as const };
    const mult = Number((org.frequency_multipliers as any)?.[data.frequency] ?? 1);
    const mode = (z.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre";

    const { computeZoneVisitPrice } = await import("@/lib/pricing");
    const price = computeZoneVisitPrice(
      {
        base_price_cents: z.base_price_cents,
        per_dog_addl_cents: z.per_dog_addl_cents,
        pricing_mode: mode,
        price_per_sqft_cents: Number(z.price_per_sqft_cents ?? 0),
        price_per_acre_cents: z.price_per_acre_cents,
        area_min_charge_cents: z.area_min_charge_cents,
      },
      { dogCount: data.dogCount, boundaryAreaSqm: data.boundaryAreaSqm, multiplier: mult },
    );
    return {
      available: true as const,
      quote: {
        zoneId: z.id as string,
        zoneName: z.name as string,
        pricingMode: mode,
        areaBasisCents: price.areaBasisCents,
        basePriceCents: price.perVisitCents,
        perDogAddlCents: z.per_dog_addl_cents ?? 0,
        recurringPriceCents: price.recurringCents,
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
  visitContactName: z.string().max(120).optional(),
  visitContactPhone: z.string().max(30).optional(),
  visitContactEmail: z.string().email().max(200).optional().or(z.literal("")),
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

    // Zone detection must run on EVERY property creation path, not just the
    // client-detail drawer (QA follow-up 1.1: wizard-created properties had
    // no zone even when a ZIP-covered zone existed).
    const { detectZoneId } = await import("@/lib/properties.functions");
    const autoZoneId = await detectZoneId(supabase, orgId, {
      postalCode: data.postalCode,
      point: latitude != null && longitude != null ? { lat: latitude, lng: longitude } : null,
    });

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
        address_source: "manual",
        auto_zone_id: autoZoneId,
        zone_id: autoZoneId,
        yard_size: data.yardSize ?? null,
        visit_contact_name: data.visitContactName || null,
        visit_contact_phone: data.visitContactPhone || null,
        visit_contact_email: data.visitContactEmail || null,
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

      // An active service must have visits (QA follow-up 1.6): generate the
      // schedule immediately instead of waiting for the nightly job.
      const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
      await generateVisitHorizon(supabase, orgId);
    }

    {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId,
        propertyId,
        actorUserId: userId,
        kind: "client.created",
        summary: `Created client ${data.displayName} with property ${data.street}, ${data.city}`,
      });
    }

    // welcome email (best-effort)
    if (data.primaryEmail) {
      try {
        const { buildPortalLink } = await import("@/lib/portal-links.server");
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: orgId,
          clientId,
          templateName: "welcome",
          notifyKey: "notify_email_welcome",
          idempotencyKey: `welcome-${clientId}`,
          templateData: {
            portalUrl: await buildPortalLink(orgId, cRow.portal_token as string | null),
          },
        });
      } catch (e) {
        console.error("welcome email failed", e);
      }
    }

    return { id: clientId };
  });


/** Header overflow action (QA follow-up 4.2): delete a client only when
 * nothing references them; anything else archives instead. */
export const deleteClientIfNoHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "manage_settings");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, display_name")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    // Every guard query MUST surface its error: a failed count reads as 0
    // and would bypass the history check, cascade-deleting real visit and
    // service history (QA: visits/subscriptions are ON DELETE CASCADE).
    const guards = await Promise.all([
      supabase.from("visits").select("id", { count: "exact", head: true }).eq("client_id", data.clientId),
      supabase.from("invoices").select("id", { count: "exact", head: true }).eq("client_id", data.clientId),
      supabase.from("subscriptions").select("id", { count: "exact", head: true }).eq("client_id", data.clientId),
      supabase.from("properties").select("id", { count: "exact", head: true }).eq("client_id", data.clientId),
    ]);
    for (const g of guards) if (g.error) throw new Error(g.error.message);
    const [{ count: visitCount }, { count: invoiceCount }, { count: subCount }, { count: propCount }] = guards;
    if ((visitCount ?? 0) > 0 || (invoiceCount ?? 0) > 0 || (subCount ?? 0) > 0)
      throw new Error("This client has history. Mark them inactive instead of deleting.");

    if ((propCount ?? 0) > 0) {
      const { data: props, error: listErr } = await supabase
        .from("properties")
        .select("id")
        .eq("client_id", data.clientId);
      if (listErr) throw new Error(listErr.message);
      for (const pr of props ?? []) {
        const dDel = await supabase.from("dogs").delete().eq("property_id", pr.id);
        if (dDel.error) throw new Error(dDel.error.message);
        const wDel = await supabase.from("waste_stations").delete().eq("property_id", pr.id);
        if (wDel.error) throw new Error(wDel.error.message);
      }
      const { error: pDelErr } = await supabase
        .from("properties")
        .delete()
        .eq("client_id", data.clientId);
      if (pDelErr) throw new Error(pDelErr.message);
    }
    const nDel = await supabase.from("client_notes").delete().eq("client_id", data.clientId);
    if (nDel.error) throw new Error(nDel.error.message);
    const { error } = await supabase.from("clients").delete().eq("id", data.clientId);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: client.organization_id,
      actorUserId: userId,
      kind: "client.deleted",
      summary: `Deleted client ${client.display_name} (no history)`,
    });
    return { ok: true };
  });
