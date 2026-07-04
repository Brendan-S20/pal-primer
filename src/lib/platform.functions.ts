import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type PlatformOrgRow = {
  organization_id: string;
  organization_name: string;
  billing_tier: string | null;
  plan_status: string | null;
  active_clients: number;
  users_count: number;
  revenue_mtd_cents: number;
  ar_open_cents: number;
  created_at: string;
};

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const getPlatformContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("is_platform_admin", {
      _user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    return { isPlatformAdmin: !!data };
  });

export const getPlatformStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("platform_org_stats");
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as PlatformOrgRow[] };
  });

const updatePlanSchema = z.object({
  organization_id: z.string().uuid(),
  billing_tier: z.string().min(1).max(50).nullable(),
  plan_status: z.enum(["trialing", "active", "past_due", "canceled", "paused"]).nullable(),
});

export const updateOrgPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => updatePlanSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Snapshot the "before" values for the audit trail.
    const { data: before } = await supabaseAdmin
      .from("organizations")
      .select("billing_tier, plan_status")
      .eq("id", data.organization_id)
      .maybeSingle();

    const patch: { billing_tier?: string; plan_status?: any } = {};
    if (data.billing_tier !== null) patch.billing_tier = data.billing_tier;
    if (data.plan_status !== null) patch.plan_status = data.plan_status;
    const { error } = await supabaseAdmin
      .from("organizations")
      .update(patch)
      .eq("id", data.organization_id);
    if (error) throw new Error(error.message);

    // Log to platform_admin_audit — best-effort; never block the mutation.
    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: data.organization_id,
        action: "update_org_plan",
        before_json: before ?? null,
        after_json: patch,
      });
    } catch { /* ignore audit failures */ }

    return { ok: true };
  });

export const listPlatformAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("platform_admin_audit")
      .select("id, actor_user_id, organization_id, action, before_json, after_json, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { rows: data ?? [] };
  });

// ---------- Impersonation ----------
// Generates a one-time magic link for the org owner. Admin briefly signs in as
// that user in a new tab; RLS naturally scopes them to that tenant. Every
// action is written to platform_admin_audit.

const impersonateSchema = z.object({
  organization_id: z.string().uuid(),
});

export const startImpersonation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => impersonateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Find an owner or admin for that org.
    const { data: role, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .eq("organization_id", data.organization_id)
      .in("role", ["owner", "office_manager"])
      .limit(1)
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!role) throw new Error("No owner/admin found for this organization.");

    // Fetch the auth user's email.
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(
      role.user_id,
    );
    if (userErr) throw new Error(userErr.message);
    const email = userRes.user?.email;
    if (!email) throw new Error("Target user has no email.");

    // Generate a magic link — short-lived, single-use.
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr) throw new Error(linkErr.message);
    const actionLink = linkData.properties?.action_link;
    if (!actionLink) throw new Error("Failed to generate impersonation link.");

    // Audit — before/after left null; action carries context.
    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: data.organization_id,
        action: "start_impersonation",
        before_json: null,
        after_json: { target_user_id: role.user_id, target_email: email },
      });
    } catch { /* ignore */ }

    return { actionLink, targetEmail: email };
  });



// ── R5: Revenue trend, system health, enriched audit ────────────────────────

type RevenueBucket = { month: string; revenue_cents: number; payment_count: number; new_orgs: number };

export const getPlatformRevenueTrend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const startIso = start.toISOString();

    const [paymentsRes, orgsRes, arRes, mtdRes, topRes] = await Promise.all([
      supabaseAdmin
        .from("payments")
        .select("amount_cents, paid_at, status")
        .eq("status", "succeeded")
        .gte("paid_at", startIso),
      supabaseAdmin
        .from("organizations")
        .select("id, name, created_at, billing_tier")
        .gte("created_at", startIso),
      supabaseAdmin
        .from("invoices")
        .select("total_cents")
        .eq("status", "open"),
      supabaseAdmin
        .from("payments")
        .select("amount_cents, organization_id, paid_at, status")
        .eq("status", "succeeded")
        .gte("paid_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()),
      supabaseAdmin
        .from("organizations")
        .select("id, name, billing_tier, plan_status"),
    ]);

    if (paymentsRes.error) throw new Error(paymentsRes.error.message);
    if (orgsRes.error) throw new Error(orgsRes.error.message);

    // Build 12 monthly buckets
    const buckets = new Map<string, RevenueBucket>();
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { month: key, revenue_cents: 0, payment_count: 0, new_orgs: 0 });
    }
    for (const p of paymentsRes.data ?? []) {
      if (!p.paid_at) continue;
      const d = new Date(p.paid_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      if (b) { b.revenue_cents += p.amount_cents; b.payment_count += 1; }
    }
    for (const o of orgsRes.data ?? []) {
      const d = new Date(o.created_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      if (b) b.new_orgs += 1;
    }

    // MTD revenue by org → top 5
    const byOrg = new Map<string, number>();
    for (const p of mtdRes.data ?? []) {
      byOrg.set(p.organization_id, (byOrg.get(p.organization_id) ?? 0) + p.amount_cents);
    }
    const orgNames = new Map((topRes.data ?? []).map((o) => [o.id, o.name] as const));
    const topOrgs = Array.from(byOrg.entries())
      .map(([id, cents]) => ({ id, name: orgNames.get(id) ?? "—", revenue_cents: cents }))
      .sort((a, b) => b.revenue_cents - a.revenue_cents)
      .slice(0, 5);

    const trailingMonths = Array.from(buckets.values());
    const last3 = trailingMonths.slice(-3);
    const avgMonthlyCents = last3.length
      ? Math.round(last3.reduce((s, m) => s + m.revenue_cents, 0) / last3.length)
      : 0;

    const ar_open_cents = (arRes.data ?? []).reduce((s, r) => s + (r.total_cents ?? 0), 0);
    const total_orgs = (topRes.data ?? []).length;
    const paying_orgs = (topRes.data ?? []).filter((o) => o.plan_status === "active").length;

    // Revenue-by-tier (MTD)
    const tierRev = new Map<string, number>();
    for (const [orgId, cents] of byOrg.entries()) {
      const org = (topRes.data ?? []).find((o) => o.id === orgId);
      const tier = org?.billing_tier ?? "unassigned";
      tierRev.set(tier, (tierRev.get(tier) ?? 0) + cents);
    }
    const byTier = Array.from(tierRev.entries())
      .map(([tier, cents]) => ({ tier, revenue_cents: cents }))
      .sort((a, b) => b.revenue_cents - a.revenue_cents);

    return {
      months: trailingMonths,
      topOrgs,
      avgMonthlyCents,
      arrEstimateCents: avgMonthlyCents * 12,
      arOpenCents: ar_open_cents,
      totalOrgs: total_orgs,
      payingOrgs: paying_orgs,
      byTier,
    };
  });

