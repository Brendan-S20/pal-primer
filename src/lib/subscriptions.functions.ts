import { createServerFn } from "@tanstack/react-start";
import { isZonePriced } from "@/lib/services";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { formatWeekdaySet, normalizeWeekdays } from "@/lib/weekday-set";
import { MAX_MULTIPLIER, MIN_MULTIPLIER } from "@/lib/frequency-multipliers";
import { endServiceDecision, seriesRulesPatch } from "@/lib/subscription-form";
import { hasPermission } from "@/lib/permissions";

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

// Arrival window (UX round 4): lives on the service, not the property — a
// property can host several services with different windows.
const windowTimeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .nullable()
  .optional();

// A weekday set (subscriptions.weekdays, migration 20261010010000): the days a
// plan runs on, 0 = Sunday. Rides on frequency weekly with no "every N
// weeks", which the database also requires (subscriptions_weekdays_are_weekly).
// null clears it; omitted on update leaves it alone.
const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((d) => new Set(d).size === d.length, { message: "Each day once" })
  .nullable()
  .optional();

const weekdaysFitFrequency = (v: {
  weekdays?: number[] | null;
  frequency: string;
  intervalWeeks?: number;
}) => !v.weekdays?.length || (v.frequency === "weekly" && (v.intervalWeeks ?? 1) === 1);
const WEEKDAYS_NEED_WEEKLY = "Set days run every week; choose them without an interval";

/** The weekdays column for a write: the normalized set on a weekly plan,
 *  else null. Omitted (undefined) on an update that leaves a plain weekly
 *  plan's set alone. */
function weekdaysFor(v: {
  weekdays?: number[] | null;
  frequency: string;
  intervalWeeks?: number;
}): { weekdays: number[] | null } | Record<string, never> {
  const plainWeekly = v.frequency === "weekly" && (v.intervalWeeks ?? 1) === 1;
  if (v.weekdays === undefined && plainWeekly) return {};
  return { weekdays: plainWeekly && v.weekdays?.length ? normalizeWeekdays(v.weekdays) : null };
}

/** "weekly" or "Mon–Fri", for the activity log. */
function cadenceWords(frequency: string, weekdays?: number[] | null): string {
  return weekdays?.length ? formatWeekdaySet(weekdays, "en-US") : frequency.replace(/_/g, " ");
}

/** A lesson series' rules (R2-49, migration 20261102172500). Omitted on an
 *  update: the plan keeps what it has. null skip = the business default;
 *  null limit = open-ended. */
const seriesRuleFields = {
  skipClosedDays: z.boolean().nullable().optional(),
  sessionLimit: z.number().int().min(1).max(520).nullable().optional(),
};

export const createSubSchema = z
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
    weekdays: weekdaysSchema,
    earliestTime: windowTimeSchema,
    latestTime: windowTimeSchema,
    // What the plan sells (public.services). Omitted on create, the database
    // gives the plan the business's default service; omitted on update, the
    // plan keeps the one it has.
    serviceId: z.string().uuid().optional(),
    ...seriesRuleFields,
  })
  .refine((v) => !v.endsOn || !v.startedOn || v.endsOn >= v.startedOn, {
    message: "End date can't be before the start date",
  })
  .refine((v) => !v.earliestTime || !v.latestTime || v.earliestTime < v.latestTime, {
    message: "The window's earliest time must be before its latest time",
  })
  .refine((v) => v.frequency !== "every_n_days" || !!v.intervalDays, {
    message: "Every X days needs the number of days",
  })
  .refine(weekdaysFitFrequency, { message: WEEKDAYS_NEED_WEEKLY })
  .refine(
    (v) =>
      (v.accountType === "residential" && v.dogCount && !v.unitCount) ||
      (v.accountType === "commercial" && v.unitCount && !v.dogCount),
    { message: "residential requires dogCount; commercial requires unitCount" },
  );

/** A plan may be sold as one of the business's ACTIVE services, or keep the
 *  one it already has after that service was deactivated. Another business's
 *  service reads as "not found" here (RLS) and is refused by the database
 *  too (tg_subscriptions_service). Answers whether the service is priced by
 *  the business's zones (pet waste) or by its own row (phase 5), which
 *  decides what the price's provenance may claim. */
async function assertServiceBookable(
  supabase: any,
  serviceId: string,
  currentId: string | null,
): Promise<{ zonePriced: boolean }> {
  const { data: svc, error } = await supabase
    .from("services")
    .select("id, active, service_line")
    .eq("id", serviceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!svc) throw new Error("That service was not found.");
  if (!svc.active && serviceId !== currentId)
    throw new Error("That service is no longer offered. Choose another.");
  return { zonePriced: isZonePriced(svc) };
}

