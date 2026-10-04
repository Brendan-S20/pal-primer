import { createServerFn } from "@tanstack/react-start";
import type { RoadLegProblem } from "@/lib/road-legs.server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { measureDayFit } from "@/lib/route-day-fit";

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

export const generateVisits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ through: z.string() /* YYYY-MM-DD */ }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: count, error } = await supabase.rpc("generate_visits_through", {
      _org_id: orgId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { inserted: (count as number) ?? 0 };
  });

export const listVisitsForDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  // throughDay (optional, inclusive) widens the window so the Routes map can
  // show a week/month of visits — omitted, it's the classic single-day query.
  .inputValidator((d) => z.object({ day: z.string(), throughDay: z.string().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    let q = supabase
      .from("visits")
      .select(
        "id, scheduled_on, status, sequence, assigned_staff_id, zone_id, property_id, client_id, subscription_id, eta_start, eta_end, travel_km, travel_min, window_violated, weather_flagged, weather_note, clients(display_name), properties(street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time, service_duration_min), zones(name, postal_prefix), staff(display_name), subscriptions(price_cents, account_type, frequency, preferred_time_of_day, earliest_time, latest_time)",
      )
      .eq("organization_id", orgId);
    q =
      data.throughDay && data.throughDay > data.day
        ? q.gte("scheduled_on", data.day).lte("scheduled_on", data.throughDay)
        : q.eq("scheduled_on", data.day);
    const { data: rows, error } = await q
      .order("scheduled_on", { ascending: true })
      .order("assigned_staff_id", { ascending: true, nullsFirst: true })
      .order("sequence", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return { visits: rows ?? [] };
  });

export const getVisitDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: v, error } = await supabase
      .from("visits")
      .select(
        `id, scheduled_on, status, sequence, assigned_staff_id,
         started_at, completed_at, skip_reason, skip_reason_code,
         weather_flagged, weather_note, tech_note, completion_photo_waived_reason, visit_checklist,
         eta_start, eta_end, travel_km, travel_min, window_violated,
         client_id, property_id,
         clients(id, display_name, primary_phone, primary_email, credit_balance_cents),
         properties(id, street, city, region, postal_code, gate_code, lock_box_code, key_location, parking_notes, access_notes, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, earliest_service_time, latest_service_time, service_duration_min, latitude, longitude),
         zones(name),
         staff(id, display_name),
         subscriptions(price_cents, frequency, preferred_time_of_day, earliest_time, latest_time),
         visit_photos(id, storage_path, kind, created_at)`,
      )
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);

    // dogs at this property
    const { data: dogs } = await supabase
      .from("dogs")
      .select("id, name, breed, weight_class, temperament, notes")
      .eq("property_id", (v as any).property_id)
      .order("name");

    // The client's other visits, split at the ORGANIZATION's today. This was
    // one query — the latest five by date — rendered as the visit's history.
    // Visits are generated weeks ahead, so for a weekly client the latest five
    // are all in the future: the drawer listed next month under the past and
    // never showed the last time anybody was actually there. Two queries, so
    // the future cannot crowd the past out of a shared limit, and the org's
    // clock rather than the server's, for the reason org-day.ts gives.
    const { data: org } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();
    const today = orgToday(org?.timezone || DEFAULT_ORG_TIMEZONE);
    const others = () =>
      supabase
        .from("visits")
        .select("id, scheduled_on, status")
        .eq("client_id", (v as any).client_id)
        .neq("id", data.visitId);
    const [{ data: recent }, { data: upcoming }] = await Promise.all([
      others().lt("scheduled_on", today).order("scheduled_on", { ascending: false }).limit(5),
      others().gte("scheduled_on", today).order("scheduled_on", { ascending: true }).limit(3),
    ]);

    return { visit: v, dogs: dogs ?? [], recent: recent ?? [], upcoming: upcoming ?? [] };
  });

