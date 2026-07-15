import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

const createSubSchema = z
  .object({
    clientId: z.string().uuid(),
    propertyId: z.string().uuid(),
    accountType: z.enum(["residential", "commercial"]),
    frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
    priceCents: z.number().int().min(0),
    dogCount: z.number().int().min(1).optional(),
    unitCount: z.number().int().min(1).optional(),
    zoneId: z.string().uuid().optional(),
    billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
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
    const { supabase } = context;
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
        started_on: data.startedOn ?? undefined,
        ends_on: data.endsOn ?? null,
        preferred_weekdays:
          data.preferredWeekdays && data.preferredWeekdays.length ? data.preferredWeekdays : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const updateSubSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    propertyId: z.string().uuid(),
    frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
    priceCents: z.number().int().min(0),
    dogCount: z.number().int().min(1).optional(),
    unitCount: z.number().int().min(1).optional(),
    zoneId: z.string().uuid().optional(),
    billingCadence: z.enum(["prepaid", "postpaid"]).optional(),
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
        ...(data.startedOn ? { started_on: data.startedOn } : {}),
        // null clears the end date; the DB trigger trims trailing visits.
        ends_on: data.endsOn ?? null,
        preferred_weekdays:
          data.preferredWeekdays && data.preferredWeekdays.length ? data.preferredWeekdays : null,
      })
      .eq("id", data.subscriptionId);
    if (error) throw new Error(error.message);
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
        "id, account_type, frequency, price_cents, dog_count, unit_count, zone_id, status, started_on, ends_on, property_id, billing_cadence, preferred_weekdays",
      )
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { subscriptions: rows ?? [] };
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
