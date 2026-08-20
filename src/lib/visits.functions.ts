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
         weather_flagged, weather_note,
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


    // last 5 visits for this client
    const { data: history } = await supabase
      .from("visits")
      .select("id, scheduled_on, status")
      .eq("client_id", (v as any).client_id)
      .neq("id", data.visitId)
      .order("scheduled_on", { ascending: false })
      .limit(5);

    return { visit: v, dogs: dogs ?? [], history: history ?? [] };
  });



export const listStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await (supabase.from("staff") as any)
      .select("id, display_name, role, active, is_field_tech, routing_available, start_latitude, start_longitude, start_address, end_latitude, end_longitude, end_address")
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
 * matters — see the comment on the generate call below. This is that path, and
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

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, account_type, display_name")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (client.organization_id !== orgId) throw new Error("That client is not in your organization");

    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("id, client_id, zone_id, auto_zone_id, total_units")
      .eq("id", data.propertyId)
      .single();
    if (pErr) throw new Error(pErr.message);
    if (prop.client_id !== data.clientId)
      throw new Error("That property belongs to a different client");

    // subscriptions_account_shape_chk: residential needs dog_count, commercial
    // needs unit_count, and exactly one of them. Getting this wrong fails at
    // the constraint with a message no office manager could act on.
    const accountType = (client.account_type as string) === "commercial" ? "commercial" : "residential";
    const dogCount =
      accountType === "residential"
        ? await supabase
            .from("dogs")
            .select("id", { count: "exact", head: true })
            .eq("property_id", data.propertyId)
            // NOT (active IS false) — `neq("active", false)` would drop rows
            // where active is NULL, which is how most dogs are stored.
            .not("active", "is", false)
            .then((r: any) => Math.max(1, r.count ?? 1))
        : null;

    // ── billing_cadence must be INHERITED, never defaulted ──────────────────
    //
    // Omitting it takes the table default 'postpaid', and that is not a
    // cosmetic difference. client_default_billing_cadence answers "what is this
    // client's cadence" with the cadence of their newest-started ACTIVE
    // subscription — and a one-off booked for today or later is exactly that
    // row. So booking a $40 call-out for a PREPAID client silently converted
    // the whole client to postpaid: their add-on charges stopped drawing down
    // the credit they had already paid, and started landing on postpaid
    // invoices instead. Money they had funded once, billed again.
    //
    // Confirmed live before this was written: cadence_before=prepaid,
    // cadence_after_one_off=postpaid.
    //
    // ── why this mirrors client_default_billing_cadence instead of calling it ──
    //
    // The first version of this fix DID call the RPC, and it would not have
    // worked: client_default_billing_cadence is not granted to `authenticated`,
    // so the call fails, the result is not one of the two literals, and the
    // fallback below quietly restores the very 'postpaid' this exists to
    // prevent. A fix that reports success and changes nothing.
    //
    // Granting it is the wrong repair. It is SECURITY DEFINER, so it would
    // answer about ANY client id from any tenant — the same shape as BUG-42,
    // where six authorization primitives answered about anyone who was asked
    // about. Not worth widening for a convenience.
    //
    // So the ordering is restated here against the caller's own RLS-scoped
    // client, which can only see its own organization's rows. That is a second
    // copy of a rule, which I would normally refuse; the SQL definition is
    // `status='active' ORDER BY started_on DESC NULLS LAST LIMIT 1` and this
    // matches it exactly. It is read BEFORE the insert on purpose — a moment
    // later, the one-off itself would be the newest active subscription and
    // would answer about itself.
    let cadence: "postpaid" | "prepaid" = "postpaid";
    {
      const { data: newest } = await supabase
        .from("subscriptions")
        .select("billing_cadence")
        .eq("client_id", data.clientId)
        .eq("status", "active")
        .order("started_on", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const c = (newest as { billing_cadence?: string } | null)?.billing_cadence;
      if (c === "prepaid" || c === "postpaid") cadence = c;
    }

    const { data: sub, error: sErr } = await supabase
      .from("subscriptions")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        property_id: data.propertyId,
        account_type: accountType,
        frequency: "one_time",
        price_cents: data.priceCents,
        billing_cadence: cadence,
        dog_count: dogCount,
        unit_count: accountType === "commercial" ? Math.max(1, prop.total_units ?? 1) : null,
        zone_id: prop.zone_id ?? prop.auto_zone_id ?? null,
        started_on: data.scheduledOn,
        // A one-off must not keep generating. Bounding it on the same day is
        // what makes the `one_time` branch terminate rather than relying on
        // the frequency alone.
        ends_on: data.scheduledOn,
      })
      .select("id")
      .single();
    if (sErr) throw new Error(sErr.message);

    // ── Generate NOW rather than waiting for the nightly run ────────────────
    //
    // This is the whole reason this function exists. Saving a service has never
    // created its visits — the nightly cron does, or someone presses "Generate
    // schedule". And that button was explicitly disabled for one_time
    // (`canGenerate = … && s.frequency !== "one_time"`), so booking a one-off
    // for TODAY produced a service with no visit, no button, and a banner
    // reading "Its one-time visit is in the past" — which was false. The
    // emergency case was the one case that could not work.
    //
    // Scoped to THIS subscription. It used to call the org-wide
    // generate_visits_through, and I wrote here that the side effect was
    // harmless because the nightly run does the same work. That was true only
    // inside the org's 60-day horizon. Past it, one booking materialised
    // visits for every active subscription across a window whose blackouts
    // nobody had entered yet — and addBlackout only inserts a blackout row, it
    // does not remove visits already generated, so those stay routed on top of
    // the holiday. generate_visits_for_subscription runs the identical code
    // path (same blackout, work-day, hold and ends_on rules) over one row.
    const { error: gErr } = await (supabase as any).rpc("generate_visits_for_subscription", {
      _org_id: orgId,
      _subscription_id: sub.id,
      _through: data.scheduledOn,
    });
    if (gErr) throw new Error(gErr.message);

    const { data: visit } = await supabase
      .from("visits")
      .select("id, scheduled_on")
      .eq("subscription_id", sub.id)
      .maybeSingle();

    // The generator declines a date that is blacked out, outside the org's work
    // days, or inside a client hold — all of which are correct refusals, and
    // all of which would otherwise look like the booking silently vanishing.
    if (!visit) {
      // Take the subscription back out. There is no transaction across these
      // statements, so throwing on its own left a priced, status='active'
      // service behind with no visit — and every failed attempt left another.
      // Those orphans are not inert: an active subscription is what
      // client_default_billing_cadence reads, what the client portal shows as
      // "your plan", and what the seasonal deep-clean generator bills.
      //
      // Delete rather than mark ended: nothing happened, so there is nothing
      // to keep a record of, and a canceled service in the client's history
      // would be a service they never had.
      await supabase.from("subscriptions").delete().eq("id", sub.id);
      throw new Error(
        `Nothing could be scheduled on ${data.scheduledOn}. It is a blackout day, outside your work days, or inside a hold on this client. The booking was not saved, so pick another date and try again.`,
      );
    }

    // Assignment failing must NOT fail the booking. The visit already exists
    // and is already billable at this point, so throwing here reported failure
    // for work that had succeeded — and the dialog stays open with every field
    // still filled in, so the natural response (press the button again) created
    // a SECOND subscription and a SECOND visit for the same client, property
    // and date, which invoices as two visits at full price. Nothing dedupes
    // that: the unique index is (subscription_id, scheduled_on), and these are
    // two different subscriptions.
    //
    // So an unassignable tech leaves the visit unassigned — the state it would
    // have been in anyway had the caller not picked one — and says so.
    let assigned = false;
    let assignWarning: string | null = null;
    if (data.staffId) {
      const { error: rErr } = await (supabase as any).rpc("reassign_visit", {
        _visit_id: visit.id,
        _staff_id: data.staffId,
      });
      if (rErr) assignWarning = rErr.message;
      else assigned = true;
    }

    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: data.clientId,
        propertyId: data.propertyId,
        actorUserId: userId,
        kind: "visit.created",
        summary: `Booked a one-off visit on ${visit.scheduled_on}${
          data.note ? ` — ${data.note}` : ""
        }`,
      });
    } catch {}

    return {
      visitId: visit.id as string,
      subscriptionId: sub.id as string,
      scheduledOn: visit.scheduled_on as string,
      assigned,
      assignWarning,
    };
  });

