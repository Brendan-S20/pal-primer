import { createServerFn } from "@tanstack/react-start";
import { refuseIfChanged, StaleWriteError } from "@/lib/stale-write";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { resolveCaller } from "@/lib/authz.server";
import { canOfficeComplete, officeCompleteOverrideAsk } from "@/lib/visit-lifecycle";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
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
        "id, scheduled_on, status, sequence, assigned_staff_id, zone_id, property_id, client_id, subscription_id, start_time, duration_min, eta_start, eta_end, travel_km, travel_min, window_violated, weather_flagged, weather_note, skip_reason, skip_reason_code, clients(display_name), properties(street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time, service_duration_min), zones(name, postal_prefix), staff(display_name), subscriptions(price_cents, account_type, frequency, weekdays, preferred_time_of_day, earliest_time, latest_time, stay_id, stays(kind, starts_on, ends_on), groom_addons), service_id, services(name, service_line, default_duration_min)",
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
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    const clash = await overnightClashWarning(supabase, {
      visitIds: (rows ?? []).map((v) => v.id),
    });
    return { visits: rows ?? [], clash };
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
        `id, scheduled_on, status, sequence, assigned_staff_id, route_pinned,
         started_at, completed_at, skip_reason, skip_reason_code, skip_billable, client_package_id,
         weather_flagged, weather_note, tech_note, completion_photo_waived_reason, visit_checklist,
         duration_min, groom_summary, start_time,
         eta_start, eta_end, travel_km, travel_min, window_violated,
         client_id, property_id, updated_at,
         clients(id, display_name, primary_phone, primary_email, credit_balance_cents),
         properties(id, street, city, region, postal_code, parking_notes, access_notes, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, earliest_service_time, latest_service_time, service_duration_min, latitude, longitude),
         zones(name),
         staff(id, display_name),
         subscriptions(price_cents, frequency, preferred_time_of_day, earliest_time, latest_time, booked_via, stay_id, stays(kind, starts_on, ends_on)),
         service_id, services(name, service_line, default_duration_min),
         visit_photos(id, storage_path, kind, created_at)`,
      )
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);

    const { accessFor, readPropertyAccess } = await import("@/lib/property-access");
    const propertyId = (v as { property_id: string | null }).property_id;
    const access = accessFor(await readPropertyAccess(supabase, [propertyId]), propertyId);
    const visit =
      v.properties && typeof v.properties === "object" && !Array.isArray(v.properties)
        ? { ...v, properties: { ...v.properties, ...access } }
        : v;

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
        .select("id, scheduled_on, status, skip_reason, skip_reason_code")
        .eq("client_id", (v as any).client_id)
        .neq("id", data.visitId);
    const [{ data: recent }, { data: upcoming }] = await Promise.all([
      others().lt("scheduled_on", today).order("scheduled_on", { ascending: false }).limit(5),
      others().gte("scheduled_on", today).order("scheduled_on", { ascending: true }).limit(3),
    ]);

    return { visit, dogs: dogs ?? [], recent: recent ?? [], upcoming: upcoming ?? [] };
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
        /** Omitted: the set price (booking-price.server.ts). Someone without
         *  manage_pricing may only send the set price, or nothing (#616). */
        priceCents: z.number().int().min(0).max(10_000_00).optional(),
        /** The service booked (phase 5); omitted is the business's default. */
        serviceId: z.string().uuid().optional(),
        /** Optional: put it straight on a tech's route. */
        staffId: z.string().uuid().nullable().optional(),
        /** Why it was booked. Shows on the client's activity timeline. */
        note: z.string().max(300).optional(),
        /** A walk request's window (#410), carried from /concerns. */
        earliestTime: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .nullable()
          .optional(),
        latestTime: z
          .string()
          .regex(/^\d{2}:\d{2}(:\d{2})?$/)
          .nullable()
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    const { hasPermission } = await import("@/lib/permissions");
    // Booking is its own permission (#616): the front desk books. The price is
    // the part that stays manage_pricing. Someone who holds it types a price,
    // as before; anyone else books at the set price, and a different price is
    // refused, never quietly replaced.
    const caller = await requirePermission(supabase, userId, "booking");
    const { orgId } = caller;
    // Not on a day that is already over, on the business's calendar (#654).
    const { refusePastDay } = await import("@/lib/booking-dates.server");
    await refusePastDay(supabase, orgId, data.scheduledOn);
    const { ENTER_A_ONE_OFF_PRICE, oneOffGridPriceCents, priceOverrideRefusal } =
      await import("@/lib/booking-price.server");
    let priceCents: number;
    let asSetPrice = false;
    if (hasPermission(caller.role, "manage_pricing")) {
      if (data.priceCents != null) {
        priceCents = data.priceCents;
      } else {
        const grid = await oneOffGridPriceCents(supabase, {
          orgId,
          propertyId: data.propertyId,
          serviceId: data.serviceId,
        });
        if (grid.cents == null) throw new Error(ENTER_A_ONE_OFF_PRICE);
        priceCents = grid.cents;
      }
    } else {
      const grid = await oneOffGridPriceCents(supabase, {
        orgId,
        propertyId: data.propertyId,
        serviceId: data.serviceId,
      });
      if (grid.cents == null) throw new Error(grid.reason);
      if (data.priceCents != null && data.priceCents !== grid.cents)
        throw new Error(priceOverrideRefusal(grid.cents));
      priceCents = grid.cents;
      asSetPrice = true;
    }

    // The work itself lives in one-off-visit.server.ts, because it has a
    // second caller: a customer's extra-cleanup request that the owner set to
    // auto-accept is booked by the portal, as the service role, through the
    // same code. Two ways to make the same row is how the two diverge; one
    // function with two callers is not.
    const { bookOneOffVisit } = await import("@/lib/one-off-visit.server");
    // The subscriptions write policy is manage_pricing and stays so: a
    // dispatcher cannot write a plan, or a price, with their own key. Their
    // booking, at the price worked out above, is written as the service role,
    // after bookOneOffVisit checks the client and property are this org's.
    const db = asSetPrice
      ? (await import("@/integrations/supabase/client.server")).supabaseAdmin
      : supabase;
    const booked = await bookOneOffVisit(db, {
      ...data,
      priceCents,
      orgId,
      actorUserId: userId,
      ...(asSetPrice ? { asService: true, assignDb: supabase } : {}),
    });
    // Booked straight onto a tech's today or tomorrow: that tech hears it.
    if (booked.assigned) {
      const { startRouteWatch } = await import("@/lib/field-notify.server");
      const watch = await startRouteWatch({ actorUserId: userId, orgId });
      await watch.finish({ visitIds: [booked.visitId] });
    }
    if (data.staffId) {
      const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshRouteLiveActivities([{ staffId: data.staffId, day: data.scheduledOn }]);
    }
    return booked;
  });