export const listStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await (supabase.from("staff") as any)
      .select(
        "id, display_name, role, active, is_field_tech, routing_available, start_latitude, start_longitude, start_address, end_latitude, end_longitude, end_address",
      )
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("display_name");
    if (error) throw new Error(error.message);
    return { staff: data ?? [] };
  });

/**
 * Book a single visit that is not part of a recurring plan — an emergency
 * call-out, a make-up after a skip, a one-time deep clean.
 *
 * ── WHY THIS CREATES A SUBSCRIPTION AND NOT JUST A VISIT ───────────────────
 *
 * Because `visits.subscription_id` is NOT NULL, and that is not an oversight.
 * BOTH invoicing paths select visits the same way —
 *
 *     FROM public.visits v
 *     JOIN public.subscriptions s ON s.id = v.subscription_id
 *
 * — an inner join with no frequency filter, in `generate_invoices_for_org` and
 * in `run_billing_cycles` alike, and the amount comes from `s.price_cents`. A
 * visit with no subscription would not merely be unpriced; it would not appear
 * in the query at all. Making the column nullable would have been a way to do
 * unbillable work and never find out.
 *
 * So the product already models "one visit" as a `one_time` service, and every
 * piece of that was already built: the `one_time` value in `service_frequency`,
 * a complete branch in `generate_visits_core` that honours blackout dates, work
 * days and client holds, and the "One time — a single visit on the chosen date"
 * option in the service drawer. Verified live against the real database: a
 * `one_time` service created for today generates exactly one visit, dated
 * today, and it bills at the subscription price like any other.
 *
 * What did NOT exist was a way to get there quickly, or at all on the day it
 * matters — see the comment on the generate call in one-off-visit.server.ts,
 * where the work now lives. This is that path, and
 * it is deliberately a thin wrapper over the existing machinery rather than a
 * second way to make a visit, because two ways to create the same row is how
 * the two diverge.
 */
export const createOneOffVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        propertyId: z.string().uuid(),
        /** The day the visit should happen. */
        scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        priceCents: z.number().int().min(0).max(10_000_00),
        /** Optional: put it straight on a tech's route. */
        staffId: z.string().uuid().nullable().optional(),
        /** Why it was booked. Shows on the client's activity timeline. */
        note: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    // Booking a one-off sets a price, so it is the same permission creating any
    // other service needs. A dispatcher does not hold it — consistent with Q-1
    // ("dispatchers ops-only, no billing"), and the UI hides the entry point
    // rather than letting them fill a form that throws on submit.
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");

    // The work itself lives in one-off-visit.server.ts, because it has a
    // second caller: a customer's extra-cleanup request that the owner set to
    // auto-accept is booked by the portal, as the service role, through the
    // same code. Two ways to make the same row is how the two diverge; one
    // function with two callers is not.
    const { bookOneOffVisit } = await import("@/lib/one-off-visit.server");
    const booked = await bookOneOffVisit(supabase, { ...data, orgId, actorUserId: userId });
    if (data.staffId) {
      const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshRouteLiveActivities([{ staffId: data.staffId, day: data.scheduledOn }]);
    }
    return booked;
  });

export const reassignVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ visitId: z.string().uuid(), staffId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Both techs' lock screens: the one losing the stop and the one gaining it.
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await context.supabase.rpc("reassign_visit", {
      _visit_id: data.visitId,
      _staff_id: data.staffId as string,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    // QA round 8: reassignment shows on the client's Activity timeline.
    try {
      const [{ data: v }, { data: staff }] = await Promise.all([
        context.supabase
          .from("visits")
          .select("organization_id, client_id, property_id, scheduled_on")
          .eq("id", data.visitId)
          .single(),
        data.staffId
          ? context.supabase
              .from("staff")
              .select("display_name")
              .eq("id", data.staffId)
              .maybeSingle()
          : Promise.resolve({ data: null } as any),
      ]);
      if (v) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: context.userId,
          kind: "visit.reassigned",
          summary: data.staffId
            ? `Reassigned the visit on ${v.scheduled_on} to ${staff?.display_name ?? "another tech"}`
            : `Unassigned the visit on ${v.scheduled_on}`,
        });
      }
    } catch {}
    return { ok: true };
  });

