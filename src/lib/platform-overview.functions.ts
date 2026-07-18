import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchPlatformSaasMetrics } from "@/lib/platform-metrics.server";

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
      supabaseAdmin
        .from("platform_admin_audit")
        .select("organization_id, action, after_json, created_at")
        .in("action", ["subscription_created", "billing_status_change"])
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

    const convertedIds = new Set<string>();
    for (const a of convRes.data ?? []) {
      const nextStatus = (a.after_json as { billing_status?: string } | null)?.billing_status;
      if (nextStatus && ["active", "grace", "past_due"].includes(nextStatus)) {
        if (a.organization_id) convertedIds.add(a.organization_id);
      }
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
};

export const listPlatformTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: PlatformTenantRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: orgs, error } = await supabaseAdmin
      .from("organizations")
      .select(
        "id, name, billing_status, active_client_count, stripe_customer_id, stripe_subscription_id, plan_id, created_at, suspended_at, grace_expires_at, deleted_at",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
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
      };
    });
    return { rows };
  });
