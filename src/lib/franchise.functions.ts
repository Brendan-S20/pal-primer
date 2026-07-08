import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Franchise rollup is owner-only — every function in this file is gated on
// manage_franchise, matching the /franchise route boundary.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "manage_franchise")).orgId;
}

export type FranchiseRow = {
  organization_id: string;
  organization_name: string;
  active_clients: number;
  visits_today: number;
  visits_completed_today: number;
  revenue_mtd_cents: number;
  ar_open_cents: number;
  tech_count: number;
};

export const getFranchiseContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("id, name, is_franchise_parent, parent_organization_id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const { data: children } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    return {
      org,
      isParent: !!org?.is_franchise_parent || (children ?? []).length > 0,
      children: children ?? [],
    };
  });

async function computeRowForOrg(supabase: any, orgId: string, name: string): Promise<FranchiseRow> {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [clients, techs, visitsToday, visitsDone, mtdPayments, arInvoices] = await Promise.all([
    supabase.from("clients").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("active", true),
    supabase.from("staff").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("active", true),
    supabase.from("visits").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("scheduled_on", today),
    supabase.from("visits").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("scheduled_on", today).eq("status", "completed"),
    supabase.from("payments").select("amount_cents")
      .eq("organization_id", orgId).eq("status", "succeeded")
      .gte("created_at", monthStart.toISOString()),
    supabase.from("invoices").select("total_cents")
      .eq("organization_id", orgId).in("status", ["open", "overdue", "sent"]),
  ]);

  const revenue = (mtdPayments.data ?? []).reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0);
  const ar = (arInvoices.data ?? []).reduce((s: number, r: any) => s + Number(r.total_cents ?? 0), 0);

  return {
    organization_id: orgId,
    organization_name: name,
    active_clients: clients.count ?? 0,
    tech_count: techs.count ?? 0,
    visits_today: visitsToday.count ?? 0,
    visits_completed_today: visitsDone.count ?? 0,
    revenue_mtd_cents: revenue,
    ar_open_cents: ar,
  };
}

export const getFranchiseRollup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: children, error } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    const rows = await Promise.all(
      (children ?? []).map((c: any) => computeRowForOrg(context.supabase, c.id, c.name)),
    );
    return { rows };
  });

export const getFranchiseTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: children } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    const kids = (children ?? []) as Array<{ id: string; name: string }>;
    if (kids.length === 0) return { weeks: [] as any[], locations: [] as any[] };

    // Last 8 weeks (Mon-Sun)
    const weeks: { key: string; start: Date; end: Date }[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dow = today.getUTCDay(); // 0=Sun
    const mondayOffset = (dow + 6) % 7;
    const thisMonday = new Date(today);
    thisMonday.setUTCDate(today.getUTCDate() - mondayOffset);
    for (let i = 7; i >= 0; i--) {
      const start = new Date(thisMonday);
      start.setUTCDate(thisMonday.getUTCDate() - i * 7);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 7);
      weeks.push({ key: start.toISOString().slice(5, 10), start, end });
    }

    const earliest = weeks[0].start.toISOString();
    const latest = weeks[weeks.length - 1].end.toISOString();

    const { data: pays } = await context.supabase
      .from("payments")
      .select("organization_id, amount_cents, created_at")
      .in("organization_id", kids.map((k) => k.id))
      .eq("status", "succeeded")
      .gte("created_at", earliest)
      .lt("created_at", latest);

    // Build week buckets: [{ week: "MM-DD", [orgId]: cents, ... }]
    const bucket: Record<string, Record<string, number>> = {};
    for (const w of weeks) bucket[w.key] = {};
    for (const p of pays ?? []) {
      const t = new Date(p.created_at as string).getTime();
      const w = weeks.find((x) => t >= x.start.getTime() && t < x.end.getTime());
      if (!w) continue;
      const oid = p.organization_id as string;
      bucket[w.key][oid] = (bucket[w.key][oid] ?? 0) + Number(p.amount_cents ?? 0);
    }
    const series = weeks.map((w) => {
      const row: Record<string, any> = { week: w.key };
      for (const k of kids) row[k.id] = (bucket[w.key][k.id] ?? 0) / 100;
      return row;
    });
    return { weeks: series, locations: kids };
  });

export const markSelfAsFranchiseParent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("mark_franchise_parent", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { ok: true, orgId };
  });