export const reorderRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        day: z.string(),
        orderedIds: z.array(z.string().uuid()),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: count, error } = await context.supabase.rpc("reorder_route", {
      _staff_id: data.staffId,
      _day: data.day,
      _ordered_ids: data.orderedIds,
    });
    if (error) throw new Error(error.message);
    const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    await refreshRouteLiveActivities([{ staffId: data.staffId, day: data.day }]);
    return { updated: (count as number) ?? 0 };
  });

export const getDispatchSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select(
        // measured_* are written by refresh_road_profile from this workspace's
        // own cached road legs and never by a person. They are read here so the
        // settings screen can say where drive times come from. avg_speed_kmh is
        // no longer read: nothing uses a typed speed since 20261002090500.
        "workday_start, workday_end, traffic_profile, max_drive_minutes, timezone, work_days, auto_generate_days_ahead, notify_schedule_horizon, area_type, measured_speed_kmh, measured_road_factor, measured_legs, measured_at, route_windows",
      )
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { settings: data };
  });

export const updateDispatchSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        workday_start: z.string().optional(),
        workday_end: z.string().optional(),
        // No avg_speed_kmh: the owner, 2026-10-02, "it shouldn't be based on
        // that". Drive times come from the road (20261002090500).
        traffic_profile: z.enum(["light", "normal", "heavy"]).optional(),
        max_drive_minutes: z.number().int().min(15).max(1440).optional(),
        // Days the business operates (0=Sun..6=Sat). Visit generation shifts
        // dates off non-working days unless a subscription carries explicit
        // preferred weekdays.
        work_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
        // How far ahead the nightly job keeps the schedule filled. Same bounds as
        // the column CHECK and the RPC — three places, one range, because a
        // number that passes here and fails in the database is a 500 where a
        // sentence belonged.
        auto_generate_days_ahead: z.number().int().min(1).max(365).optional(),
        notify_schedule_horizon: z.boolean().optional(),
        // Anchors route windows/ETAs at the org's local workday start (B6).
        timezone: z
          .string()
          .refine((tz) => {
            try {
              new Intl.DateTimeFormat("en-US", { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, "Enter a valid timezone")
          .optional(),
        // How auto-routing treats arrival windows (20261002090400).
        route_windows: z.enum(["honour", "ignore"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Dispatch settings are org settings — gate like the rest of Settings.
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { route_windows, ...rest } = data;
    // Write via the SECURITY DEFINER RPC (org-dispatch-settings-rpc migration):
    // the only UPDATE RLS policy on organizations is owner-only, so a direct
    // update from an office manager was a silent 0-row no-op. The RPC enforces
    // the role check in the database and errors instead of no-oping.
    if (Object.values(rest).some((v) => v !== undefined)) {
      const { error } = await (context.supabase as any).rpc("update_org_dispatch_settings", {
        _org_id: orgId,
        _workday_start: rest.workday_start ?? null,
        _workday_end: rest.workday_end ?? null,
        _traffic_profile: rest.traffic_profile ?? null,
        _max_drive_minutes: rest.max_drive_minutes ?? null,
        _timezone: rest.timezone ?? null,
        _work_days: rest.work_days ?? null,
        _auto_generate_days_ahead: rest.auto_generate_days_ahead ?? null,
        _notify_schedule_horizon: rest.notify_schedule_horizon ?? null,
      });
      if (error) throw new Error(error.message);
    }
    // Its own RPC, with the same role check: see the migration for why it is
    // not a new argument on the one above.
    if (route_windows) {
      const { error } = await context.supabase.rpc("set_route_windows", {
        _org_id: orgId,
        _policy: route_windows,
      });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

/** Permission-gated timestamp correction from the visit detail drawer (QA
 * follow-up 2.3): requires a reason and lands on the Activity timeline with
 * before/after values. */
export const correctVisitTimestamps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        startedAt: z.string().datetime({ offset: true }).nullable(),
        completedAt: z.string().datetime({ offset: true }).nullable(),
        reason: z.string().min(1).max(300),
      })
      .refine((v) => !v.startedAt || !v.completedAt || v.completedAt >= v.startedAt, {
        message: "Completion can't be before the start",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    await requirePermission(supabase, userId, "manage_client_billing");

    const { data: before, error: bErr } = await supabase
      .from("visits")
      .select("id, organization_id, client_id, property_id, scheduled_on, started_at, completed_at")
      .eq("id", data.visitId)
      .single();
    if (bErr) throw new Error(bErr.message);

    const { error } = await supabase
      .from("visits")
      .update({ started_at: data.startedAt, completed_at: data.completedAt })
      .eq("id", data.visitId);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: before.organization_id,
      clientId: before.client_id,
      propertyId: before.property_id,
      actorUserId: userId,
      kind: "visit.corrected",
      summary: `Corrected visit timestamps for ${before.scheduled_on}: ${data.reason}`,
      meta: {
        reason: data.reason,
        before: { started_at: before.started_at, completed_at: before.completed_at },
        after: { started_at: data.startedAt, completed_at: data.completedAt },
      },
    });
    return { ok: true };
  });

// ── Office visit actions (QA round 8, client detail Visits tab) ─────────────
// The tech-facing complete_visit / skip_visit RPCs authorize the ASSIGNED
// TECH (and complete requires a photo). These office variants call the
// office_* SQL functions (can_write_org inside) and log to the timeline.

async function loadVisitForOfficeAction(supabase: any, userId: string, visitId: string) {
  const { requirePermission } = await import("@/lib/authz.server");
  await requirePermission(supabase, userId, "manage_client_billing");
  const { data: v, error } = await supabase
    .from("visits")
    .select("id, organization_id, client_id, property_id, scheduled_on, status")
    .eq("id", visitId)
    .single();
  if (error) throw new Error(error.message);
  return v as {
    id: string;
    organization_id: string;
    client_id: string;
    property_id: string | null;
    scheduled_on: string;
    status: string;
  };
}

/** Mark a scheduled/in-progress visit completed from the office. Timestamps
 * default sensibly (completed now, started kept or now); use the timestamp
 * correction flow afterwards if the real times differ. */
export const completeVisitFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId);
    if (v.status !== "scheduled" && v.status !== "in_progress")
      throw new Error("Only scheduled or in-progress visits can be completed");
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_complete_visit", {
      _visit_id: data.visitId,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.completed",
      summary: `Marked the visit on ${v.scheduled_on} completed from the office`,
    });
    return { ok: true };
  });

