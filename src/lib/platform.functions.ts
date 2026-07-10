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
// Finding #5: impersonation must never touch the admin's own session. The admin
// mints a single-use grant for a SPECIFIC tenant user; a new, tab-scoped window
// (see IMPERSONATION_WINDOW_PREFIX) exchanges the grant for a session it stores
// only in its own sessionStorage. The admin's shared-localStorage session is
// never read or written. Every start/exchange is written to platform_admin_audit.

import { createHash, randomBytes } from "node:crypto";

const GRANT_TTL_MS = 2 * 60_000;

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

const impersonateSchema = z.object({
  organization_id: z.string().uuid(),
  // The exact user to impersonate (picked in the UI). No silent default.
  target_user_id: z.string().uuid(),
});

/**
 * Admin-gated: mint a one-time, 2-minute impersonation grant for a specific
 * tenant user. Returns an opaque token the caller hands to a NEW tab; nothing
 * about the admin's own session changes here.
 */
export const startImpersonation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => impersonateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The chosen user must actually belong to the tenant being viewed.
    const { data: role, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .eq("organization_id", data.organization_id)
      .eq("user_id", data.target_user_id)
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!role) throw new Error("That user is not a member of this organization.");

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(
      data.target_user_id,
    );
    if (userErr) throw new Error(userErr.message);
    const email = userRes.user?.email;
    if (!email) throw new Error("Target user has no email.");

    const token = randomBytes(32).toString("hex");
    // impersonation_grants is added by the finding-#5 migration; generated
    // Supabase types lag until Lovable regenerates them, so talk to it untyped.
    const { error: insErr } = await (supabaseAdmin as any).from("impersonation_grants").insert({
      token_hash: sha256(token),
      organization_id: data.organization_id,
      target_user_id: data.target_user_id,
      actor_user_id: context.userId,
      expires_at: new Date(Date.now() + GRANT_TTL_MS).toISOString(),
    });
    if (insErr) throw new Error(insErr.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: data.organization_id,
        action: "start_impersonation",
        before_json: null,
        after_json: { target_user_id: data.target_user_id, target_email: email, role: role.role },
      });
    } catch { /* ignore */ }

    return { token, targetEmail: email };
  });

/**
 * Called FROM the new impersonation tab (which has no session yet, so this
 * endpoint is authorized purely by possession of the single-use grant token).
 * Consumes the grant, mints a fresh session for the target user server-side
 * (never in the admin's browser), and returns the tokens for the tab to load
 * into its own sessionStorage-scoped client.
 */
export const consumeImpersonation = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(32).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const nowIso = new Date().toISOString();

    // Atomically claim the grant: only succeeds if unconsumed and unexpired.
    // (Untyped: generated types lag the finding-#5 migration.)
    const { data: grant, error: claimErr } = await (supabaseAdmin as any)
      .from("impersonation_grants")
      .update({ consumed_at: nowIso })
      .eq("token_hash", sha256(data.token))
      .is("consumed_at", null)
      .gte("expires_at", nowIso)
      .select("id, organization_id, target_user_id, actor_user_id")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!grant) throw new Error("This impersonation link has expired or was already used.");

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(
      grant.target_user_id,
    );
    if (userErr) throw new Error(userErr.message);
    const email = userRes.user?.email;
    if (!email) throw new Error("Target user has no email.");

    // Mint a real session for the target WITHOUT establishing it in any
    // browser: generate a magic-link token_hash, then verify it on a throwaway
    // server-side client to obtain access/refresh tokens.
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr) throw new Error(linkErr.message);
    const tokenHash = linkData.properties?.hashed_token;
    if (!tokenHash) throw new Error("Failed to prepare impersonation session.");

    const { createClient } = await import("@supabase/supabase-js");
    const verifier = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );
    const { data: verified, error: vErr } = await verifier.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
    if (vErr) throw new Error(vErr.message);
    const session = verified.session;
    if (!session) throw new Error("Failed to establish impersonation session.");

    // Fetch org name for the banner.
    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("name")
      .eq("id", grant.organization_id)
      .maybeSingle();

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: grant.actor_user_id,
        organization_id: grant.organization_id,
        action: "enter_impersonation",
        before_json: null,
        after_json: { target_user_id: grant.target_user_id, target_email: email },
      });
    } catch { /* ignore */ }

    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      targetEmail: email,
      orgName: org?.name ?? "this tenant",
    };
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
        .from("platform_invoices")
        .select("amount_due_cents, amount_paid_cents")
        .in("status", ["open", "uncollectible"]),
      supabaseAdmin
        .from("payments")
        .select("amount_cents, organization_id, paid_at, status")
        .eq("status", "succeeded")
        .gte("paid_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()),
      supabaseAdmin
        .from("organizations")
        .select("id, name, billing_tier, billing_status, plan_status"),
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

    const ar_open_cents = (arRes.data ?? []).reduce(
      (s, r) => s + Math.max(0, (r.amount_due_cents ?? 0) - (r.amount_paid_cents ?? 0)),
      0,
    );
    const total_orgs = (topRes.data ?? []).length;
    const paying_orgs = (topRes.data ?? []).filter(
      (o) => o.billing_status === "active" || o.billing_status === "past_due" || o.billing_status === "grace",
    ).length;

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
        // Platform SaaS AR — invoices HoundStack billed to tenants, not tenant client invoices.
        supabaseAdmin.from("platform_invoices").select("amount_due_cents, amount_paid_cents", { count: "exact" }).in("status", ["open", "uncollectible"]),
        supabaseAdmin
          .from("platform_invoices")
          .select("amount_due_cents, amount_paid_cents", { count: "exact" })
          .in("status", ["open", "uncollectible"])
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
        // Same table as /platform/signup-requests so counts always agree.
        supabaseAdmin
          .from("platform_signup_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabaseAdmin
          .from("platform_admin_audit")
          .select("id", { count: "exact", head: true })
          .gte("created_at", yesterday),
      ]);

    const dueMinusPaid = (r: { amount_due_cents: number | null; amount_paid_cents: number | null }) =>
      Math.max(0, (r.amount_due_cents ?? 0) - (r.amount_paid_cents ?? 0));
    const open_invoices_count = openInvRes.count ?? 0;
    const open_invoices_total = (openInvRes.data ?? []).reduce((s, r) => s + dueMinusPaid(r), 0);
    const overdue_invoices_count = overdueRes.count ?? 0;
    const overdue_invoices_total = (overdueRes.data ?? []).reduce((s, r) => s + dueMinusPaid(r), 0);
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
