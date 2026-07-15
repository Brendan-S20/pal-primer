import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Scheduling model (client detail refactor): the five UI choices map to
//   Weekly            -> weekly (interval_weeks null/1)
//   Every N weeks     -> weekly + intervalWeeks (biweekly kept for legacy rows)
//   Calendar monthly  -> monthly (true calendar months, not every 4 weeks)
//   Every X days      -> every_n_days + intervalDays
//   One time          -> one_time
const frequencySchema = z.enum([
  "weekly",
  "biweekly",
  "twice_weekly",
  "monthly",
  "one_time",
  "every_n_days",
]);

const createSubSchema = z
  .object({
    clientId: z.string().uuid(),
    propertyId: z.string().uuid(),
    accountType: z.enum(["residential", "commercial"]),
    frequency: frequencySchema,
    priceCents: z.number().int().min(0),
    dogCount: z.number().int().min(1).optional(),
    unitCount: z.number().int().min(1).optional(),
    zoneId: z.string().uuid().optional(),
    billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
    intervalWeeks: z.number().int().min(1).max(26).optional(),
    intervalDays: z.number().int().min(1).max(90).optional(),
    startedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .refine((v) => !v.endsOn || !v.startedOn || v.endsOn >= v.startedOn, {
    message: "End date can't be before the start date",
  })
  .refine((v) => v.frequency !== "every_n_days" || !!v.intervalDays, {
    message: "Every X days needs the number of days",
  })
  .refine(
    (v) =>
      (v.accountType === "residential" && v.dogCount && !v.unitCount) ||
      (v.accountType === "commercial" && v.unitCount && !v.dogCount),
    { message: "residential requires dogCount; commercial requires unitCount" },
  );

export const createSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createSubSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Creating a service sets pricing, so it needs the same permission the
    // edit/pause/end lifecycle actions require (QA: a dispatcher could
    // create a service they then couldn't touch).
    await requirePermission(supabase, userId, "manage_pricing");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { data: row, error } = await supabase
      .from("subscriptions")
      .insert({
        organization_id: client.organization_id,
        client_id: data.clientId,
        property_id: data.propertyId,
        account_type: data.accountType,
        frequency: data.frequency,
        price_cents: data.priceCents,
        dog_count: data.dogCount ?? null,
        unit_count: data.unitCount ?? null,
        zone_id: data.zoneId ?? null,
        billing_cadence: data.billingCadence ?? "postpaid",
        interval_weeks: data.frequency === "weekly" ? (data.intervalWeeks ?? null) : null,
        interval_days: data.frequency === "every_n_days" ? (data.intervalDays ?? null) : null,
        started_on: data.startedOn ?? undefined,
        ends_on: data.endsOn ?? null,
        preferred_weekdays:
          data.preferredWeekdays && data.preferredWeekdays.length ? data.preferredWeekdays : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Cadence feeds the property's auto-calculated service time.
    const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
    await recomputePropertyEstimate(supabase, data.propertyId);
    return { id: row.id as string };
  });

const updateSubSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    propertyId: z.string().uuid(),
    frequency: frequencySchema,
    priceCents: z.number().int().min(0),
    dogCount: z.number().int().min(1).optional(),
    unitCount: z.number().int().min(1).optional(),
    zoneId: z.string().uuid().optional(),
    billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
    intervalWeeks: z.number().int().min(1).max(26).optional(),
    intervalDays: z.number().int().min(1).max(90).optional(),
    startedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    endsOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .refine((v) => !v.endsOn || !v.startedOn || v.endsOn >= v.startedOn, {
    message: "End date can't be before the start date",
  })
  .refine((v) => v.frequency !== "every_n_days" || !!v.intervalDays, {
    message: "Every X days needs the number of days",
  });

export const updateSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateSubSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Editing pricing/plan details is an office-manage-pricing action.
    await requirePermission(supabase, userId, "manage_pricing");
    const { error } = await supabase
      .from("subscriptions")
      .update({
        property_id: data.propertyId,
        frequency: data.frequency,
        price_cents: data.priceCents,
        dog_count: data.dogCount ?? null,
        unit_count: data.unitCount ?? null,
        zone_id: data.zoneId ?? null,
        billing_cadence: data.billingCadence ?? "postpaid",
        interval_weeks: data.frequency === "weekly" ? (data.intervalWeeks ?? null) : null,
        interval_days: data.frequency === "every_n_days" ? (data.intervalDays ?? null) : null,
        ...(data.startedOn ? { started_on: data.startedOn } : {}),
        // null clears the end date; the DB trigger trims trailing visits.
        ends_on: data.endsOn ?? null,
        preferred_weekdays:
          data.preferredWeekdays && data.preferredWeekdays.length ? data.preferredWeekdays : null,
      })
      .eq("id", data.subscriptionId);
    if (error) throw new Error(error.message);

    const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
    await recomputePropertyEstimate(supabase, data.propertyId);
    return { ok: true };
  });

export const listSubscriptionsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("subscriptions")
      .select(
        "id, account_type, frequency, price_cents, dog_count, unit_count, zone_id, status, started_on, ends_on, property_id, billing_cadence, preferred_weekdays, interval_weeks, interval_days, paused_at, end_reason, end_notes",
      )
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { subscriptions: rows ?? [] };
  });

// ── Service lifecycle (client detail refactor) ────────────────────────────
//
// Started services end, they are never deleted; deletion is reserved for
// services with zero history (no started/completed visits, no invoice
// lines). Pausing removes future scheduled visits; resuming regenerates.

const GENERATION_HORIZON_DAYS = 60;