/** The set price of a one-off at this address (#616), for the booking dialog:
 *  a dispatcher sees it and books at it; someone who sets prices starts from it. */
export const oneOffSetPrice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ propertyId: z.string().uuid(), serviceId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "booking");
    const { oneOffGridPriceCents } = await import("@/lib/booking-price.server");
    return oneOffGridPriceCents(context.supabase, { orgId, ...data });
  });

export const reassignVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        staffId: z.string().uuid().nullable(),
        // Sent by a replay of a held reassign (lib/undo-window.ts, #652): the
        // tech the visit had when the dispatcher picked. If it has anybody
        // else now, the first send already landed or somebody has moved it
        // since, and either way this one is left alone and nobody is told.
        ifStillFrom: z.string().uuid().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.ifStillFrom !== undefined) {
      const { data: now, error } = await context.supabase
        .from("visits")
        .select("assigned_staff_id")
        .eq("id", data.visitId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!now || (now.assigned_staff_id ?? null) !== data.ifStillFrom) {
        return {
          ok: true,
          skipped: true,
          clash: null as string | null,
          lessonClashes: [] as never[],
        };
      }
    }
    // A groom refuses a groomer who already has a groom at that time, as
    // booking does. The board's drag between lanes lands here.
    const { refuseGroomMoveClash, groomWriteError } = await import("@/lib/groom-clash.server");
    const move = { visitIds: [data.visitId], toStaffId: data.staffId };
    await refuseGroomMoveClash(context.supabase, move);
    // The tech it comes off and the tech it goes to are told (field-notify).
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({ actorUserId: context.userId, visitIds: [data.visitId] });
    // Both techs' lock screens: the one losing the stop and the one gaining it.
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await context.supabase.rpc("reassign_visit", {
      _visit_id: data.visitId,
      _staff_id: data.staffId as string,
    });
    if (error) throw await groomWriteError(context.supabase, error, move);
    await watch.finish();
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
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    const { lessonClashesAfterMove } = await import("@/lib/training-packages.server");
    const lessonClashes = await lessonClashesAfterMove(context.supabase as any, [data.visitId]);
    return {
      ok: true,
      skipped: false,
      clash: await overnightClashWarning(context.supabase, { visitIds: [data.visitId] }),
      lessonClashes,
    };
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
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: context.userId,
      staffIds: [data.staffId],
      visitIds: data.orderedIds,
    });
    const { data: count, error } = await context.supabase.rpc("reorder_route", {
      _staff_id: data.staffId,
      _day: data.day,
      _ordered_ids: data.orderedIds,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    await refreshRouteLiveActivities([{ staffId: data.staffId, day: data.day }]);
    return { updated: (count as number) ?? 0 };
  });