/** Shared creation path. One INSERT keeps sibling plans together on a failed write. */
export async function createSubscriptionPlans(
  supabase: any,
  userId: string,
  plans: Array<z.infer<typeof createSubSchema>>,
  /** The line every plan must sell: walk times (#410), a stay's plans (#411). */
  onlyLine: "dog_walking" | "pet_sitting" | null = null,
  /** A stay's plans carry the stay (subscriptions.stay_id). */
  stayId: string | null = null,
): Promise<{ ids: string[] }> {
  const data = plans[0];
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
  // A walk is priced from its service, not from any zone: its provenance
  // must not claim the zone's rate card (priced_from_zone_id stays NULL).
  if (onlyLine) {
    const { data: service, error } = await supabase
      .from("services")
      .select("service_line")
      .eq("id", data.serviceId!)
      .single();
    if (error) throw new Error(error.message);
    if (service?.service_line !== onlyLine)
      throw new Error(
        onlyLine === "dog_walking" ? "Choose a dog walking service." : "Choose a pet sitting service.",
      );
  }
  const zonePriced = data.serviceId
    ? (await assertServiceBookable(supabase, data.serviceId, null)).zonePriced
    : true;

  const { data: rows, error } = await supabase
    .from("subscriptions")
    .insert(
      plans.map((data) => ({
        organization_id: client.organization_id,
        client_id: data.clientId,
        property_id: data.propertyId,
        account_type: data.accountType,
        frequency: data.frequency,
        price_cents: data.priceCents,
        dog_count: data.dogCount ?? null,
        unit_count: data.unitCount ?? null,
        zone_id: data.zoneId ?? null,
        // Where this price came from, recorded beside the price itself.
        // `zone_id` is where the service is ROUTED and an admin may move it
        // without meaning to restate what priced it; this is the rate card
        // that was in force when the number was set.
        //
        // No price_overridden_at here even though the form lets a person edit
        // the prefilled figure: the server cannot tell an accepted zone price
        // from a typed one, and guessing would put a false "hand-priced" flag
        // on the majority that just accepted it. A service created off its
        // zone's rate shows up as drift instead, which is what it is.
        priced_from_zone_id: zonePriced ? (data.zoneId ?? null) : null,
        priced_at: new Date().toISOString(),
        billing_cadence: data.billingCadence ?? "postpaid",
        interval_weeks: data.frequency === "weekly" ? (data.intervalWeeks ?? null) : null,
        interval_days: data.frequency === "every_n_days" ? (data.intervalDays ?? null) : null,
        started_on: data.startedOn ?? undefined,
        ends_on: data.endsOn ?? null,
        // A set-days plan has its days; a preferred day beside them would be
        // a second answer to "which day" that the generator does not read.
        preferred_weekdays:
          !data.weekdays?.length && data.preferredWeekdays && data.preferredWeekdays.length
            ? data.preferredWeekdays
            : null,
        ...weekdaysFor(data),
        earliest_time: data.earliestTime ?? null,
        latest_time: data.latestTime ?? null,
        ...(data.serviceId ? { service_id: data.serviceId } : {}),
        ...(stayId ? { stay_id: stayId } : {}),
        ...seriesRulesPatch(data),
        // Who added it, and when (#728).
        created_by: userId,
        last_changed_by: userId,
        last_changed_at: new Date().toISOString(),
      })),
    )
    .select("id");
  if (error) throw new Error(error.message);

  // Cadence feeds the property's auto-calculated service time.
  const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
  await recomputePropertyEstimate(supabase, data.propertyId);

  // An active service must have visits immediately, not after the nightly
  // job (QA follow-up 1.6).
  const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
  await generateVisitHorizon(supabase, client.organization_id);

  const { logActivity } = await import("@/lib/activity.server");
  for (const row of rows ?? [])
    await logActivity(supabase, {
      orgId: client.organization_id,
      clientId: data.clientId,
      propertyId: data.propertyId,
      subscriptionId: row.id as string,
      actorUserId: userId,
      kind: "service.created",
      summary: `Created a ${cadenceWords(data.frequency, data.weekdays)} service at $${(data.priceCents / 100).toFixed(2)} per visit`,
      meta: {
        frequency: data.frequency,
        weekdays: data.weekdays?.length ? normalizeWeekdays(data.weekdays) : null,
        price_cents: data.priceCents,
      },
    });
  return { ids: (rows ?? []).map((row: { id: string }) => row.id) };
}

export const createSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createSubSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Adding a plan is manage_plans (#728). Somebody who also sets prices
    // types any price, as before; anybody else (a dispatcher) adds it at the
    // set price only, which the server works out and checks itself.
    const caller = await requirePermission(context.supabase, context.userId, "manage_plans");
    if (!hasPermission(caller.role, "manage_pricing", caller.overrides))
      return { id: await createPlanAtSetPrice(context.supabase, context.userId, caller.orgId, data) };
    const result = await createSubscriptionPlans(context.supabase, context.userId, [data]);
    return { id: result.ids[0] };
  });