export const reassignVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ visitId: z.string().uuid(), staffId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("reassign_visit", {
      _visit_id: data.visitId,
      _staff_id: data.staffId as string,
    });
    if (error) throw new Error(error.message);
    // QA round 8: reassignment shows on the client's Activity timeline.
    try {
      const [{ data: v }, { data: staff }] = await Promise.all([
        context.supabase
          .from("visits")
          .select("organization_id, client_id, property_id, scheduled_on")
          .eq("id", data.visitId)
          .single(),
        data.staffId
          ? context.supabase.from("staff").select("display_name").eq("id", data.staffId).maybeSingle()
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
    z.object({
      staffId: z.string().uuid(),
      day: z.string(),
      orderedIds: z.array(z.string().uuid()),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: count, error } = await context.supabase.rpc("reorder_route", {
      _staff_id: data.staffId,
      _day: data.day,
      _ordered_ids: data.orderedIds,
    });
    if (error) throw new Error(error.message);
    return { updated: (count as number) ?? 0 };
  });

export const getDispatchSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select(
        "workday_start, workday_end, avg_speed_kmh, traffic_profile, max_drive_minutes, timezone, work_days, auto_generate_days_ahead, notify_schedule_horizon",
      )
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { settings: data };
  });

export const updateDispatchSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      workday_start: z.string().optional(),
      workday_end: z.string().optional(),
      avg_speed_kmh: z.number().int().min(5).max(120).optional(),
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
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Dispatch settings are org settings — gate like the rest of Settings.
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    // Write via the SECURITY DEFINER RPC (org-dispatch-settings-rpc migration):
    // the only UPDATE RLS policy on organizations is owner-only, so a direct
    // update from an office manager was a silent 0-row no-op. The RPC enforces
    // the role check in the database and errors instead of no-oping.
    const { error } = await (context.supabase as any).rpc("update_org_dispatch_settings", {
      _org_id: orgId,
      _workday_start: data.workday_start ?? null,
      _workday_end: data.workday_end ?? null,
      _avg_speed_kmh: data.avg_speed_kmh ?? null,
      _traffic_profile: data.traffic_profile ?? null,
      _max_drive_minutes: data.max_drive_minutes ?? null,
      _timezone: data.timezone ?? null,
      _work_days: data.work_days ?? null,
      _auto_generate_days_ahead: data.auto_generate_days_ahead ?? null,
      _notify_schedule_horizon: data.notify_schedule_horizon ?? null,
    });
    if (error) throw new Error(error.message);
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
      .refine(
        (v) => !v.startedAt || !v.completedAt || v.completedAt >= v.startedAt,
        { message: "Completion can't be before the start" },
      )
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
    const { error } = await (supabase as any).rpc("office_complete_visit", {
      _visit_id: data.visitId,
    });
    if (error) throw new Error(error.message);
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
    const { error } = await supabase.rpc("reschedule_visit", {
      _visit_id: data.visitId,
      _new_date: data.newDate,
    });
    if (error) throw new Error(error.message);
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
    const { error } = await (supabase as any).rpc("office_skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
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
    const { data: n, error } = await (context.supabase as any).rpc("bulk_reassign_visits", {
      _visit_ids: data.visitIds,
      _staff_id: data.staffId,
    });
    if (error) throw new Error(error.message);
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
    const { data: rows, error } = await (context.supabase as any).rpc("bulk_reschedule_visits", {
      _visit_ids: data.visitIds,
      _to_date: data.toDate,
    });
    if (error) throw new Error(error.message);
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
    return { moved: (n as number) ?? 0 };
  });