/**
 * Pin a visit to its technician, or let it go again (#609, D10).
 *
 * A pinned visit is never moved to another tech by auto-routing, even on a
 * run where the dispatcher allowed moving work between techs: route_day_inputs
 * holds it on its tech and apply_route_plan refuses a plan that moves it
 * (20261031090000). It is still put in order on its tech's route, and a
 * person can still reassign it by hand. Office roles only: the drawer that
 * shows the switch is office-only, and this says so too rather than leaving
 * it to the policy that lets a tech edit their own visits.
 */
export const setVisitRoutePinned = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid(), pinned: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    if (role === "tech") throw new Error("Only the office can pin a visit to a tech.");
    const { data: row, error } = await context.supabase
      .from("visits")
      .update({ route_pinned: data.pinned })
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .select("id, route_pinned")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That visit could not be found.");
    return { pinned: row.route_pinned };
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
        // The visit's updated_at when the drawer was opened (#655).
        expectedUpdatedAt: z.string().max(64).nullable().optional(),
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
      .select(
        "id, organization_id, client_id, property_id, scheduled_on, started_at, completed_at, updated_at",
      )
      .eq("id", data.visitId)
      .single();
    if (bErr) throw new Error(bErr.message);
    // Somebody else changed the visit since this drawer loaded it (#655).
    refuseIfChanged(before.updated_at, data.expectedUpdatedAt);

    let write = supabase
      .from("visits")
      .update({ started_at: data.startedAt, completed_at: data.completedAt })
      .eq("id", data.visitId);
    // Checked in the write as well, so a save landing between the read above
    // and this update is refused rather than overwritten.
    if (data.expectedUpdatedAt !== undefined) write = write.eq("updated_at", before.updated_at);
    const { data: written, error } = await write.select("id");
    if (error) throw new Error(error.message);
    if (data.expectedUpdatedAt !== undefined && !written?.length) throw new StaleWriteError();

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

async function loadVisitForOfficeAction(
  supabase: any,
  userId: string,
  visitId: string,
  // Complete and Cancel can bill (office_complete_visit invoices a completed
  // visit, office_skip_visit applies the business's skip-charge rules), so
  // they stay manage_client_billing. A move bills nothing and keeps the
  // visit's price, so it asks for manage_schedule, which a dispatcher holds
  // (#728). The default is the strict one: a new caller that forgets to say
  // is refused, not let through.
  permission: "manage_client_billing" | "manage_schedule" = "manage_client_billing",
) {
  const { requirePermission } = await import("@/lib/authz.server");
  const caller = await requirePermission(supabase, userId, permission);
  const { data: v, error } = await supabase
    .from("visits")
    .select("id, organization_id, client_id, property_id, scheduled_on, status, updated_at")
    .eq("id", visitId)
    // The caller's own business, said out loud as well as left to RLS.
    .eq("organization_id", caller.orgId)
    .single();
  if (error) throw new Error(error.message);
  return v as {
    id: string;
    organization_id: string;
    client_id: string;
    property_id: string | null;
    scheduled_on: string;
    status: string;
    updated_at: string | null;
  };
}