/**
 * What a plan on this client would cost at the business's set price (#728):
 * the number the dispatcher's Add plan form shows, and the only one
 * createSubscription accepts from somebody who does not set prices. Null with
 * a reason when there is none (no zone, no rate, a schedule with no set price).
 */
export const getPlanSetPrice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        propertyId: z.string().uuid(),
        frequency: frequencySchema,
        intervalWeeks: z.number().int().min(1).max(26).optional(),
        serviceId: z.string().uuid().optional(),
        dogCount: z.number().int().min(1).max(50).optional(),
        unitCount: z.number().int().min(1).max(10_000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const caller = await requirePermission(context.supabase, context.userId, "manage_plans");
    const { existingClientPlanSetPrice } = await import("@/lib/plan-set-price.server");
    const set = await existingClientPlanSetPrice(context.supabase, {
      orgId: caller.orgId,
      ...data,
    });
    return { cents: set.cents, zoneId: set.zoneId, reason: set.reason, accountType: set.accountType };
  });

/**
 * A plan on an existing client at the business's set price, for a caller who
 * manages plans but does not set prices (#728, owner decision 2026-11-10:
 * "Yes, dispatchers can manage plans at the set price").
 *
 * The browser sends the price it showed; the server works the set price out
 * again from the business's own zones and services and refuses anything else
 * BEFORE writing: a typed price, a discount, another zone, billing in advance,
 * a start in the past. The subscriptions write policy stays manage_pricing, so
 * the row is written as the service role by insertPlanAtSetPrice, which
 * re-reads the client and property and refuses one outside the caller's
 * business. Exported for tests.
 */
export async function createPlanAtSetPrice(
  supabase: any,
  userId: string,
  orgId: string,
  data: z.infer<typeof createSubSchema>,
): Promise<string> {
  const {
    PLAN_CADENCE_IS_BILLING,
    existingClientPlanSetPrice,
    insertPlanAtSetPrice,
  } = await import("@/lib/plan-set-price.server");
  const { priceOverrideRefusal } = await import("@/lib/booking-price.server");
  if ((data.billingCadence ?? "postpaid") !== "postpaid") throw new Error(PLAN_CADENCE_IS_BILLING);

  const zonePriced = data.serviceId
    ? (await assertServiceBookable(supabase, data.serviceId, null)).zonePriced
    : true;
  const set = await existingClientPlanSetPrice(supabase, {
    orgId,
    clientId: data.clientId,
    propertyId: data.propertyId,
    frequency: data.frequency,
    intervalWeeks: data.intervalWeeks ?? null,
    serviceId: data.serviceId ?? null,
    dogCount: data.dogCount ?? null,
    unitCount: data.unitCount ?? null,
  });
  if (set.cents == null) throw new Error(set.reason);
  if (data.accountType !== set.accountType)
    throw new Error("That is not this client's kind of account. Refresh and try again.");
  if (data.priceCents !== set.cents) throw new Error(priceOverrideRefusal(set.cents));
  // The zone is the quote's, not one the browser names.
  if (data.zoneId && data.zoneId !== set.zoneId) throw new Error(priceOverrideRefusal(set.cents));

  if (data.startedOn) {
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();
    const { orgToday, DEFAULT_ORG_TIMEZONE } = await import("@/lib/org-day");
    if (data.startedOn < orgToday(orgRow?.timezone || DEFAULT_ORG_TIMEZONE))
      throw new Error("The first visit can't be in the past.");
  }

  const now = new Date().toISOString();
  const { data: row, error } = await insertPlanAtSetPrice({
    organization_id: orgId,
    client_id: data.clientId,
    property_id: data.propertyId,
    account_type: set.accountType,
    frequency: data.frequency,
    price_cents: set.cents,
    dog_count: set.accountType === "residential" ? (data.dogCount ?? 1) : null,
    unit_count: set.accountType === "commercial" ? (data.unitCount ?? 1) : null,
    zone_id: set.zoneId,
    priced_from_zone_id: zonePriced ? set.zoneId : null,
    priced_at: now,
    billing_cadence: "postpaid",
    interval_weeks: data.frequency === "weekly" ? (data.intervalWeeks ?? null) : null,
    interval_days: data.frequency === "every_n_days" ? (data.intervalDays ?? null) : null,
    ...(data.startedOn ? { started_on: data.startedOn } : {}),
    ends_on: data.endsOn ?? null,
    preferred_weekdays:
      !data.weekdays?.length && data.preferredWeekdays?.length ? data.preferredWeekdays : null,
    ...weekdaysFor(data),
    earliest_time: data.earliestTime ?? null,
    latest_time: data.latestTime ?? null,
    ...(data.serviceId ? { service_id: data.serviceId } : {}),
    ...seriesRulesPatch(data),
    created_by: userId,
    last_changed_by: userId,
    last_changed_at: now,
  });
  if (error || !row) throw new Error(error?.message ?? "The plan could not be saved.");

  const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
  await recomputePropertyEstimate(supabase, data.propertyId);
  const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
  await generateVisitHorizon(supabase, orgId);

  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(supabase, {
    orgId,
    clientId: data.clientId,
    propertyId: data.propertyId,
    subscriptionId: row.id,
    actorUserId: userId,
    kind: "service.created",
    summary: `Created a ${cadenceWords(data.frequency, data.weekdays)} service at the set price, $${(set.cents / 100).toFixed(2)} per visit`,
    meta: {
      frequency: data.frequency,
      weekdays: data.weekdays?.length ? normalizeWeekdays(data.weekdays) : null,
      price_cents: set.cents,
      at_set_price: true,
    },
  });
  return row.id;
}

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
    weekdays: weekdaysSchema,
    earliestTime: windowTimeSchema,
    latestTime: windowTimeSchema,
    // What the plan sells (public.services). Omitted on create, the database
    // gives the plan the business's default service; omitted on update, the
    // plan keeps the one it has.
    serviceId: z.string().uuid().optional(),
    ...seriesRuleFields,
  })
  .refine((v) => !v.endsOn || !v.startedOn || v.endsOn >= v.startedOn, {
    message: "End date can't be before the start date",
  })
  .refine((v) => v.frequency !== "every_n_days" || !!v.intervalDays, {
    message: "Every X days needs the number of days",
  })
  .refine(weekdaysFitFrequency, { message: WEEKDAYS_NEED_WEEKLY })
  .refine((v) => !v.earliestTime || !v.latestTime || v.earliestTime < v.latestTime, {
    message: "The window's earliest time must be before its latest time",
  });