/** Move a scheduled visit to a new date. Wraps the reschedule_visit RPC
 * (can_write_org inside) and records the move on the Activity timeline. */
export const rescheduleVisitFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId);
    if (v.status !== "scheduled") throw new Error("Only scheduled visits can be rescheduled");
    // The day it left and the day it went to.
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await supabase.rpc("reschedule_visit", {
      _visit_id: data.visitId,
      _new_date: data.newDate,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.rescheduled",
      summary: `Rescheduled the visit from ${v.scheduled_on} to ${data.newDate}`,
      meta: { from: v.scheduled_on, to: data.newDate },
    });
    return { ok: true };
  });

/** Cancel (skip) a scheduled visit from the office. A reason is required;
 * the org's skip-billing rules apply through office_skip_visit. */
export const cancelVisitFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        code: z
          .enum([
            "client_cancelled_late",
            "gate_locked",
            "dog_outside",
            "weather",
            "our_fault",
            "access_blocked",
            "unsafe_conditions",
            "other",
          ])
          .default("other"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId);
    if (v.status !== "scheduled") throw new Error("Only scheduled visits can be canceled");
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.canceled",
      summary: `Canceled the visit on ${v.scheduled_on}: ${data.reason}`,
      meta: { reason: data.reason, code: data.code },
    });
    return { ok: true };
  });

