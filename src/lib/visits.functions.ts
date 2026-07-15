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
  .inputValidator((d) => z.object({ day: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: rows, error } = await supabase
      .from("visits")
      .select(
        "id, scheduled_on, status, sequence, assigned_staff_id, zone_id, property_id, client_id, subscription_id, eta_start, eta_end, travel_km, travel_min, window_violated, weather_flagged, weather_note, clients(display_name), properties(street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time, service_duration_min), zones(name, postal_prefix), staff(display_name), subscriptions(price_cents, frequency, preferred_time_of_day)",
      )
      .eq("organization_id", orgId)
      .eq("scheduled_on", data.day)
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
         subscriptions(price_cents, frequency, preferred_time_of_day),
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
    // max_drive_minutes was added by the finding-#10 migration; generated types
    // lag until Lovable regenerates them, so read it untyped.
    const { data, error } = await (context.supabase.from("organizations") as any)
      .select("workday_start, workday_end, avg_speed_kmh, traffic_profile, max_drive_minutes")
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
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await (context.supabase.from("organizations") as any).update(data).eq("id", orgId);
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