async function loadSubForLifecycle(supabase: any, userId: string, subscriptionId: string) {
  await requirePermission(supabase, userId, "manage_pricing");
  const { data: sub, error } = await supabase
    .from("subscriptions")
    .select("id, organization_id, client_id, property_id, status, started_on, ends_on, frequency")
    .eq("id", subscriptionId)
    .single();
  if (error) throw new Error(error.message);
  return sub;
}

function localTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const pauseSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ subscriptionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const sub = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    if (sub.status !== "active") throw new Error("Only an active service can be paused");

    const { error } = await supabase
      .from("subscriptions")
      .update({ status: "paused", paused_at: new Date().toISOString() })
      .eq("id", sub.id)
      .eq("status", "active");
    if (error) throw new Error(error.message);

    // Future scheduled visits come off the board; history is untouched.
    const { error: vErr } = await supabase
      .from("visits")
      .delete()
      .eq("subscription_id", sub.id)
      .eq("status", "scheduled")
      .gt("scheduled_on", localTodayISO());
    if (vErr) throw new Error(vErr.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: sub.organization_id,
      clientId: sub.client_id,
      subscriptionId: sub.id,
      actorUserId: userId,
      kind: "service.paused",
      summary: "Paused service (future visits removed)",
    });
    return { ok: true };
  });

export const resumeSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ subscriptionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const sub = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    if (sub.status !== "paused") throw new Error("Only a paused service can be resumed");

    const { error } = await supabase
      .from("subscriptions")
      .update({ status: "active", paused_at: null })
      .eq("id", sub.id)
      .eq("status", "paused");
    if (error) throw new Error(error.message);

    // Refill the schedule out to the normal horizon.
    const through = new Date();
    through.setDate(through.getDate() + GENERATION_HORIZON_DAYS);
    const throughISO = `${through.getFullYear()}-${String(through.getMonth() + 1).padStart(2, "0")}-${String(through.getDate()).padStart(2, "0")}`;
    const { error: gErr } = await supabase.rpc("generate_visits_through", {
      _org_id: sub.organization_id,
      _through: throughISO,
    });
    if (gErr) console.warn("resume regeneration failed:", gErr.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: sub.organization_id,
      clientId: sub.client_id,
      subscriptionId: sub.id,
      actorUserId: userId,
      kind: "service.resumed",
      summary: "Resumed service (schedule regenerated)",
    });
    return { ok: true };
  });

export const endSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        subscriptionId: z.string().uuid(),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().min(1).max(200),
        notes: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const sub = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    if (data.effectiveDate < sub.started_on)
      throw new Error("End date can't be before the service started");

    // ends_on drives everything: generation stops there and the DB trigger
    // trims future scheduled visits past it. Rows are never deleted here.
    const { error } = await supabase
      .from("subscriptions")
      .update({
        ends_on: data.effectiveDate,
        end_reason: data.reason,
        end_notes: data.notes || null,
        ended_by: userId,
        paused_at: null,
        status: "active",
      })
      .eq("id", sub.id);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: sub.organization_id,
      clientId: sub.client_id,
      subscriptionId: sub.id,
      actorUserId: userId,
      kind: "service.ended",
      summary: `Ended service effective ${data.effectiveDate} (${data.reason})`,
      meta: { effective_date: data.effectiveDate, reason: data.reason },
    });
    return { ok: true };
  });

export const deleteDraftSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ subscriptionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const sub = await loadSubForLifecycle(supabase, userId, data.subscriptionId);

    const { count: doneCount, error: vErr } = await supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("subscription_id", sub.id)
      .neq("status", "scheduled");
    if (vErr) throw new Error(vErr.message);
    const { count: lineCount, error: lErr } = await supabase
      .from("invoice_line_items")
      .select("id", { count: "exact", head: true })
      .eq("subscription_id", sub.id);
    if (lErr) throw new Error(lErr.message);
    if ((doneCount ?? 0) > 0 || (lineCount ?? 0) > 0)
      throw new Error("This service has history. End it instead of deleting.");

    const { error: dvErr } = await supabase
      .from("visits")
      .delete()
      .eq("subscription_id", sub.id)
      .eq("status", "scheduled");
    if (dvErr) throw new Error(dvErr.message);
    const { error } = await supabase.from("subscriptions").delete().eq("id", sub.id);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: sub.organization_id,
      clientId: sub.client_id,
      actorUserId: userId,
      kind: "service.deleted",
      summary: "Deleted a service that never started",
    });
    return { ok: true };
  });

// ── Seasonal deep-clean settings ─────────────────────────────────────────

async function loadOrgForCaller(supabase: any, userId: string) {
  return (await requirePermission(supabase, userId, "manage_pricing")).orgId;
}

export const getDeepCleanSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await loadOrgForCaller(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select(
        "seasonal_deepclean_enabled, seasonal_deepclean_months, seasonal_deepclean_charge_cents",
      )
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return {
      enabled: !!data.seasonal_deepclean_enabled,
      months: (data.seasonal_deepclean_months ?? [3, 10]) as number[],
      chargeCents: data.seasonal_deepclean_charge_cents ?? 4900,
    };
  });

export const updateDeepCleanSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        enabled: z.boolean(),
        months: z.array(z.number().int().min(1).max(12)).max(12),
        chargeCents: z.number().int().min(0).max(1_000_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await loadOrgForCaller(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("organizations")
      .update({
        seasonal_deepclean_enabled: data.enabled,
        seasonal_deepclean_months: data.months,
        seasonal_deepclean_charge_cents: data.chargeCents,
      })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