export const getPlatformHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [openInvRes, overdueRes, stuckVisitsRes, suppressedRes, aiErrRes, aiTotalRes, signupRes, recentAuditRes] =
      await Promise.all([
        supabaseAdmin.from("invoices").select("total_cents", { count: "exact" }).eq("status", "open"),
        supabaseAdmin
          .from("invoices")
          .select("total_cents", { count: "exact" })
          .eq("status", "open")
          .lt("issued_at", thirtyDaysAgo),
        supabaseAdmin
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("status", "scheduled")
          .lt("scheduled_on", today),
        supabaseAdmin.from("suppressed_emails").select("id", { count: "exact", head: true }),
        supabaseAdmin
          .from("ai_receptionist_logs")
          .select("id", { count: "exact", head: true })
          .not("error", "is", null)
          .gte("created_at", yesterday),
        supabaseAdmin
          .from("ai_receptionist_logs")
          .select("id", { count: "exact", head: true })
          .gte("created_at", yesterday),
        supabaseAdmin
          .from("signup_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabaseAdmin
          .from("platform_admin_audit")
          .select("id", { count: "exact", head: true })
          .gte("created_at", yesterday),
      ]);

    const open_invoices_count = openInvRes.count ?? 0;
    const open_invoices_total = (openInvRes.data ?? []).reduce((s, r) => s + (r.total_cents ?? 0), 0);
    const overdue_invoices_count = overdueRes.count ?? 0;
    const overdue_invoices_total = (overdueRes.data ?? []).reduce((s, r) => s + (r.total_cents ?? 0), 0);
    const stuck_visits = stuckVisitsRes.count ?? 0;
    const suppressed_emails = suppressedRes.count ?? 0;
    const ai_errors_24h = aiErrRes.count ?? 0;
    const ai_calls_24h = aiTotalRes.count ?? 0;
    const pending_signups = signupRes.count ?? 0;
    const admin_actions_24h = recentAuditRes.count ?? 0;

    return {
      open_invoices_count,
      open_invoices_total,
      overdue_invoices_count,
      overdue_invoices_total,
      stuck_visits,
      suppressed_emails,
      ai_errors_24h,
      ai_calls_24h,
      pending_signups,
      admin_actions_24h,
    };
  });

export type PlatformAuditRow = {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  organization_id: string | null;
  organization_name: string | null;
  action: string;
  before_json: any;
  after_json: any;
  created_at: string;
};

export const getPlatformAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: audit, error } = await supabaseAdmin
      .from("platform_admin_audit")
      .select("id, actor_user_id, organization_id, action, before_json, after_json, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const orgIds = Array.from(new Set((audit ?? []).map((r) => r.organization_id).filter(Boolean))) as string[];
    const actorIds = Array.from(new Set((audit ?? []).map((r) => r.actor_user_id).filter(Boolean))) as string[];

    const [orgsRes, actorEmailsMap] = await Promise.all([
      orgIds.length
        ? supabaseAdmin.from("organizations").select("id, name").in("id", orgIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null as null }),
      (async () => {
        const out = new Map<string, string>();
        // Auth admin API doesn't do bulk lookup; do a limited parallel fetch.
        await Promise.all(
          actorIds.slice(0, 50).map(async (uid) => {
            try {
              const { data } = await supabaseAdmin.auth.admin.getUserById(uid);
              if (data?.user?.email) out.set(uid, data.user.email);
            } catch { /* ignore */ }
          }),
        );
        return out;
      })(),
    ]);

    const orgNames = new Map((orgsRes.data ?? []).map((o) => [o.id, o.name] as const));

    const rows: PlatformAuditRow[] = (audit ?? []).map((r) => ({
      id: r.id,
      actor_user_id: r.actor_user_id,
      actor_email: actorEmailsMap.get(r.actor_user_id) ?? null,
      organization_id: r.organization_id,
      organization_name: r.organization_id ? orgNames.get(r.organization_id) ?? null : null,
      action: r.action,
      before_json: r.before_json,
      after_json: r.after_json,
      created_at: r.created_at,
    }));

    return { rows };
  });