// ── Bulk dispatch ─────────────────────────────────────────────────────────
//
// Dispatch could move exactly one visit at a time, by dragging it. Reassigning
// a tech's Tuesday meant fourteen drags; moving a rained-off day meant doing it
// for every stop; taking a tech off the roster meant finding their work by eye.
//
// All four are thin wrappers: the authorization, the single-organization check
// on the caller-supplied id list, and the routing-eligibility rule all live in
// SQL, because these are RPCs the browser can call directly and a check in this
// file would be advice rather than a gate.

export const bulkAssignVisits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // Bounded: an unbounded list is a request to hold the whole table in
        // one transaction. 500 is far past any real day's work.
        visitIds: z.array(z.string().uuid()).min(1).max(500),
        // Null unassigns — how work comes OFF someone.
        staffId: z.string().uuid().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities(data.visitIds);
    const { data: n, error } = await (context.supabase as any).rpc("bulk_reassign_visits", {
      _visit_ids: data.visitIds,
      _staff_id: data.staffId,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    return { moved: (n as number) ?? 0 };
  });

export const bulkRescheduleVisits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitIds: z.array(z.string().uuid()).min(1).max(500),
        toDate: z.string(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities(data.visitIds);
    const { data: rows, error } = await (context.supabase as any).rpc("bulk_reschedule_visits", {
      _visit_ids: data.visitIds,
      _to_date: data.toDate,
    });
    if (error) throw new Error(error.message);
    await pushRoutes();
    // `skipped` is not an error and must reach the caller: a weekly client
    // moved exactly a week already has a visit there, and the honest report is
    // "moved 12, left 2 alone", not silence.
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { moved: row?.moved ?? 0, skipped: row?.skipped ?? 0 };
  });

/** What a tech is still holding, by day — read BEFORE offering to move it. */
export const getStaffUpcomingLoad = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (context.supabase as any).rpc("staff_upcoming_load", {
      _staff_id: data.staffId,
    });
    if (error) throw new Error(error.message);
    const days = (rows ?? []) as Array<{ scheduled_on: string; visits: number }>;
    return { days, total: days.reduce((s, d) => s + (d.visits ?? 0), 0) };
  });

export const redistributeStaffWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: n, error } = await (context.supabase as any).rpc("redistribute_staff_work", {
      _staff_id: data.staffId,
    });
    if (error) throw new Error(error.message);
    // The work went to whoever had room, which this call does not say, so
    // every live route in the business is rebuilt; an unchanged one is not
    // pushed.
    const { data: staffRow } = await context.supabase
      .from("staff")
      .select("organization_id")
      .eq("id", data.staffId)
      .maybeSingle();
    if (staffRow?.organization_id) {
      const { refreshOrgRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshOrgRouteLiveActivities(staffRow.organization_id);
    }
    return { moved: (n as number) ?? 0 };
  });

// ── Auto-routing: one button ───────────────────────────────────────────────
//
// There used to be two presses. Preview measured the day, showed a headline,
// and only then did Apply light up. QA on 2026-08-19: "Also remove the
// preview, let's just have apply." So the STEP is gone — the dispatcher picks
// the days and the people, and presses one button.
//
// ── AND SINCE 2026-10, THE SEARCH RUNS HERE, NOT IN POSTGRES ────────────
//
// Each day is three short steps (route-plan.server.ts): route_day_inputs
// reads everything the planner may know, the solver (route-solver.ts) searches
// in this process inside a time budget, and apply_route_plan checks the plan,
// replays the clock in SQL and writes it. plan_day_across_staff did all three
// inside one statement and took 7-23 seconds on a 200-stop day against the
// API's 8-second limit; see 20261002090700.
//
// What the panel shows afterwards comes from the write itself, which is
// better than what it had: the old forecast was a dry run taken BEFORE the
// road was measured, so on a brand-new area its window count could differ
// from the plan applied (#294). Now the count is the plan applied.

