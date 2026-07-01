import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const rangeSchema = z.object({
  from: z.string(), // YYYY-MM-DD
  to: z.string(),
});

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

export const getReports = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { from, to } = data;

    // Visits in range
    const { data: visits, error: vErr } = await supabase
      .from("visits")
      .select("id, status, scheduled_on, assigned_staff_id, zone_id, subscription_id, client_id, skip_reason_code, skip_charge_cents")
      .eq("organization_id", orgId)
      .gte("scheduled_on", from)
      .lte("scheduled_on", to);
    if (vErr) throw new Error(vErr.message);

    const visitCounts = { completed: 0, skipped: 0, scheduled: 0, in_progress: 0, cancelled: 0 } as Record<string, number>;
    const perTech: Record<string, { completed: number; skipped: number; total: number }> = {};
    const perZone: Record<string, { completed: number; skipped: number; total: number }> = {};
    const skipReasons: Record<string, number> = {};

    for (const v of visits ?? []) {
      visitCounts[v.status] = (visitCounts[v.status] ?? 0) + 1;
      const tid = v.assigned_staff_id ?? "unassigned";
      perTech[tid] ??= { completed: 0, skipped: 0, total: 0 };
      perTech[tid].total++;
      if (v.status === "completed") perTech[tid].completed++;
      if (v.status === "skipped") perTech[tid].skipped++;
      const zid = v.zone_id ?? "no_zone";
      perZone[zid] ??= { completed: 0, skipped: 0, total: 0 };
      perZone[zid].total++;
      if (v.status === "completed") perZone[zid].completed++;
      if (v.status === "skipped") perZone[zid].skipped++;
      if (v.status === "skipped" && v.skip_reason_code) {
        skipReasons[v.skip_reason_code] = (skipReasons[v.skip_reason_code] ?? 0) + 1;
      }
    }

    // Staff names
    const staffIds = Object.keys(perTech).filter((x) => x !== "unassigned");
    const { data: staffRows } = staffIds.length
      ? await supabase.from("staff").select("id, display_name").in("id", staffIds)
      : { data: [] as { id: string; display_name: string }[] };
    const staffName = new Map((staffRows ?? []).map((s) => [s.id, s.display_name]));

    // Zone names
    const zoneIds = Object.keys(perZone).filter((x) => x !== "no_zone");
    const { data: zoneRows } = zoneIds.length
      ? await supabase.from("zones").select("id, name").in("id", zoneIds)
      : { data: [] as { id: string; name: string }[] };
    const zoneName = new Map((zoneRows ?? []).map((z) => [z.id, z.name]));

    // Invoices in range (by issued_at)
    const { data: invoices, error: iErr } = await supabase
      .from("invoices")
      .select("id, client_id, status, total_cents, issued_at, paid_at, kind")
      .eq("organization_id", orgId);
    if (iErr) throw new Error(iErr.message);

    let revenuePaidCents = 0;
    let outstandingCents = 0;
    const perClient: Record<string, number> = {};
    const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
    const today = new Date();

    for (const inv of invoices ?? []) {
      const issued = inv.issued_at ? inv.issued_at.slice(0, 10) : null;
      const inRange = issued && issued >= from && issued <= to;
      if (inv.status === "paid" && inRange) {
        revenuePaidCents += inv.total_cents ?? 0;
        perClient[inv.client_id] = (perClient[inv.client_id] ?? 0) + (inv.total_cents ?? 0);
      }
      if (inv.status === "open") {
        outstandingCents += inv.total_cents ?? 0;
        const ref = inv.due_at ?? inv.issued_at;
        if (ref) {
          const days = Math.floor((today.getTime() - new Date(ref).getTime()) / 86400000);
          if (days <= 0) aging.current += inv.total_cents ?? 0;
          else if (days <= 30) aging.d30 += inv.total_cents ?? 0;
          else if (days <= 60) aging.d60 += inv.total_cents ?? 0;
          else aging.d90 += inv.total_cents ?? 0;
        } else {
          aging.current += inv.total_cents ?? 0;
        }
      }
    }

    // Top clients
    const topClientIds = Object.entries(perClient)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);
    const { data: clientRows } = topClientIds.length
      ? await supabase.from("clients").select("id, display_name").in("id", topClientIds)
      : { data: [] as { id: string; display_name: string }[] };
    const clientName = new Map((clientRows ?? []).map((c) => [c.id, c.display_name]));

    // Client churn: created vs deactivated in range
    const { count: newClients } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .gte("created_at", `${from}T00:00:00`)
      .lte("created_at", `${to}T23:59:59`);

    const { count: activeClients } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("active", true);

    return {
      range: { from, to },
      revenuePaidCents,
      outstandingCents,
      aging,
      visitCounts,
      completionRate:
        (visitCounts.completed + visitCounts.skipped) > 0
          ? visitCounts.completed / (visitCounts.completed + visitCounts.skipped)
          : null,
      perTech: Object.entries(perTech)
        .map(([id, s]) => ({
          id,
          name: id === "unassigned" ? "Unassigned" : (staffName.get(id) ?? "—"),
          ...s,
        }))
        .sort((a, b) => b.completed - a.completed),
      perZone: Object.entries(perZone)
        .map(([id, s]) => ({
          id,
          name: id === "no_zone" ? "No zone" : (zoneName.get(id) ?? "—"),
          ...s,
        }))
        .sort((a, b) => b.total - a.total),
      skipReasons: Object.entries(skipReasons)
        .map(([code, n]) => ({ code, count: n }))
        .sort((a, b) => b.count - a.count),
      topClients: topClientIds.map((id) => ({
        id,
        name: clientName.get(id) ?? "—",
        revenueCents: perClient[id],
      })),
      newClients: newClients ?? 0,
      activeClients: activeClients ?? 0,
    };
  });
