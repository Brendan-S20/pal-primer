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

export const assignRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        day: z.string(),
        reassign: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: count, error } = await supabase.rpc("assign_route_for_day", {
      _org_id: orgId,
      _staff_id: data.staffId,
      _day: data.day,
      _reassign: data.reassign ?? false,
    });
    if (error) throw new Error(error.message);
    const assigned = (count as number) ?? 0;
    if (assigned > 0) {
      try {
        const { data: staff } = await supabase
          .from("staff")
          .select("user_id, display_name")
          .eq("id", data.staffId)
          .maybeSingle();
        if (staff?.user_id) {
          const { sendPushToUser } = await import("@/lib/push.server");
          await sendPushToUser(staff.user_id, {
            title: "New route assigned",
            body: `${assigned} stop${assigned === 1 ? "" : "s"} on ${data.day}`,
            tag: `route-${data.staffId}-${data.day}`,
            url: "/my-day",
          });
        }
      } catch (e) {
        console.error("route push failed", e);
      }
    }
    const warnings = await routeWarningsForDay(supabase, orgId, data.staffId, data.day);
    return { assigned, warnings };
  });

/** Fetch the tech's stops for the day and flag implausible ones (finding #10). */
async function routeWarningsForDay(supabase: any, orgId: string, staffId: string, day: string) {
  const { findRouteWarnings } = await import("@/lib/route-plausibility");
  const [{ data: visits }, { data: org }] = await Promise.all([
    supabase
      .from("visits")
      .select("id, scheduled_on, travel_km, travel_min, eta_start, clients(display_name)")
      .eq("organization_id", orgId)
      .eq("assigned_staff_id", staffId)
      .eq("scheduled_on", day),
    (supabase.from("organizations") as any)
      .select("max_drive_minutes, workday_start")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  const rows = (visits ?? []).map((v: any) => ({
    id: v.id,
    clientName: v.clients?.display_name ?? null,
    travel_km: v.travel_km,
    travel_min: v.travel_min,
    eta_start: v.eta_start,
    scheduled_on: v.scheduled_on,
  }));
  const workdayStart: string | null = org?.workday_start ?? null;
  const workdayStartMinutes = workdayStart
    ? Number(workdayStart.slice(0, 2)) * 60 + Number(workdayStart.slice(3, 5))
    : undefined;
  return findRouteWarnings(rows, {
    maxDriveMinutes: org?.max_drive_minutes ?? undefined,
    workdayStartMinutes,
  });
}

export const optimizeRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        day: z.string(),
        reassign: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: count, error } = await supabase.rpc("optimize_route_v2", {
      _org_id: orgId,
      _staff_id: data.staffId,
      _day: data.day,
      _reassign: data.reassign ?? false,
    });
    if (error) throw new Error(error.message);
    const warnings = await routeWarningsForDay(supabase, orgId, data.staffId, data.day);
    return { assigned: (count as number) ?? 0, warnings };
  });

export const reoptimizeAll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    // Get all techs that have any visits assigned that day
    const { data: rows, error: qErr } = await supabase
      .from("visits")
      .select("assigned_staff_id")
      .eq("organization_id", orgId)
      .eq("scheduled_on", data.day)
      .not("assigned_staff_id", "is", null);
    if (qErr) throw new Error(qErr.message);
    const staffIds = Array.from(
      new Set((rows ?? []).map((r: any) => r.assigned_staff_id).filter(Boolean)),
    ) as string[];
    let total = 0;
    const perTech: { staffId: string; assigned: number }[] = [];
    for (const staffId of staffIds) {
      const { data: n, error } = await supabase.rpc("optimize_route_v2", {
        _org_id: orgId,
        _staff_id: staffId,
        _day: data.day,
        _reassign: false,
      });
      if (error) throw new Error(error.message);
      const assigned = (n as number) ?? 0;
      total += assigned;
      perTech.push({ staffId, assigned });
    }
    return { techs: staffIds.length, total, perTech };
  });