const LEVELS = ["fast", "balanced", "thorough"] as const;

/** The search budget for one day, by level, before it is shared out across a
 *  multi-day run. "thorough" is what the panel sends. */
const DAY_BUDGET_MS = { fast: 300, balanced: 1200, thorough: 2500 } as const;
/** And for a whole run: a 92-day range gets a short search per day rather
 *  than four minutes of waiting. */
const RUN_BUDGET_MS = 25_000;
const MIN_DAY_BUDGET_MS = 250;

export type WindowMissOut = {
  day: string;
  staffId: string;
  client: string | null;
  kind: "late" | "early";
  etaStart: string;
  earliest: string | null;
  latest: string | null;
};

export const applyOptimize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffIds: z.array(z.string().uuid()).min(1).max(50),
        // Bare z.string() here was a one-request denial of service. The refine
        // below is a LEXICAL compare, so "zzzz" passed it, and the day loop in
        // the handler breaks on `iso > data.to` — which "2026-08-27" > "zzzz"
        // never satisfies. Reproduced: 2,000,001 iterations and 117MB of heap
        // still climbing, from a single authenticated POST. Shape first, so a
        // non-date cannot reach the loop at all; the same idiom as
        // cpa-reports.functions.ts:51 and four other files.
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
        level: z.enum(LEVELS).default("balanced"),
        reassign: z.boolean().default(false),
        // Arrival windows for THIS run: "org" follows Settings -> Scheduling,
        // the other two override it once. See 20261002090400.
        windows: z.enum(["org", "honour", "ignore"]).default("org"),
      })
      // A well-formed but absurd range is still 2.9M planner calls, so the
      // span is bounded as well as the shape. A quarter is far past what a
      // dispatcher plans in one press.
      .refine(
        (v) =>
          (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000 <= 92,
        { message: "Route at most 92 days at a time.", path: ["to"] },
      )
      .refine((v) => v.to >= v.from, {
        message: "The end date is before the start date.",
        path: ["to"],
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const days: string[] = [];
    for (let d = new Date(`${data.from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso > data.to) break;
      days.push(iso);
    }
    const dayBudget = Math.max(
      MIN_DAY_BUDGET_MS,
      Math.min(DAY_BUDGET_MS[data.level], Math.floor(RUN_BUDGET_MS / days.length)),
    );
    const honourWindows =
      data.windows === "honour" ? true : data.windows === "ignore" ? false : null;

    const { planAndApplyDay } = await import("@/lib/route-plan.server");

    let stops = 0;
    const skipped: Array<{ staffId: string; day: string; reason: string }> = [];
    // Days planned from straight-line estimates because nothing could be
    // measured, and days where only some points were measurable. Kept apart
    // because they are different sentences: one day is wrong throughout, the
    // other is wrong in places.
    const estimatedDays: Array<{ day: string; problem: RoadLegProblem }> = [];
    const partlyEstimatedDays: Array<{ day: string; points: number }> = [];
    const perStaff = new Map<string, { stops: number; totalMin: number }>();
    // What the old read-only forecast reported, now read off the write.
    let techDays = 0;
    let techDaysMeasured = 0;
    let savedMin = 0;
    let violations = 0;
    const windowMisses: WindowMissOut[] = [];
    // Whether arrival windows were honoured on the days planned (the
    // organization's setting, unless this run overrode it).
    let windowsHonoured: boolean | null = honourWindows;

    for (const day of days) {
      // Measure the real road legs for this day before planning it. Best
      // effort on purpose: anything unmeasured is priced by the estimate, and
      // a dispatcher whose routing engine is down still gets a plan. It is a
      // cache warm, not a dependency -- but it is not SILENT: a day planned
      // from estimates is reported, by reason, because a solver minimising
      // the wrong quantity picks the wrong ORDER (road-legs.server.ts).
      try {
        const { refreshRoadLegs } = await import("@/lib/road-legs.server");
        const legs = await refreshRoadLegs(orgId, day);
        if (legs.problem) estimatedDays.push({ day, problem: legs.problem });
        else if (legs.pointsOutsideGraph > 0)
          partlyEstimatedDays.push({ day, points: legs.pointsOutsideGraph });
      } catch (err) {
        // A throw here is not one of refreshRoadLegs' own answers -- it returns
        // its failures. This is the import or something below it, and the day
        // is on estimates either way, so it is reported as an outage rather
        // than left out of the count.
        estimatedDays.push({ day, problem: "router_unreachable" });
        console.error("road leg refresh failed for", day, (err as Error).message);
      }

      let result: Awaited<ReturnType<typeof planAndApplyDay>>;
      try {
        result = await planAndApplyDay(supabase, {
          orgId,
          staffIds: data.staffIds,
          day,
          reassign: data.reassign,
          honourWindows,
          timeLimitMs: data.level === "fast" ? DAY_BUDGET_MS.fast : dayBudget,
          rounds: data.level === "fast" ? 0 : undefined,
        });
      } catch (err) {
        // A day that could not be planned must not abandon the other twenty.
        // Collected and reported, not swallowed — silently skipping is how a
        // dispatcher ends up believing a day was optimized when it was
        // refused. staffId is empty because the refusal is about the DAY: the
        // planner considers the whole team at once.
        skipped.push({ staffId: "", day, reason: `${day}: ${(err as Error).message}` });
        continue;
      }
      windowsHonoured = result.honourWindows;

      const before = new Map(result.before.map((b) => [b.staffId, b]));
      for (const r of result.rows) {
        stops += r.stops;
        violations += r.late;
        const prev = perStaff.get(r.staff_id) ?? { stops: 0, totalMin: 0 };
        perStaff.set(r.staff_id, {
          stops: prev.stops + r.stops,
          totalMin: prev.totalMin + r.total_min,
        });
        if (r.stops === 0) continue;
        techDays++;
        // Saving is summed ONLY over technician-days that had a real route
        // to compare against. A day whose stops carried no sequence is not a
        // slower route, it is no route — counting it would inflate the
        // headline with the entire cost of a day nobody had planned yet.
        const b = before.get(r.staff_id);
        if (b?.sequenced) {
          techDaysMeasured++;
          savedMin += b.minutes - r.travel_min;
        }
      }
      for (const m of result.misses) {
        windowMisses.push({
          day,
          staffId: m.staff_id,
          client: m.client,
          kind: m.kind,
          etaStart: m.eta_start,
          earliest: m.earliest,
          latest: m.latest,
        });
      }
    }

    // Any of these techs whose route for one of these days is on a lock
    // screen gets the new order; nobody else costs more than a lookup.
    {
      const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshRouteLiveActivities(
        days.flatMap((day) => data.staffIds.map((staffId) => ({ staffId, day }))),
      );
    }

    // The split itself, so the screen can show that the work was actually
    // divided. Without this the dispatcher has to go and count rows to find
    // out whether the thing they just pressed did anything.
    const balance = [...perStaff.entries()]
      .map(([staffId, v]) => ({ staffId, stops: v.stops, totalMin: Math.round(v.totalMin) }))
      .sort((a, b) => b.totalMin - a.totalMin);

    // The same five numbers the read-only forecast used to carry, so the
    // panel's sentences did not have to change. Null only when every day was
    // refused: then there is nothing to report, and "nothing to route" would
    // be the wrong sentence.
    const forecast =
      skipped.length === days.length
        ? null
        : {
            stops,
            daysPlanned: techDays,
            daysMeasured: techDaysMeasured,
            // Rounded once, at the end. Rounding per day and summing drifts.
            savedMin: Math.round(savedMin * 10) / 10,
            violations,
          };

    // ── DOES WHAT WAS WRITTEN FIT THE DAY? ──────────────────────────────
    //
    // The planner plans a day with more work than hours rather than refuse
    // it -- the routing trials planned one technician to 02:51 the next
    // morning and reported only "Routed 40 stops". Planning it is right; not
    // saying so is not. Read back after the write, because the ETAs only
    // exist then.
    //
    // Best effort: a failed read must never undo or block the routing the
    // dispatcher asked for, so it degrades to null.
    let fit: ReturnType<typeof measureDayFit> | null = null;
    try {
      const [{ data: org }, { data: crew }, { data: planned, error: plannedError }] =
        await Promise.all([
          supabase
            .from("organizations")
            .select("timezone, workday_end")
            .eq("id", orgId)
            .maybeSingle(),
          supabase.from("staff").select("id, daily_capacity_minutes").in("id", data.staffIds),
          supabase
            .from("visits")
            .select(
              "assigned_staff_id, scheduled_on, eta_end, travel_min, properties(latitude, longitude, service_duration_min)",
            )
            .eq("organization_id", orgId)
            .eq("status", "scheduled")
            .gte("scheduled_on", data.from)
            .lte("scheduled_on", data.to)
            .in("assigned_staff_id", data.staffIds),
        ]);
      if (plannedError) throw plannedError;
      fit = measureDayFit(
        (planned ?? []).map((v) => ({
          staffId: v.assigned_staff_id,
          day: v.scheduled_on,
          etaEnd: v.eta_end,
          travelMin: v.travel_min == null ? null : Number(v.travel_min),
          serviceMin: v.properties?.service_duration_min ?? null,
          latitude: v.properties?.latitude ?? null,
          longitude: v.properties?.longitude ?? null,
        })),
        {
          timezone: org?.timezone || DEFAULT_ORG_TIMEZONE,
          workdayEnd: org?.workday_end ?? null,
          capacityByStaff: Object.fromEntries(
            (crew ?? []).map((s) => [s.id, s.daily_capacity_minutes]),
          ),
        },
      );
    } catch (err) {
      console.error("day-fit check failed", (err as Error).message);
      fit = null;
    }

    return {
      stops,
      skipped,
      balance,
      forecast,
      estimatedDays,
      partlyEstimatedDays,
      fit,
      windowsHonoured,
      // Capped: a 92-day run with windows set aside could miss hundreds, and
      // the panel names a handful and counts the rest.
      windowMisses: windowMisses.slice(0, 50),
      windowMissCount: windowMisses.length,
    };
  });

// assignRoute / optimizeRoute / optimizeWeek / reoptimizeAll were removed here.
//
// They backed the deleted "One tech, one day" card. optimizeRoute was called
// with `reassign: true`, and that branch of optimize_route_v2 selects every
// scheduled visit on the day org-wide and writes one tech onto all of them —
// a whole day silently reassigned to one person, with no confirm or undo.
//
// Deleting the UI left these exported and callable; the dead-machinery check
// flagged all four the moment the card went, which is what it is for. They are
// gone rather than baselined, because an unreferenced export is still a live
// RPC endpoint for anyone who can post to it.
//
// Everything they did is in applyOptimize, which measures with the read-only
// planner before it writes and only reassigns when explicitly asked.
//
// previewOptimize left the same way on 2026-08-19, when the preview STEP was
// removed from the panel: with no caller it was an exported server function
// and therefore a live endpoint, which is exactly the state the four above
// were deleted for. `preview_optimize` the SQL FUNCTION stays: since 2026-10
// the app reads its numbers off apply_route_plan instead, and the routing
// trials call the old planner as the benchmark the new one is held to.