/** Remove a series' upcoming scheduled visits that break its rules after an
 *  edit: on a closed or holiday date when it skips them, or past its count.
 *  Lessons already taught, missed or skipped are never touched. */
async function trimSeriesVisits(
  supabase: any,
  orgId: string,
  subscriptionId: string,
  rules: { skipClosed: boolean; sessionLimit: number | null; today: string },
) {
  const { seriesVisitsToDrop } = await import("@/lib/subscription-form");
  const none = { data: [], error: null };
  const [visits, blackouts, holidays] = await Promise.all([
    supabase
      .from("visits")
      .select("id, scheduled_on, status, skip_billable")
      .eq("organization_id", orgId)
      .eq("subscription_id", subscriptionId),
    rules.skipClosed
      ? supabase
          .from("blackout_dates")
          .select("blackout_on")
          .eq("organization_id", orgId)
          .gte("blackout_on", rules.today)
      : none,
    rules.skipClosed
      ? supabase
          .from("holiday_dates")
          .select("holiday_on")
          .eq("organization_id", orgId)
          .gte("holiday_on", rules.today)
      : none,
  ]);
  for (const r of [visits, blackouts, holidays]) if (r.error) throw new Error(r.error.message);
  const closedDays = new Set<string>([
    ...((blackouts.data ?? []) as { blackout_on: string }[]).map((b) => b.blackout_on),
    ...((holidays.data ?? []) as { holiday_on: string }[]).map((h) => h.holiday_on),
  ]);
  const drop = seriesVisitsToDrop(visits.data ?? [], { ...rules, closedDays });
  if (!drop.length) return;
  const { error } = await supabase
    .from("visits")
    .delete()
    .in("id", drop)
    .eq("organization_id", orgId)
    .eq("status", "scheduled");
  if (error) throw new Error(error.message);
}

/** dog_count / unit_count for an update, shaped by the plan's account type.
 *  Exported for tests. */
export function countsFor(
  before: { account_type?: string | null; dog_count?: number | null; unit_count?: number | null } | null,
  data: { dogCount?: number; unitCount?: number },
): { dog_count: number | null; unit_count: number | null } {
  if (before?.account_type === "commercial")
    return { dog_count: null, unit_count: data.unitCount ?? before.unit_count ?? 1 };
  if (before?.account_type === "residential")
    return { dog_count: data.dogCount ?? before.dog_count ?? 1, unit_count: null };
  return { dog_count: data.dogCount ?? null, unit_count: data.unitCount ?? null };
}