/** Mark a scheduled, in-progress or missed visit completed from the office. Timestamps
 * default sensibly (completed now, started kept or now); use the timestamp
 * correction flow afterwards if the real times differ. */
export const completeVisitFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        /** The person confirmed a visit on a later day was done early (#654). */
        confirmedEarly: z.boolean().optional(),
        /** Why the office is completing a visit with no completion photo, or
         *  with required checklist items nobody checked (#658, F-15). Asked
         *  only when the database says one is missing. */
        overrideReason: z.string().trim().min(1).max(250).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId);
    // A missed visit can be completed too: it was marked missed overnight
    // because nobody closed it, not because it was proved undone (#455).
    if (!canOfficeComplete(v.status))
      throw new Error("Only scheduled, in-progress, or missed visits can be completed");
    // A visit on a later day is completed only on purpose: one stray tap on
    // next Tuesday's stop billed it a week early (#654, F-23).
    if (!data.confirmedEarly) {
      const { orgTodayFor } = await import("@/lib/booking-dates.server");
      const { FUTURE_COMPLETE_REFUSAL, isFutureVisit } = await import("@/lib/booking-dates");
      if (isFutureVisit(v.scheduled_on, await orgTodayFor(supabase, v.organization_id)))
        throw new Error(FUTURE_COMPLETE_REFUSAL);
    }
    // The office closing a stop takes it off the tech's work for the day:
    // "I did the Smiths myself" is a stop they no longer drive to, and they
    // hear it as one that came off. The lock screen already followed (#337).
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: userId,
      orgId: v.organization_id,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_complete_visit", {
      _visit_id: data.visitId,
      ...(data.overrideReason ? { _override_reason: data.overrideReason } : {}),
    });
    if (error) {
      // No photo, or a required checklist item unchecked: the same gate the
      // tech's Complete has. Not an error to the person; a question (#658).
      const ask = officeCompleteOverrideAsk(error.message);
      if (ask && !data.overrideReason) return { ok: false as const, needsOverride: ask };
      throw new Error(error.message);
    }
    await watch.finish();
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.completed",
      summary: data.overrideReason
        ? `Marked the visit on ${v.scheduled_on} completed from the office without its photo or checklist: ${data.overrideReason}`
        : `Marked the visit on ${v.scheduled_on} completed from the office`,
      ...(data.overrideReason ? { meta: { override_reason: data.overrideReason } } : {}),
    });
    // A lesson that leaves one session on its package. Never throws.
    const { afterLessonSessionChange } = await import("@/lib/training-portal.server");
    await afterLessonSessionChange(data.visitId);
    // Billed after each visit on a postpaid plan: the invoice now, not
    // tonight (#859, D2). Once per visit however often this runs; nothing for
    // a prepaid plan. Never throws.
    const { invoiceAtCompletionSafely } = await import("@/lib/visit-completion-invoice.server");
    await invoiceAtCompletionSafely({ visitId: data.visitId, actorUserId: userId });
    return { ok: true as const };
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
        // The visit's updated_at when the drawer was opened (#655).
        expectedUpdatedAt: z.string().max(64).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Routes are the dispatcher's job (#728): a move takes manage_schedule.
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId, "manage_schedule");
    // Somebody else changed the visit since this drawer loaded it: refused
    // before anyone is told about a move (#655).
    refuseIfChanged(v.updated_at, data.expectedUpdatedAt);
    if (v.status !== "scheduled") throw new Error("Only scheduled visits can be rescheduled");
    const { refusePastDay } = await import("@/lib/booking-dates.server");
    await refusePastDay(supabase, v.organization_id, data.newDate);
    // A groom keeps its start time and groomer; the new day must have room.
    const { refuseGroomMoveClash, groomWriteError } = await import("@/lib/groom-clash.server");
    const move = { visitIds: [data.visitId], toDate: data.newDate };
    await refuseGroomMoveClash(supabase, move);
    const { data: was } = await supabase
      .from("visits")
      .select("assigned_staff_id, staff(display_name)")
      .eq("id", data.visitId)
      .maybeSingle();
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: userId,
      orgId: v.organization_id,
      visitIds: [data.visitId],
    });
    // The day it left and the day it went to.
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    // A dog walk's client is told the new day (#410).
    const { watchWalkSchedule } = await import("@/lib/walk-notify.server");
    const walks = await watchWalkSchedule([data.visitId]);
    // Checked again right before the move, since the clash checks and
    // watchers above take several round trips (#655).
    if (data.expectedUpdatedAt !== undefined) {
      const { data: latest, error: lErr } = await supabase
        .from("visits")
        .select("updated_at")
        .eq("id", data.visitId)
        .maybeSingle();
      if (lErr) throw new Error(lErr.message);
      refuseIfChanged(latest?.updated_at ?? null, data.expectedUpdatedAt);
    }
    const { error } = await supabase.rpc("reschedule_visit", {
      _visit_id: data.visitId,
      _new_date: data.newDate,
    });
    if (error) throw await groomWriteError(supabase, error, move);
    await watch.finish();
    await pushRoutes();
    await walks.finish(`${data.visitId}-${data.newDate}`);
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
    // reschedule_visit keeps the technician when the new day is a work day
    // and they are not off (20261015131000). Read back rather than predicted,
    // so the sentence the dispatcher sees is what the database did.
    const { data: now } = await supabase
      .from("visits")
      .select("assigned_staff_id")
      .eq("id", data.visitId)
      .maybeSingle();
    const hadTech = (was as any)?.assigned_staff_id ?? null;
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    const { lessonClashesAfterMove } = await import("@/lib/training-packages.server");
    const lessonClashes = await lessonClashesAfterMove(supabase as any, [data.visitId]);
    return {
      ok: true,
      lessonClashes,
      techName: hadTech
        ? (((was as any)?.staff?.display_name as string | undefined) ?? null)
        : null,
      /** "kept": still theirs. "dropped": they had it and the new day is not
       *  one they work. "none": it had nobody to keep. */
      tech: !hadTech
        ? ("none" as const)
        : (now as any)?.assigned_staff_id === hadTech
          ? ("kept" as const)
          : ("dropped" as const),
      clash: await overnightClashWarning(supabase, { visitIds: [data.visitId] }),
    };
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
        // When the client called. A training lesson's late-cancel rule
        // measures notice from here instead of from now.
        clientCancelledAt: z.string().datetime().nullable().optional(),
        // A bulk cancel sends false and emails once for the whole set
        // afterwards (notifyCanceledWalks), one email per client.
        notifyClient: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForOfficeAction(supabase, userId, data.visitId);
    if (v.status !== "scheduled") throw new Error("Only scheduled visits can be canceled");
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: userId,
      orgId: v.organization_id,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
      ...(data.clientCancelledAt ? { _client_cancelled_at: data.clientCancelledAt } : {}),
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    // A dog walk's client is told (#410). The typed reason is not sent.
    if (data.notifyClient) {
      const { notifyWalksCanceled } = await import("@/lib/walk-notify.server");
      await notifyWalksCanceled({ visitIds: [data.visitId], orgId: v.organization_id });
    }
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
    // A late-canceled lesson can use a session. Never throws.
    const { afterLessonSessionChange } = await import("@/lib/training-portal.server");
    await afterLessonSessionChange(data.visitId);
    return { ok: true };
  });