// ── Auto-routing: one button, and a measurement taken on the way past ─────
//
// There used to be two presses. Preview measured the day, showed a headline,
// and only then did Apply light up. QA on 2026-08-19: "Also remove the
// preview, let's just have apply." So the STEP is gone — the dispatcher picks
// the days, the people and the level, and presses one button.
//
// THE READ-ONLY TWIN IS NOT GONE, and that distinction is the whole of this
// section. `preview_optimize` runs `plan_day_across_staff_dryrun`, which is
// `plan_day_across_staff` minus the UPDATE — the same planner, so the numbers
// cannot drift from what Apply does. It is also the ONLY thing that can answer
// "how many of these stops will still miss their arrival window", because the
// writer returns stops and minutes per technician and no violation count at
// all. Losing the step must not lose that fact, so applyOptimize measures with
// it immediately before it writes.
//
// That is two planner runs per Apply — exactly what pressing Preview and then
// Apply already cost. What changed is that the dispatcher no longer has to
// spend a press to buy the warning.

const LEVELS = ["fast", "balanced", "thorough"] as const;

/** What the read-only twin says this run is about to do.
 *
 *  Deliberately not a server function any more: nothing outside this file
 *  needs it, and an exported one nothing calls is a live RPC endpoint for
 *  anyone who can post to it — the reason assignRoute and its three siblings
 *  were deleted rather than left lying around below.
 *
 *  Taken BEFORE the write, because afterwards there is nothing left to plan:
 *  the visits this run touches come back assigned and sequenced, so a second
 *  dry run over the same days measures an empty set. */
async function forecastPlan(
  supabase: any,
  orgId: string,
  data: { staffIds: string[]; from: string; to: string; level: string; reassign: boolean },
) {
  const { data: rows, error } = await supabase.rpc("preview_optimize", {
    _org_id: orgId,
    _staff_ids: data.staffIds,
    _from: data.from,
    _to: data.to,
    _level: data.level,
    _reassign: data.reassign,
  } as any);
  if (error) throw new Error(error.message);

  const days = (rows ?? []) as Array<{
    staff_id: string;
    day: string;
    stops: number;
    before_min: number;
    after_min: number;
    before_known: boolean;
    violations: number;
  }>;

  // Saving is summed ONLY over days that had a real route to compare
  // against. A day whose stops carry no sequence is not a slower route, it
  // is no route — counting it would inflate the headline with the entire
  // cost of a day nobody had planned yet.
  const measured = days.filter((d) => d.before_known);
  const savedMin = measured.reduce((n, d) => n + (Number(d.before_min) - Number(d.after_min)), 0);
  return {
    stops: days.reduce((n, d) => n + Number(d.stops), 0),
    daysPlanned: days.length,
    daysMeasured: measured.length,
    // Rounded once, at the end. Rounding per day and summing drifts.
    savedMin: Math.round(savedMin * 10) / 10,
    violations: days.reduce((n, d) => n + Number(d.violations), 0),
  };
}