export const updateSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateSubSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Editing a plan's price or terms is a pricing action. A dispatcher, who
    // manages plans at the set price (#728), is told so in words.
    const editor = await requirePermission(supabase, userId, "manage_plans");
    if (!hasPermission(editor.role, "manage_pricing", editor.overrides)) {
      const { PLAN_EDIT_IS_PRICING } = await import("@/lib/plan-set-price.server");
      throw new Error(PLAN_EDIT_IS_PRICING);
    }
    // Before-image for the activity log (spec Stage 5: price changes show
    // before -> after).
    const { data: before } = await supabase
      .from("subscriptions")
      .select(
        "organization_id, client_id, client_package_id, stay_id, account_type, dog_count, unit_count, price_cents, frequency, weekdays, started_on, ends_on, status, service_id, earliest_time, latest_time",
      )
      .eq("id", data.subscriptionId)
      .single();
    const zonePriced = data.serviceId
      ? (await assertServiceBookable(supabase, data.serviceId, before?.service_id ?? null)).zonePriced
      : true;
    // Keep status consistent with the end date (UX round 4): setting a past
    // end date cancels; clearing it (or moving it to the future) on a
    // canceled service revives it — otherwise ending a service was a one-way
    // door the Edit drawer silently couldn't undo.
    // Computed BEFORE the update, because the row is about to stop being the
    // before-image. The activity log recomputes the same thing further down
    // for its summary; this one has to reach the patch.
    const priceWasTypedOver = !!before && before.price_cents !== data.priceCents;
    const weekdaysPatch = weekdaysFor(data);

    const today = new Date().toISOString().slice(0, 10);
    const endsInPast = !!data.endsOn && data.endsOn <= today;
    const statusPatch = endsInPast
      ? { status: "canceled" as const, paused_at: null }
      : before?.status === "canceled"
        ? { status: "active" as const, end_reason: null, end_notes: null, ended_by: null }
        : {};
    const { error } = await supabase
      .from("subscriptions")
      .update({
        ...statusPatch,
        property_id: data.propertyId,
        frequency: data.frequency,
        price_cents: data.priceCents,
        // The count the plan's shape carries (subscriptions_account_shape_chk:
        // dogs for residential, units for commercial, never both). A caller
        // that omits it keeps the one on file rather than writing NULL, which
        // the database refuses with the raw constraint name (#658, R2-20).
        ...countsFor(before, data),
        zone_id: data.zoneId ?? null,
        // A person typed a different number. Stamped only on a real change, so
        // re-saving the drawer without touching the price does not manufacture
        // an override, and left alone otherwise so an earlier one survives.
        ...(priceWasTypedOver
          ? { price_overridden_at: new Date().toISOString(), priced_at: new Date().toISOString() }
          : {}),
        billing_cadence: data.billingCadence ?? "postpaid",
        interval_weeks: data.frequency === "weekly" ? (data.intervalWeeks ?? null) : null,
        interval_days: data.frequency === "every_n_days" ? (data.intervalDays ?? null) : null,
        ...(data.startedOn ? { started_on: data.startedOn } : {}),
        // null clears the end date; the DB trigger trims trailing visits.
        ends_on: data.endsOn ?? null,
        preferred_weekdays:
          !data.weekdays?.length && data.preferredWeekdays && data.preferredWeekdays.length
            ? data.preferredWeekdays
            : null,
        // Changing the days takes upcoming visits off the days that went
        // (subscriptions_weekdays_reshape); the horizon run below adds the new.
        ...weekdaysPatch,
        // undefined = leave the window alone; null = clear it.
        ...(data.earliestTime !== undefined ? { earliest_time: data.earliestTime } : {}),
        ...(data.latestTime !== undefined ? { latest_time: data.latestTime } : {}),
        // The plan's upcoming scheduled visits follow a change of service in
        // the database (subscriptions_service_reaches_upcoming_visits); the
        // ones that happened keep the service they were done as.
        ...(data.serviceId ? { service_id: data.serviceId } : {}),
        // A plan priced from its service cannot have come from a zone's rate.
        ...(zonePriced ? {} : { priced_from_zone_id: null }),
        ...seriesRulesPatch(data),
        last_changed_by: userId,
        last_changed_at: new Date().toISOString(),
      })
      .eq("id", data.subscriptionId)
      .select("organization_id");
    if (error) throw new Error(error.message);

    // A series that now skips closed days, or stops sooner, loses the
    // upcoming visits that break the rule; the horizon run below can only add
    // dates the rule allows (visits_follow_series_rules).
    // Not a one-time plan, a package's or a stay's: the office chose those dates.
    if (
      before?.organization_id &&
      data.frequency !== "one_time" &&
      !before.client_package_id &&
      !before.stay_id &&
      (data.skipClosedDays === true || data.sessionLimit != null)
    )
      await trimSeriesVisits(supabase, before.organization_id, data.subscriptionId, {
        skipClosed: data.skipClosedDays === true,
        sessionLimit: data.sessionLimit ?? null,
        today,
      });

    const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
    await recomputePropertyEstimate(supabase, data.propertyId);

    // Schedule inputs may have changed; top the horizon back up.
    const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
    if (before?.organization_id) await generateVisitHorizon(supabase, before.organization_id);

    // A walk plan whose days or window changed: the client hears it (#410).
    if (before) {
      const { notifyWalkPlanChanged } = await import("@/lib/walk-notify.server");
      await notifyWalkPlanChanged({
        subscriptionId: data.subscriptionId,
        before: {
          weekdays: before.weekdays ?? null,
          earliest_time: before.earliest_time ?? null,
          latest_time: before.latest_time ?? null,
        },
      });
    }

    if (before) {
      const { logActivity } = await import("@/lib/activity.server");
      const priceChanged = priceWasTypedOver;
      await logActivity(supabase, {
        orgId: before.organization_id,
        clientId: before.client_id,
        subscriptionId: data.subscriptionId,
        actorUserId: userId,
        kind: priceChanged ? "service.price_changed" : "service.updated",
        summary: priceChanged
          ? `Changed service price from $${(before.price_cents / 100).toFixed(2)} to $${(data.priceCents / 100).toFixed(2)} per visit`
          : "Updated service configuration",
        meta: {
          before: {
            price_cents: before.price_cents,
            frequency: before.frequency,
            weekdays: before.weekdays ?? null,
            ends_on: before.ends_on,
            status: before.status,
            service_id: before.service_id ?? null,
          },
          after: {
            price_cents: data.priceCents,
            frequency: data.frequency,
            weekdays: "weekdays" in weekdaysPatch ? weekdaysPatch.weekdays : (before.weekdays ?? null),
            service_id: data.serviceId ?? before.service_id ?? null,
            ends_on: data.endsOn ?? null,
            status: (statusPatch as any).status ?? before.status,
          },
        },
      });
    }
    return { ok: true };
  });