async function loadVisitForDispatchAction(supabase: any, userId: string, visitId: string) {
  const caller = await resolveCaller(supabase, userId);
  if (!["owner", "office_manager", "dispatcher"].includes(caller.role)) {
    throw new Error("Not authorized");
  }
  const { data: v, error } = await supabase
    .from("visits")
    .select("id, organization_id, client_id, property_id, scheduled_on, status")
    .eq("id", visitId)
    .eq("organization_id", caller.orgId)
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

export const reopenVisitFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForDispatchAction(supabase, userId, data.visitId);
    if (v.status !== "completed") throw new Error("Only completed visits can be reopened");
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: userId,
      orgId: v.organization_id,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_reopen_visit", {
      _visit_id: data.visitId,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.reopened",
      summary: `Reopened the visit on ${v.scheduled_on}`,
    });
    return { ok: true };
  });

export const markVisitMissedFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        // The business's own reason. On a training package lesson it means
        // no session is used.
        code: z.enum(["our_fault", "weather", "unsafe_conditions"]).nullable().default(null),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForDispatchAction(supabase, userId, data.visitId);
    if (v.status !== "completed") throw new Error("Only completed visits can be marked missed");
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: userId,
      orgId: v.organization_id,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await (supabase as any).rpc("office_mark_visit_missed", {
      _visit_id: data.visitId,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.missed",
      summary: `Marked the visit on ${v.scheduled_on} missed`,
      ...(data.code ? { meta: { code: data.code } } : {}),
    });
    return { ok: true };
  });

