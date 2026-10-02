import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchPlatformSaasMetrics } from "@/lib/platform-metrics.server";
import { z } from "zod";

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export type PlatformOverviewKpis = {
  mrr_cents: number;
  active_tenants: number;
  free_tenants: number;
  past_due_tenants: number;
  grace_tenants: number;
  suspended_tenants: number;
  new_signups_week: number;
  // Conversion pipeline
  at_threshold: number;      // orgs at exactly 3 active clients (about to convert)
  converted_this_month: number; // orgs whose billing_status became active/past_due/grace this month
  // At-risk
  at_risk: number;           // past_due + grace + paid orgs with >30% client drop in 30d (drop calc later)
};

export const getPlatformOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PlatformOverviewKpis> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [orgsRes, signupsRes, convRes] = await Promise.all([
      supabaseAdmin
        .from("organizations")
        .select("id, billing_status, active_client_count, created_at, deleted_at")
        .is("deleted_at", null),
      supabaseAdmin
        .from("organizations")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .gte("created_at", weekAgo),
      // `subscription_created` used to be in this filter beside
      // `billing_status_change`. Neither string was written by anything — the
      // live audit table holds five distinct actions and has never held
      // either — so this KPI read 0 from the day it shipped and would have kept
      // reading 0 through a hundred conversions. The event is now emitted by
      // platform-billing-status.server.ts, and the name nothing writes is gone
      // rather than left as a second thing to look for.
      supabaseAdmin
        .from("platform_admin_audit")
        .select("organization_id, action, before_json, after_json, created_at")
        .eq("action", "billing_status_change")
        .gte("created_at", monthStart.toISOString()),
    ]);
    if (orgsRes.error) throw new Error(orgsRes.error.message);

    const orgs = orgsRes.data ?? [];
    // MRR is derived from what tenants PAY HOUNDSTACK — the monthly-equivalent
    // price of each paying tenant's platform subscription plan (H5 / I13 #19).
    // It must never be sourced from tenant→client collections (GMV). Shared with
    // the Revenue page via the same computation so the two agree.
    const { mrrCents: mrr_cents } = await fetchPlatformSaasMetrics(supabaseAdmin);

    const byStatus = new Map<string, number>();
    for (const o of orgs) byStatus.set(o.billing_status, (byStatus.get(o.billing_status) ?? 0) + 1);

    const active_tenants =
      (byStatus.get("active") ?? 0) + (byStatus.get("grace") ?? 0) + (byStatus.get("past_due") ?? 0);

    const at_threshold = orgs.filter(
      (o) => (o.active_client_count ?? 0) === 3 && o.billing_status === "free",
    ).length;

    // A conversion is BECOMING a payer, not being one. Reading only the after
    // status counted past_due → active and grace → active, which are a lapsed
    // customer's card finally clearing: the same tenant again, and no new
    // revenue. The transition decides — paying now, not paying before.
    const PAYING = ["active", "grace", "past_due"];
    const convertedIds = new Set<string>();
    for (const a of convRes.data ?? []) {
      const after = a.after_json as { billing_status?: string; became_paying?: boolean } | null;
      const before = (a.before_json as { billing_status?: string } | null)?.billing_status ?? null;
      const becamePaying =
        typeof after?.became_paying === "boolean"
          ? after.became_paying
          : PAYING.includes(after?.billing_status ?? "") && !PAYING.includes(before ?? "");
      if (becamePaying && a.organization_id) convertedIds.add(a.organization_id);
    }

    return {
      mrr_cents,
      active_tenants,
      free_tenants: byStatus.get("free") ?? 0,
      past_due_tenants: byStatus.get("past_due") ?? 0,
      grace_tenants: byStatus.get("grace") ?? 0,
      suspended_tenants: byStatus.get("suspended") ?? 0,
      new_signups_week: signupsRes.count ?? 0,
      at_threshold,
      converted_this_month: convertedIds.size,
      at_risk: (byStatus.get("past_due") ?? 0) + (byStatus.get("grace") ?? 0),
    };
  });

/**
 * How the road-leg measurer did across every workspace, last 7 days.
 *
 * Launch measures roads on the free public OSRM demo, and when it fails a day
 * is planned on straight-line estimates. The dispatcher sees a toast; until
 * this card nobody on the platform side saw anything. One row per day planned
 * lands in `road_leg_runs` (see 20261002090600); this reads the aggregate.
 */
export type RoutingHealth = {
  days: number;
  /** Router asked, answer written. Includes `partlyMeasured`. */
  measured: number;
  /** Measured, but some stops snapped too far to trust; their legs stayed estimated. */
  partlyMeasured: number;
  /** Every leg already fresh in road_legs; the router was not asked. */
  cached: number;
  /** No measured legs at all. */
  estimated: number;
  /** `estimated`, by RoadLegProblem, largest first. */
  estimatedByReason: Array<{ reason: string; runs: number; workspaces: number }>;
};