// One-click apply for a portal frequency-change request surfaced on the
// Concerns page (C4/G4). Narrow on purpose: only the frequency moves, with the
// same effects as the portal auto-apply RPC — including clearing future
// uninvoiced scheduled visits so the new cadence actually materializes — plus
// estimate recompute, horizon top-up, and an activity log with before/after.
// Resolving the source concern happens HERE, in the same call, so a lost
// follow-up request can't leave a stale open ticket blocking the client's
// next request (the RPC's duplicate guard keys on unresolved tickets).
export const applyFrequencyChangeRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        subscriptionId: z.string().uuid(),
        frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]),
        ticketId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");

    const { data: before, error: loadErr } = await supabase
      .from("subscriptions")
      .select("organization_id, client_id, property_id, frequency, status, price_cents")
      .eq("id", data.subscriptionId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (loadErr) throw new Error(loadErr.message);
    if (!before) throw new Error("Subscription not found");

    const changed = before.frequency !== data.frequency;
    if (changed) {
      // ── REPRICE, BECAUSE price_cents IS STORED POST-MULTIPLIER ──────────
      //
      // computeZoneVisitPrice returns `perVisitCents * multiplier` and THAT is
      // what lands in subscriptions.price_cents (clients.functions.ts, at
      // create). So changing frequency without repricing leaves the OLD
      // frequency's multiplier baked into every future invoice.
      //
      // A monthly client at $96/visit is $30 of zone price times the 3.2
      // monthly multiplier. Approve their request to move to weekly and they
      // stayed at $96 A VISIT -- $384/month instead of $120 -- raised by
      // run_billing_cycles and taken off the saved card by autopay, from a
      // confirm dialog whose copy only mentions rescheduling.
      //
      // The ratio is exact and needs no zone lookup: price is linear in the
      // multiplier, so dividing out the old one and applying the new one
      // reproduces exactly what create-time pricing would have computed. It
      // also survives a per-visit price a human has since edited by hand,
      // which a full recompute from the zone would silently discard.
      const { data: org } = await supabase
        .from("organizations")
        .select("frequency_multipliers")
        .eq("id", orgId)
        .maybeSingle();
      const mults = (org?.frequency_multipliers ?? {}) as Record<string, number>;
      // Per-visit factors: twice weekly's stored 1.8 is a week's total (#572).
      const { perVisitMultiplier } = await import("@/lib/frequency-multipliers");
      const oldMult = perVisitMultiplier(mults, before.frequency as string);
      const newMult = perVisitMultiplier(mults, data.frequency);
      const oldPrice = Number(before.price_cents ?? 0);
      const repriced =
        oldPrice > 0 && oldMult > 0 ? Math.round((oldPrice / oldMult) * newMult) : oldPrice;

      const { error } = await supabase
        .from("subscriptions")
        .update({
          frequency: data.frequency,
          price_cents: repriced,
          // Same reconciliation as updateSubscription: interval fields only
          // apply to their own frequency modes.
          interval_weeks: null,
          interval_days: null,
          // A set-days plan moved to another cadence stops being one
          // (subscriptions_weekdays_are_weekly would refuse it otherwise).
          weekdays: null,
        })
        .eq("id", data.subscriptionId);
      if (error) throw new Error(error.message);

      // Mirror the RPC's apply branch: clear future uninvoiced scheduled
      // visits at the old cadence, then regenerate. The horizon generator only
      // ADDS visits, so without this the old weekly schedule would survive a
      // weekly -> monthly change.
      const { data: future } = await supabase
        .from("visits")
        .select("id, invoice_line_items(id)")
        .eq("subscription_id", data.subscriptionId)
        .eq("status", "scheduled")
        .gt("scheduled_on", new Date().toISOString().slice(0, 10));
      const removable = (future ?? [])
        .filter((v: any) => !(v.invoice_line_items ?? []).length)
        .map((v: any) => v.id);
      if (removable.length) {
        const { error: delErr } = await supabase.from("visits").delete().in("id", removable);
        if (delErr) throw new Error(delErr.message);
      }

      const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
      if (before.property_id) await recomputePropertyEstimate(supabase, before.property_id);
      const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
      await generateVisitHorizon(supabase, before.organization_id);

      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId: before.organization_id,
        clientId: before.client_id,
        subscriptionId: data.subscriptionId,
        actorUserId: userId,
        kind: "service.updated",
        summary: `Applied client-requested frequency change: ${before.frequency} → ${data.frequency}`,
        meta: {
          source: "portal_frequency_request",
          before: { frequency: before.frequency },
          after: { frequency: data.frequency },
        },
      });
    }

    if (data.ticketId) {
      const { error: tErr } = await supabase
        .from("qc_tickets")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolved_by: userId,
          resolution_note: changed
            ? `Frequency change applied: ${before.frequency} → ${data.frequency}`
            : `Frequency change request closed, service already ${data.frequency}`,
        })
        .eq("id", data.ticketId)
        .eq("organization_id", orgId);
      if (tErr) throw new Error(tErr.message);
    }

    return { ok: true, changed, fromFrequency: before.frequency };
  });