export const applyOptimize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffIds: z.array(z.string().uuid()).min(1).max(50),
        from: z.string(),
        to: z.string(),
        level: z.enum(LEVELS).default("balanced"),
        reassign: z.boolean().default(false),
      })
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

    // ── THE MEASUREMENT, BEFORE THE WRITE ───────────────────────────────
    //
    // The two facts a dispatcher must not miss are a stop that will still
    // break its arrival window and a day that was refused. The second comes
    // back from the write loop below, in `skipped`. The first exists nowhere
    // in what the writer returns, so it is read here from the read-only twin.
    //
    // A failed measurement must NEVER stop the write. The dispatcher asked
    // for the day to be routed, not for a report — so this returns null and
    // the panel says the check could not run. That is not the same sentence
    // as "no stop misses its window", and the two must not look alike.
    let forecast: Awaited<ReturnType<typeof forecastPlan>> | null = null;
    try {
      forecast = await forecastPlan(supabase, orgId, data);
    } catch {
      forecast = null;
    }

    // ── ONE CALL PER DAY, NOT PER TECH PER DAY ──────────────────────────
    //
    // This loop used to be `for (staffId) for (day) optimize_route_v3(...)`,
    // and that is the whole of the bug an owner reported on 2026-08-15:
    // "I am attempting to utilize the functions with 3 techs; it doesn't split
    // the route, it assigns it all to one."
    //
    // optimize_route_v3 takes ONE `_staff_id` and its candidate set is the
    // whole organisation's day:
    //
    //   AND (_reassign OR v.assigned_staff_id IS NULL
    //                  OR v.assigned_staff_id = _staff_id)
    //
    // so calling it once per technician does not divide anything. Each call
    // claims every visit. With reassign on, the LAST technician in this loop
    // ended up with all of them; with it off, the FIRST took the lot and the
    // rest found nothing. Either way one person got the day, and re-running
    // never helped — which is exactly what was reported.
    //
    // plan_day_across_staff takes the whole selected set at once and does the
    // step that never existed: partition the day between them, then sequence
    // each technician's own share with the same solver as before. See
    // 20260815170000 for the algorithm and why each part of it is there.
    let stops = 0;
    const skipped: Array<{ staffId: string; day: string; reason: string }> = [];
    const perStaff = new Map<string, { stops: number; totalMin: number }>();

    for (const day of days) {
      const { data: rows, error } = await (supabase as any).rpc("plan_day_across_staff", {
        _org_id: orgId,
        _staff_ids: data.staffIds,
        _day: day,
        _reassign: data.reassign,
        _level: data.level,
      } as any);
      if (error) {
        // A day that could not be planned must not abandon the other twenty.
        // Collected and reported, not swallowed — silently skipping is how a
        // dispatcher ends up believing a day was optimized when it was
        // refused. staffId is empty because the refusal is now about the DAY,
        // not about one person: the planner considers the whole team at once.
        skipped.push({ staffId: "", day, reason: `${day}: ${error.message}` });
        continue;
      }
      for (const r of (rows ?? []) as Array<{
        staff_id: string;
        stops: number;
        total_min: number;
      }>) {
        stops += r.stops ?? 0;
        const prev = perStaff.get(r.staff_id) ?? { stops: 0, totalMin: 0 };
        perStaff.set(r.staff_id, {
          stops: prev.stops + (r.stops ?? 0),
          totalMin: prev.totalMin + Number(r.total_min ?? 0),
        });
      }
    }

    // The split itself, so the screen can show that the work was actually
    // divided. Without this the dispatcher has to go and count rows to find
    // out whether the thing they just pressed did anything.
    const balance = [...perStaff.entries()]
      .map(([staffId, v]) => ({ staffId, stops: v.stops, totalMin: Math.round(v.totalMin) }))
      .sort((a, b) => b.totalMin - a.totalMin);

    // `forecast` rides along with the three the screen already had. It is what
    // the removed Preview step used to put on the card, and it is the only
    // route by which a window violation now reaches anybody.
    return { stops, skipped, balance, forecast };
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
// were deleted for. `preview_optimize` the SQL FUNCTION stays, and stays
// called — forecastPlan above is its caller — so the dry-run machinery that
// makes Apply correct is untouched and nothing needed a baseline entry.