export const deleteVisitPhotoFromOffice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ visitId: z.string().uuid(), photoId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const v = await loadVisitForDispatchAction(supabase, userId, data.visitId);
    const { data: photo, error: pErr } = await supabase
      .from("visit_photos")
      .select("id, storage_path, kind")
      .eq("id", data.photoId)
      .eq("visit_id", data.visitId)
      .eq("organization_id", v.organization_id)
      .single();
    if (pErr) throw new Error(pErr.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: storageErr } = await supabaseAdmin.storage
      .from("visit-photos")
      .remove([photo.storage_path]);
    if (storageErr) throw new Error(storageErr.message);

    const { error } = await supabase
      .from("visit_photos")
      .delete()
      .eq("id", data.photoId)
      .eq("visit_id", data.visitId)
      .eq("organization_id", v.organization_id);
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: v.organization_id,
      clientId: v.client_id,
      propertyId: v.property_id,
      actorUserId: userId,
      kind: "visit.photo_removed",
      summary: `Removed a ${photo.kind ?? "visit"} photo from the visit on ${v.scheduled_on}`,
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
    // Grooms in the batch: none may land on a groomer who is busy then, and
    // two of them may not land on one groomer at once.
    const { refuseGroomMoveClash, groomWriteError } = await import("@/lib/groom-clash.server");
    const move = { visitIds: data.visitIds, toStaffId: data.staffId };
    await refuseGroomMoveClash(context.supabase, move);
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({ actorUserId: context.userId, visitIds: data.visitIds });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities(data.visitIds);
    const { data: n, error } = await (context.supabase as any).rpc("bulk_reassign_visits", {
      _visit_ids: data.visitIds,
      _staff_id: data.staffId,
    });
    if (error) throw await groomWriteError(context.supabase, error, move);
    await watch.finish();
    await pushRoutes();
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    const { lessonClashesAfterMove } = await import("@/lib/training-packages.server");
    const lessonClashes = await lessonClashesAfterMove(context.supabase as any, data.visitIds);
    return {
      moved: (n as number) ?? 0,
      clash: await overnightClashWarning(context.supabase, { visitIds: data.visitIds }),
      lessonClashes,
    };
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
    const { refusePastDay } = await import("@/lib/booking-dates.server");
    await refusePastDay(
      context.supabase,
      await resolveOrgId(context.supabase, context.userId),
      data.toDate,
    );
    // Grooms keep their start time and groomer; the new day must have room.
    const { refuseGroomMoveClash, groomWriteError } = await import("@/lib/groom-clash.server");
    const move = { visitIds: data.visitIds, toDate: data.toDate };
    await refuseGroomMoveClash(context.supabase, move);
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({ actorUserId: context.userId, visitIds: data.visitIds });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities(data.visitIds);
    // Each dog-walk client gets one email for the whole move (#410).
    const { watchWalkSchedule, moveKey } = await import("@/lib/walk-notify.server");
    const walks = await watchWalkSchedule(data.visitIds);
    const { data: rows, error } = await (context.supabase as any).rpc("bulk_reschedule_visits", {
      _visit_ids: data.visitIds,
      _to_date: data.toDate,
    });
    if (error) throw await groomWriteError(context.supabase, error, move);
    await watch.finish();
    await pushRoutes();
    await walks.finish(moveKey(data.visitIds, data.toDate));
    // `skipped` is not an error and must reach the caller: a weekly client
    // moved exactly a week already has a visit there, and the honest report is
    // "moved 12, left 2 alone", not silence.
    const row = Array.isArray(rows) ? rows[0] : rows;
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    const { lessonClashesAfterMove } = await import("@/lib/training-packages.server");
    const lessonClashes = await lessonClashesAfterMove(context.supabase as any, data.visitIds);
    return {
      moved: row?.moved ?? 0,
      skipped: row?.skipped ?? 0,
      clash: await overnightClashWarning(context.supabase, { visitIds: data.visitIds }),
      lessonClashes,
    };
  });