export const getRoutingHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RoutingHealth> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const days = 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // Aggregated in SQL: the rows are unbounded and PostgREST would silently
    // stop at max_rows, under-counting exactly when routing is busiest.
    const { data, error } = await supabaseAdmin.rpc("road_leg_run_summary", { _since: since });
    if (error) throw new Error(error.message);

    const health: RoutingHealth = {
      days,
      measured: 0,
      partlyMeasured: 0,
      cached: 0,
      estimated: 0,
      estimatedByReason: [],
    };
    for (const row of data ?? []) {
      const runs = Number(row.runs ?? 0);
      if (row.outcome === "measured") {
        health.measured += runs;
        if (row.reason === "points_outside_graph") health.partlyMeasured += runs;
      } else if (row.outcome === "cached") {
        health.cached += runs;
      } else if (row.outcome === "estimated") {
        health.estimated += runs;
        health.estimatedByReason.push({
          reason: row.reason ?? "unknown",
          runs,
          workspaces: Number(row.workspaces ?? 0),
        });
      }
    }
    health.estimatedByReason.sort((a, b) => b.runs - a.runs);
    return health;
  });

export type PlatformTenantRow = {
  id: string;
  name: string;
  billing_status: string;
  plan_slug: string | null;
  plan_name: string | null;
  active_client_count: number;
  users_count: number;
  last_activity_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  suspended_at: string | null;
  grace_expires_at: string | null;
  deleted_at: string | null;
};

/**
 * `include_deleted` exists because soft-delete was a one-way door.
 *
 * softDeleteTenant writes `organizations.deleted_at`; this list filtered the
 * row out and did not even return the column, so a tenant deleted by mistake
 * left the console entirely — no filter, no badge, and the detail page only
 * reachable by pasting a uuid somebody had kept. restoreTenant now undoes the
 * delete, and this is how an admin gets back to the row to press it.
 *
 * Deleted tenants stay OUT by default: the list is the working view of who is
 * live, and every count and bulk action on the page is about live tenants.
 */
const listTenantsSchema = z.object({ include_deleted: z.boolean().optional() });

export const listPlatformTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => listTenantsSchema.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<{ rows: PlatformTenantRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let orgsQ = supabaseAdmin
      .from("organizations")
      .select(
        "id, name, billing_status, active_client_count, stripe_customer_id, stripe_subscription_id, plan_id, created_at, suspended_at, grace_expires_at, deleted_at",
      );
    if (!data.include_deleted) orgsQ = orgsQ.is("deleted_at", null);
    const { data: orgs, error } = await orgsQ.order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const planIds = Array.from(new Set((orgs ?? []).map((o) => o.plan_id).filter(Boolean))) as string[];
    const orgIds = (orgs ?? []).map((o) => o.id);

    const [plansRes, rolesRes, lastPaymentsRes] = await Promise.all([
      planIds.length
        ? supabaseAdmin.from("platform_plans").select("id, name, slug").in("id", planIds)
        : Promise.resolve({ data: [] as { id: string; name: string; slug: string }[], error: null as null }),
      supabaseAdmin.from("user_roles").select("user_id, organization_id").in("organization_id", orgIds),
      supabaseAdmin
        .from("payments")
        .select("organization_id, paid_at")
        .in("organization_id", orgIds)
        .order("paid_at", { ascending: false }),
    ]);

    const planMap = new Map((plansRes.data ?? []).map((p) => [p.id, p] as const));
    const userCount = new Map<string, Set<string>>();
    for (const r of rolesRes.data ?? []) {
      if (!userCount.has(r.organization_id)) userCount.set(r.organization_id, new Set());
      userCount.get(r.organization_id)!.add(r.user_id);
    }
    const lastAct = new Map<string, string>();
    for (const p of lastPaymentsRes.data ?? []) {
      if (p.paid_at && !lastAct.has(p.organization_id)) lastAct.set(p.organization_id, p.paid_at);
    }

    const rows: PlatformTenantRow[] = (orgs ?? []).map((o) => {
      const plan = o.plan_id ? planMap.get(o.plan_id) ?? null : null;
      return {
        id: o.id,
        name: o.name,
        billing_status: o.billing_status,
        plan_slug: plan?.slug ?? null,
        plan_name: plan?.name ?? null,
        active_client_count: o.active_client_count ?? 0,
        users_count: userCount.get(o.id)?.size ?? 0,
        last_activity_at: lastAct.get(o.id) ?? null,
        stripe_customer_id: o.stripe_customer_id ?? null,
        stripe_subscription_id: o.stripe_subscription_id ?? null,
        created_at: o.created_at,
        suspended_at: o.suspended_at ?? null,
        grace_expires_at: o.grace_expires_at ?? null,
        deleted_at: o.deleted_at ?? null,
      };
    });
    return { rows };
  });