export const listSubscriptionsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("subscriptions")
      .select(
        "id, account_type, frequency, price_cents, priced_at, priced_from_zone_id, price_overridden_at, dog_count, unit_count, zone_id, status, started_on, ends_on, property_id, billing_cadence, preferred_weekdays, weekdays, interval_weeks, interval_days, paused_at, end_reason, end_notes, earliest_time, latest_time, client_package_id, skip_closed_days, session_limit, service_id, services(name, service_line), stay_id, groom_addons",
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

// Pause, resume and end are manage_plans (#728): a dispatcher runs them too.
// Somebody who sets prices writes with their own key, as before; anybody else
// is written for by the server as the service role, through
// updatePlanLifecycleAsServer, which only takes the lifecycle columns and is
// filtered on the caller's business. Every change stamps who and when.
type PlanLifecycle = {
  sub: {
    id: string;
    organization_id: string;
    client_id: string;
    property_id: string;
    status: string;
    started_on: string | null;
    ends_on: string | null;
    frequency: string;
  };
  orgId: string;
  /** The caller cannot write plans with their own key (no manage_pricing). */
  asServer: boolean;
};

async function loadSubForLifecycle(
  supabase: any,
  userId: string,
  subscriptionId: string,
): Promise<PlanLifecycle> {
  const caller = await requirePermission(supabase, userId, "manage_plans");
  const { data: sub, error } = await supabase
    .from("subscriptions")
    .select("id, organization_id, client_id, property_id, status, started_on, ends_on, frequency")
    .eq("id", subscriptionId)
    .eq("organization_id", caller.orgId)
    .single();
  // Another business's plan reads as no row (RLS, and the filter above).
  if (error || !sub) throw new Error(error?.message ?? "That plan was not found.");
  return { sub, orgId: caller.orgId, asServer: !hasPermission(caller.role, "manage_pricing", caller.overrides) };
}

async function writePlanLifecycle(
  supabase: any,
  userId: string,
  plan: PlanLifecycle,
  patch: Record<string, unknown>,
  onlyIfStatus?: string,
) {
  const stamped = { ...patch, last_changed_by: userId, last_changed_at: new Date().toISOString() };
  if (plan.asServer) {
    const { updatePlanLifecycleAsServer } = await import("@/lib/plan-set-price.server");
    const { error } = await updatePlanLifecycleAsServer(
      plan.orgId,
      plan.sub.id,
      stamped,
      onlyIfStatus,
    );
    if (error) throw new Error(error.message);
    return;
  }
  let q = supabase.from("subscriptions").update(stamped).eq("id", plan.sub.id);
  if (onlyIfStatus) q = q.eq("status", onlyIfStatus);
  const { error } = await q;
  if (error) throw new Error(error.message);
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
    const plan = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    const { sub } = plan;
    if (sub.status !== "active") throw new Error("Only an active service can be paused");

    await writePlanLifecycle(
      supabase,
      userId,
      plan,
      { status: "paused", paused_at: new Date().toISOString() },
      "active",
    );

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
    const plan = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    const { sub } = plan;
    if (sub.status !== "paused") throw new Error("Only a paused service can be resumed");

    await writePlanLifecycle(supabase, userId, plan, { status: "active", paused_at: null }, "paused");

    // Refill the schedule out to the normal horizon.
    const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
    await generateVisitHorizon(supabase, sub.organization_id);

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
    const plan = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    const { sub } = plan;

    // ends_on drives generation (it stops there) and the DB trigger trims
    // future scheduled visits past it. Rows are never deleted here. Status
    // flips to canceled once the end date is reached; a future-dated end
    // stays active until then (visits through the end date still happen)
    // and the isServiceEnded helper handles the flip in the UI. A service
    // that has not started may end before its start (#676): it never runs.
    const today = new Date().toISOString().slice(0, 10);
    const decision = endServiceDecision({
      startedOn: sub.started_on,
      effectiveDate: data.effectiveDate,
      today,
    });
    if (!decision.ok) throw new Error(decision.error);
    await writePlanLifecycle(supabase, userId, plan, {
      ends_on: data.effectiveDate,
      end_reason: data.reason,
      end_notes: data.notes || null,
      ended_by: userId,
      paused_at: null,
      status: decision.status,
    });

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
    const plan = await loadSubForLifecycle(supabase, userId, data.subscriptionId);
    // Deleting is not on a dispatcher's list (add, pause, resume, end).
    if (plan.asServer) {
      const { PLAN_DELETE_IS_PRICING } = await import("@/lib/plan-set-price.server");
      throw new Error(PLAN_DELETE_IS_PRICING);
    }
    const { sub } = plan;

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
      throw new Error(
        "This service has history, so it can't be deleted. Use End service… on the service instead.",
      );

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

// ── Standard pricing (client detail refactor) ─────────────────────────────
//
// The org-wide "Standard Price" that zone pricing is compared against in
// the precedence display (Standard -> Zone -> Custom -> Promotion -> Final).
// Null means the org hasn't set one and the comparison row is hidden.

export const getStandardPricing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { resolveCaller } = await import("@/lib/authz.server");
    const { orgId } = await resolveCaller(supabase, userId);
    const { data, error } = await supabase
      .from("organizations")
      .select("std_base_price_cents, std_per_dog_addl_cents, frequency_multipliers")
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return {
      basePriceCents: data.std_base_price_cents ?? null,
      perDogAddlCents: data.std_per_dog_addl_cents ?? null,
      frequencyMultipliers: (data.frequency_multipliers ?? {}) as Record<string, number>,
    };
  });