/** What a tech is still holding, by day, read BEFORE offering to move it.
 *
 *  With `day`, the answer is split at the Cover window (#619): the dates of
 *  the absence that covers `day`, or `day` alone when no time off covers
 *  it. `days`/`total` are what Cover moves by default;
 *  `laterDays`/`laterTotal` stay put unless the office opts in. */
export const getStaffUpcomingLoad = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        today: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const load = async (from: string | null) => {
      const { data: rows, error } = await (context.supabase as any).rpc("staff_upcoming_load", {
        _staff_id: data.staffId,
        _from: from,
      });
      if (error) throw new Error(error.message);
      return (rows ?? []) as Array<{ scheduled_on: string; visits: number }>;
    };
    if (!data.day) {
      const all = await load(null);
      return {
        window: null,
        days: all,
        total: all.reduce((s, d) => s + (d.visits ?? 0), 0),
        laterDays: [] as typeof all,
        laterTotal: 0,
      };
    }
    const today = data.today ?? data.day;
    const start = data.day < today ? today : data.day;
    const { pickCoverWindow, splitLoad } = await import("@/lib/cover-window");
    const { data: off, error: offError } = await context.supabase
      .from("staff_time_off")
      .select("starts_on, ends_on, reason")
      .eq("staff_id", data.staffId)
      .lte("starts_on", start)
      .gte("ends_on", start);
    if (offError) throw new Error(offError.message);
    const window = pickCoverWindow(off ?? [], data.day, today);
    // Read from the window's first day, the org's today at the earliest,
    // not the database's current_date, so the count and the move agree.
    const all = await load(window.from);
    const split = splitLoad(all, window);
    return {
      window,
      days: split.inside,
      total: split.insideTotal,
      laterDays: split.later,
      laterTotal: split.laterTotal,
    };
  });

/** Cover: hand an out tech's work to the rest of the crew.
 *
 *  With `from`/`to` and no `includeLater`, only visits inside those dates
 *  move (#619); everything after `to` stays with this tech. `includeLater`
 *  moves everything from `from` onward, which is what Cover always did. */
