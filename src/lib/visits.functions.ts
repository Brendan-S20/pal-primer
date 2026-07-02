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
    return { assigned };
  });

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
    return { assigned: (count as number) ?? 0 };
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
        "id, scheduled_on, status, sequence, assigned_staff_id, zone_id, property_id, client_id, subscription_id, eta_start, eta_end, travel_km, travel_min, window_violated, clients(display_name), properties(street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time, service_duration_min), zones(name, postal_prefix), staff(display_name), subscriptions(price_cents, frequency, preferred_time_of_day)",
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
        `id, scheduled_on, status, sequence, assigned_staff_id, notes,
         started_at, completed_at, skip_reason, skip_reason_code,
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

    // dogs for the client
    const { data: dogs } = await supabase
      .from("dogs")
      .select("id, name, breed, size, notes, deceased")
      .eq("client_id", (v as any).client_id)
      .eq("deceased", false)
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
    const { data, error } = await supabase
      .from("staff")
      .select("id, display_name, role, active")
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("display_name");
    if (error) throw new Error(error.message);
    return { staff: data ?? [] };
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
    const { data, error } = await context.supabase
      .from("organizations")
      .select("workday_start, workday_end, avg_speed_kmh, traffic_profile")
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
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.from("organizations").update(data).eq("id", orgId);
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