export const updateStandardPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        basePriceCents: z.number().int().min(0).max(1_000_000).nullable(),
        perDogAddlCents: z.number().int().min(0).max(1_000_000).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await loadOrgForCaller(context.supabase, context.userId);
    // The org UPDATE policy is owner-only, but manage_pricing includes
    // office managers; this SECURITY DEFINER RPC re-checks the caller's
    // role in the database and can only touch the two pricing columns.
    const { error } = await context.supabase.rpc("update_org_standard_pricing", {
      _org_id: orgId,
      _std_base_price_cents: data.basePriceCents as never,
      _std_per_dog_addl_cents: data.perDogAddlCents as never,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── Frequency multipliers (#572, F-07) ────────────────────────────────────
//
// What each cadence costs against a weekly visit, per CYCLE (twice weekly's
// is a week of two visits). Read by every quote and by public_quote, so it is
// the owner's to see and change rather than a number only the database knew.
// Same permission and write path as first-cleanup pricing: this is a price
// list. All four keys are written together; they are the four any code reads.

export const updateFrequencyMultipliers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => {
    const m = z.number().min(MIN_MULTIPLIER).max(MAX_MULTIPLIER);
    return z.object({ weekly: m, twice_weekly: m, biweekly: m, monthly: m }).strict().parse(d);
  })
  .handler(async ({ data, context }) => {
    const orgId = await loadOrgForCaller(context.supabase, context.userId);
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    const stored = {
      weekly: roundMultiplier(data.weekly),
      biweekly: roundMultiplier(data.biweekly),
      twice_weekly: roundMultiplier(data.twice_weekly),
      monthly: roundMultiplier(data.monthly),
    };
    await updateOwnOrg(context.supabase, orgId, { frequency_multipliers: stored });
    return { ok: true as const, frequencyMultipliers: stored };
  });

function roundMultiplier(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
    // Same owner-only org UPDATE policy gap: office managers hold
    // manage_pricing, so route through the role-checked RPC.
    const { error } = await context.supabase.rpc("update_org_deepclean_settings", {
      _org_id: orgId,
      _enabled: data.enabled,
      _months: data.months,
      _charge_cents: data.chargeCents,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