export const redistributeStaffWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        includeLater: z.boolean().optional(),
      })
      .refine(
        (v) => !v.to || Boolean(v.from && v.from <= v.to),
        "Pick a start date on or before the end",
      )
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const windowed = Boolean(data.to) && !data.includeLater;
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({ actorUserId: context.userId, staffIds: [data.staffId] });
    const { data: staffRow } = await context.supabase
      .from("staff")
      .select("organization_id")
      .eq("id", data.staffId)
      .maybeSingle();
    let n = 0;
    if (windowed) {
      // Only the away dates. Same order and same fallbacks as
      // redistribute_staff_work, one visit at a time through
      // bulk_reassign_visits, so a groom clash (23P01) or a tech who is off
      // that day (23514) passes the visit to the next tech instead of
      // failing the whole Cover.
      if (!staffRow?.organization_id) throw new Error("staff not found");
      const { data: crew, error: crewError } = await context.supabase
        .from("staff")
        .select("id")
        .eq("organization_id", staffRow.organization_id)
        .eq("active", true)
        .eq("is_field_tech", true)
        .eq("routing_available", true)
        .neq("id", data.staffId)
        .order("display_name");
      if (crewError) throw new Error(crewError.message);
      const others = (crew ?? []).map((r) => r.id as string);
      if (others.length === 0) {
        throw new Error(
          "Nobody else is available to take this work. Add or free up another technician first.",
        );
      }
      const { data: held, error: heldError } = await context.supabase
        .from("visits")
        .select("id, scheduled_on")
        .eq("assigned_staff_id", data.staffId)
        .gte("scheduled_on", data.from!)
        .lte("scheduled_on", data.to!)
        .not("status", "in", "(completed,skipped)")
        .order("scheduled_on")
        .order("sequence", { ascending: true, nullsFirst: false })
        .order("id");
      if (heldError) throw new Error(heldError.message);
      const { spreadVisits } = await import("@/lib/cover-window");
      const moved = await spreadVisits(
        (held ?? []) as Array<{ id: string; scheduled_on: string }>,
        others,
        async (visitId, staffId) => {
          const { data: c, error: e } = await context.supabase.rpc("bulk_reassign_visits", {
            _visit_ids: [visitId],
            _staff_id: staffId,
          });
          if (e) {
            // 23P01: the groom guard (zz_visits_groom_no_overlap), that tech
            // already has a groom then. 23514: the time-off guard
            // (visits_respect_time_off), that tech is off that day. Either
            // way the next tech is asked; anything else fails the Cover.
            if (e.code === "23P01" || e.code === "23514") return "refused";
            throw new Error(e.message);
          }
          return Number(c ?? 0) > 0 ? "ok" : "refused";
        },
      );
      n = moved.length;
    } else {
      const { data: count, error } = await (context.supabase as any).rpc(
        "redistribute_staff_work",
        { _staff_id: data.staffId, _from: data.from ?? null },
      );
      if (error) throw new Error(error.message);
      n = (count as number) ?? 0;
    }
    // A groom with a fixed time that no other tech has room for stays with
    // this tech (20261024100600). Same window as the move, so what is left
    // is exactly what the office still has to place by hand.
    const { data: restAll } = await (context.supabase as any).rpc("staff_upcoming_load", {
      _staff_id: data.staffId,
      _from: data.from ?? null,
    });
    const rest = ((restAll ?? []) as Array<{ scheduled_on: string; visits: number }>).filter(
      (d) => !windowed || d.scheduled_on <= data.to!,
    );
    const left = rest.reduce((s, d) => s + Number(d.visits ?? 0), 0);
    await watch.finish();
    // The work went to whoever had room, which this call does not say, so
    // every live route in the business is rebuilt; an unchanged one is not
    // pushed.
    if (staffRow?.organization_id) {
      const { refreshOrgRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
      await refreshOrgRouteLiveActivities(staffRow.organization_id);
    }
    const { data: remaining, error: remainingError } = await context.supabase
      .from("visits")
      .select("id, scheduled_on, start_time, client:clients(display_name)")
      .eq("assigned_staff_id", data.staffId)
      .in(
        "scheduled_on",
        rest.map((d) => d.scheduled_on),
      )
      .not("status", "in", "(completed,skipped)");
    if (remainingError) throw new Error(remainingError.message);
    const leftAppointments = (remaining ?? []).map((v) => ({
      id: v.id,
      day: v.scheduled_on,
      startTime: v.start_time,
      client: (Array.isArray(v.client) ? v.client[0] : v.client)?.display_name ?? "Client",
    }));
    if (leftAppointments.length && staffRow?.organization_id) {
      const { notifyRoles } = await import("@/lib/notify-center.server");
      await notifyRoles(["owner"], {
        orgId: staffRow.organization_id,
        type: "concern",
        title: "Appointments still need cover",
        body: leftAppointments.map((v) => `${v.client}, ${v.day} ${v.startTime ?? ""}`).join("; "),
        link: "/routes",
        eventKey: `groom-cover:${data.staffId}:${leftAppointments
          .map((v) => v.id)
          .sort()
          .join(":")}`,
      });
    }
    return { moved: n, left, leftAppointments };
  });

// ── Auto-routing moved out of this file on 2026-10-04 ─────────────────────
//
// applyOptimize was the one server function the panel awaited: it read,
// solved and wrote each day in turn, inside the request. It is now a
// background run with a row of its own -- src/lib/routing-runs.functions.ts
// (startRoutingRun) records it, src/lib/auto-routing.server.ts does the work
// and writes the whole run in one transaction at the end. The old export is
// gone rather than kept beside it, for the reason the paragraph below gives:
// an exported server function with no caller is still a live endpoint, and
// this one wrote a whole day.

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
// Everything they did is in auto-routing (auto-routing.server.ts), which only
// reassigns when explicitly asked.
//
// previewOptimize left the same way on 2026-08-19, when the preview STEP was
// removed from the panel: with no caller it was an exported server function
// and therefore a live endpoint, which is exactly the state the four above
// were deleted for. `preview_optimize` the SQL FUNCTION stays: since 2026-10
// the app reads its numbers off apply_route_plan instead, and the routing
// trials call the old planner as the benchmark the new one is held to.