export const updateStaffStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        start_address: z.string().nullable().optional(),
        start_latitude: z.number().nullable().optional(),
        start_longitude: z.number().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { error } = await supabase
      .from("staff")
      .update({
        start_address: data.start_address ?? null,
        start_latitude: data.start_latitude ?? null,
        start_longitude: data.start_longitude ?? null,
      })
      .eq("id", data.staffId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
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
        "id, scheduled_on, status, sequence, assigned_staff_id, zone_id, property_id, client_id, subscription_id, eta_start, eta_end, travel_km, travel_min, window_violated, weather_flagged, weather_note, clients(display_name), properties(street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time, service_duration_min), zones(name, postal_prefix), staff(display_name), subscriptions(price_cents, frequency, preferred_time_of_day, earliest_time, latest_time)",
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

// Finding #28: multi-day overview so office staff can spot overloaded days,
// gaps, and upcoming volume without stepping through single days.
export const getVisitRangeSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ from: z.string(), to: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: rows, error } = await supabase
      .from("visits")
      .select("scheduled_on, status, assigned_staff_id")
      .eq("organization_id", orgId)
      .gte("scheduled_on", data.from)
      .lte("scheduled_on", data.to);
    if (error) throw new Error(error.message);

    // Per-day totals: total, completed, unassigned.
    const byDay = new Map<string, { total: number; completed: number; unassigned: number }>();
    for (const v of rows ?? []) {
      const d = (v as any).scheduled_on as string;
      const cur = byDay.get(d) ?? { total: 0, completed: 0, unassigned: 0 };
      cur.total += 1;
      if ((v as any).status === "completed") cur.completed += 1;
      if (!(v as any).assigned_staff_id) cur.unassigned += 1;
      byDay.set(d, cur);
    }
    return {
      days: Array.from(byDay.entries())
        .map(([date, c]) => ({ date, ...c }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

// Finding #27: capacity-aware planning. Detect field techs whose day exceeds a
// working-day capacity (drive + service minutes), and move the overflow (their
// last stops) to the least-loaded available tech under capacity, or to
// Unassigned. Returns per-tech load and the moves made so the dispatcher can
// re-optimize the affected routes.
export const balanceOverloadedRoutes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: z.string(), apply: z.boolean().default(false) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const [{ data: org }, { data: staff, error: sErr }, { data: visits, error: vErr }] = await Promise.all([
      (supabase.from("organizations") as any)
        .select("workday_start, workday_end")
        .eq("id", orgId)
        .maybeSingle(),
      (supabase.from("staff") as any)
        .select("id, display_name, is_field_tech, routing_available, active, daily_capacity_minutes")
        .eq("organization_id", orgId)
        .eq("active", true),
      supabase
        .from("visits")
        .select("id, assigned_staff_id, sequence, status, travel_min, properties(service_duration_min)")
        .eq("organization_id", orgId)
        .eq("scheduled_on", data.day)
        .in("status", ["scheduled", "in_progress"]),
    ]);
    if (sErr) throw new Error(sErr.message);
    if (vErr) throw new Error(vErr.message);

    const toMin = (t: string | null, def: number) =>
      t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : def;
    // Org-wide workday length is the fallback; each tech can override it with a
    // per-tech daily capacity (#27).
    const orgCapacityMin = Math.max(60, toMin(org?.workday_end ?? null, 17 * 60) - toMin(org?.workday_start ?? null, 8 * 60));

    const routableTechs = (staff ?? []).filter((s: any) => s.is_field_tech && s.routing_available);
    const techIds = new Set(routableTechs.map((s: any) => s.id));
    const capFor = new Map<string, number>();
    for (const t of routableTechs) {
      const per = Number((t as any).daily_capacity_minutes);
      capFor.set(t.id, per > 0 ? per : orgCapacityMin);
    }

    const visitMin = (v: any) => Number(v.travel_min ?? 0) + Number(v.properties?.service_duration_min ?? 8);
    // Per-tech load, visits sorted by sequence.
    const load = new Map<string, { total: number; visits: any[] }>();
    for (const t of routableTechs) load.set(t.id, { total: 0, visits: [] });
    for (const v of visits ?? []) {
      const sid = (v as any).assigned_staff_id;
      if (!sid || !load.has(sid)) continue;
      const entry = load.get(sid)!;
      entry.total += visitMin(v);
      entry.visits.push(v);
    }
    for (const entry of load.values()) entry.visits.sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));

    const moves: Array<{ visitId: string; from: string | null; to: string | null }> = [];
    // Greedy: for each overloaded tech, peel off trailing stops until under
    // their capacity, placing each on the least-loaded tech that has room under
    // ITS OWN capacity, else Unassigned.
    for (const [techId, entry] of load) {
      const cap = capFor.get(techId) ?? orgCapacityMin;
      while (entry.total > cap && entry.visits.length > 1) {
        const v = entry.visits.pop()!;
        const cost = visitMin(v);
        entry.total -= cost;
        let target: string | null = null;
        let best = Infinity;
        for (const [otherId, other] of load) {
          if (otherId === techId) continue;
          const otherCap = capFor.get(otherId) ?? orgCapacityMin;
          if (other.total + cost <= otherCap && other.total < best) {
            best = other.total;
            target = otherId;
          }
        }
        if (target) {
          load.get(target)!.total += cost;
          load.get(target)!.visits.push(v);
        }
        moves.push({ visitId: v.id, from: techId, to: target });
      }
    }

    if (data.apply && moves.length) {
      for (const m of moves) {
        await supabase.rpc("reassign_visit", { _visit_id: m.visitId, _staff_id: m.to as string });
      }
      // Re-optimize every route that gained or lost a stop so both sides come
      // back tidy (#27) — no separate manual "Re-optimize" click needed.
      const touched = new Set<string>();
      for (const m of moves) {
        if (m.from) touched.add(m.from);
        if (m.to) touched.add(m.to);
      }
      for (const staffId of touched) {
        await supabase.rpc("optimize_route_v2", { _org_id: orgId, _staff_id: staffId, _day: data.day, _reassign: false });
      }
    }

    return {
      capacityMinutes: orgCapacityMin,
      loads: routableTechs.map((t: any) => {
        const cap = capFor.get(t.id) ?? orgCapacityMin;
        return {
          staffId: t.id,
          name: t.display_name,
          loadMinutes: Math.round(load.get(t.id)?.total ?? 0),
          capacityMinutes: cap,
          overCapacity: (load.get(t.id)?.total ?? 0) > cap,
        };
      }),
      moves,
      applied: data.apply ? moves.length : 0,
      reoptimized: data.apply ? new Set(moves.flatMap((m) => [m.from, m.to].filter(Boolean))).size : 0,
      techsAvailable: techIds.size,
    };
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
        `Nothing could be scheduled on ${data.scheduledOn}. It is a blackout day, outside your work days, or inside a hold on this client — the booking was not saved, so pick another date and try again.`,
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

export const optimizeWeek = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ startDate: z.string(), days: z.number().int().min(1).max(31) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: rows, error } = await supabase.rpc("optimize_week", {
      _org_id: orgId,
      _start_date: data.startDate,
      _days: data.days,
    });
    if (error) throw new Error(error.message);
    return { results: (rows as any[]) ?? [] };
  });

export const getDispatchSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select("workday_start, workday_end, avg_speed_kmh, traffic_profile, max_drive_minutes, timezone, work_days")
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
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updatePropertyWindow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      propertyId: z.string().uuid(),
      earliest_service_time: z.string().nullable().optional(),
      latest_service_time: z.string().nullable().optional(),
      service_duration_min: z.number().int().min(1).max(240).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { propertyId, ...patch } = data;
    const { error } = await context.supabase
      .from("properties")
      .update(patch)
      .eq("id", propertyId)
      .eq("organization_id", orgId);
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
