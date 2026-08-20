import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { fetchPlatformSaasMetrics } from "@/lib/platform-metrics.server";
import { collectedNetCents } from "@/lib/platform-metrics";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import { planTierDeclarationProblem } from "@/lib/entitlements";


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

const updatePlanSchema = z.object({
  organization_id: z.string().uuid(),
  billing_tier: z.string().min(1).max(50).nullable(),
  plan_status: z.enum(["trialing", "active", "past_due", "canceled", "paused"]).nullable(),
});

// ---------- Plan catalog editing (platform admin → Plans page) ----------

const updatePlatformPlanSchema = z.object({
  planId: z.string().uuid(),
  name: z.string().trim().min(1, "Name can't be empty").max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  // MONTHLY base price. Never receives annual dollars — annual plans carry
  // their yearly base in annualPriceCents (annual_price_cents), which the MRR
  // math divides by 12 (platform-metrics.ts monthlyEquivalentCents).
  priceCents: z.number().int().min(0, "Price must be >= 0").optional(),
  annualPriceCents: z.number().int().min(0, "Price must be >= 0").nullable().optional(),
  includedSeats: z.number().int().min(0).nullable().optional(),
  pricePerSeatCents: z.number().int().min(0, "Price must be >= 0").nullable().optional(),
  // Billing interval of the base price ('month' | 'year'). Annual plans are
  // divided by 12 in the MRR math (platform-metrics.ts monthlyEquivalentCents).
  interval: z.enum(["month", "year"]).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updatePlatformPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updatePlatformPlanSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("platform_plans")
      .select("id, name, description, price_cents, annual_price_cents, included_seats, price_per_seat_cents, interval, is_active, sort_order")
      .eq("id", data.planId)
      .maybeSingle();
    if (beforeErr) throw new Error(beforeErr.message);
    if (!before) throw new Error("Plan not found");

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.priceCents !== undefined) patch.price_cents = data.priceCents;
    if (data.annualPriceCents !== undefined) patch.annual_price_cents = data.annualPriceCents;
    if (data.includedSeats !== undefined) patch.included_seats = data.includedSeats;
    if (data.pricePerSeatCents !== undefined) patch.price_per_seat_cents = data.pricePerSeatCents;
    if (data.interval !== undefined) patch.interval = data.interval;
    if (data.isActive !== undefined) patch.is_active = data.isActive;
    if (data.sortOrder !== undefined) patch.sort_order = data.sortOrder;
    if (Object.keys(patch).length === 0) return { ok: true, unchanged: true };
    patch.updated_at = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from("platform_plans")
      .update(patch as any)
      .eq("id", data.planId);
    if (error) throw new Error(error.message);

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "update_plan",
        before_json: before,
        after_json: { id: data.planId, ...patch },
      });
    } catch { /* audit best-effort */ }

    return { ok: true };
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
    const { error: insErr } = await supabaseAdmin.from("impersonation_grants").insert({
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
    // BUG-2: stamp the SESSION's own window at the same moment the grant is
    // claimed. `expires_at` bounds only the click-through link; without this
    // the minted session refreshed itself forever and then failed silently.
    const { IMPERSONATION_SESSION_TTL_MS } = await import("@/lib/impersonation-session.shared");
    const sessionExpiresAt = new Date(Date.now() + IMPERSONATION_SESSION_TTL_MS).toISOString();

    const { data: grant, error: claimErr } = await supabaseAdmin
      .from("impersonation_grants")
      .update({ consumed_at: nowIso, session_expires_at: sessionExpiresAt })
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
      resolveSupabaseUrl(),
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

    // Record the minted session's id on the grant so tenant activity written
    // under this session can carry an impersonation marker (H2). Session ids
    // are stable across token refreshes, so this stays valid for the tab's
    // lifetime. Best-effort: a failed write just means unmarked activity.
    try {
      const { sessionIdFromAuthHeader } = await import("@/lib/impersonation-marker");
      const authSessionId = sessionIdFromAuthHeader(`Bearer ${session.access_token}`);
      if (authSessionId) {
        await supabaseAdmin
          .from("impersonation_grants")
          .update({ auth_session_id: authSessionId })
          .eq("id", grant.id);
      }
    } catch { /* ignore */ }

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
      // The tab keeps this so its "Exit impersonation" control can close the
      // audit loop with a stop event + duration (H2).
      grantId: grant.id as string,
      startedAt: nowIso,
      // BUG-2: the tab counts down to this and shows an explicit ended state.
      // The server enforces the same window independently (resolveCaller), so
      // a tampered client buys nothing.
      sessionExpiresAt,
      // Re-impersonating after expiry needs a NEW grant, which only the
      // platform-admin console can mint — the tab carries these so it can ask
      // its opener to do so with one click.
      organizationId: grant.organization_id as string,
      targetUserId: grant.target_user_id as string,
    };
  });

/**
 * Called FROM the impersonation tab when the admin clicks "Exit impersonation"
 * (H2). Records a stop event with the session duration into
 * platform_admin_audit, carrying the PLATFORM-ADMIN identity from the grant —
 * not the impersonated user (I7). Authorized by the calling session: the tab is
 * running as the impersonated user, so only that user can end their own grant
 * (target_user_id must match the caller). Idempotent via ended_at so a
 * double-click logs exactly one stop event.
 */
export const endImpersonationSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const nowIso = new Date().toISOString();

    // Atomically mark the grant ended (only if consumed, not already ended, and
    // owned by the calling impersonated session), so a stranger can't end
    // someone else's grant or forge a stop event, and concurrent/duplicate
    // exits produce a single stop event.
    const { data: grant, error } = await supabaseAdmin
      .from("impersonation_grants")
      .update({ ended_at: nowIso })
      .eq("id", data.grantId)
      .eq("target_user_id", context.userId)
      .not("consumed_at", "is", null)
      .is("ended_at", null)
      .select("organization_id, target_user_id, actor_user_id, consumed_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!grant) return { ok: true, alreadyEnded: true };

    let targetEmail: string | null = null;
    try {
      const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(grant.target_user_id);
      targetEmail = userRes?.user?.email ?? null;
    } catch { /* ignore */ }

    const durationSeconds = grant.consumed_at
      ? Math.max(0, Math.round((Date.now() - new Date(grant.consumed_at).getTime()) / 1000))
      : null;

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: grant.actor_user_id,
        organization_id: grant.organization_id,
        action: "stop_impersonation",
        before_json: null,
        after_json: {
          target_user_id: grant.target_user_id,
          target_email: targetEmail,
          duration_seconds: durationSeconds,
        },
      });
    } catch { /* audit best-effort */ }

    return { ok: true, alreadyEnded: false };
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
    const monthStartIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();

    // Platform revenue is SaaS revenue. The trailing-12-month trend + platform
    // AR come from platform_invoices (what HoundStack bills tenants), NOT from
    // the `payments` table (tenant→client collections = GMV). MRR/ARR + the tier
    // breakdown come from the shared subscription-based computation (H5/I13 #19).
    const [saas, invoicesRes, orgsRes, arRes, allOrgsRes] = await Promise.all([
      fetchPlatformSaasMetrics(supabaseAdmin),
      supabaseAdmin
        .from("platform_invoices")
        .select("amount_paid_cents, refunded_cents, created_at, status")
        .gte("created_at", startIso),
      supabaseAdmin
        .from("organizations")
        .select("id, created_at")
        .is("deleted_at", null)
        .gte("created_at", startIso),
      supabaseAdmin
        .from("platform_invoices")
        .select("amount_due_cents, amount_paid_cents")
        .in("status", ["open", "uncollectible"]),
      supabaseAdmin
        .from("organizations")
        .select("id, billing_status")
        .is("deleted_at", null),
    ]);

    if (invoicesRes.error) throw new Error(invoicesRes.error.message);
    if (orgsRes.error) throw new Error(orgsRes.error.message);

    // Build 12 monthly buckets of collected SaaS revenue.
    const buckets = new Map<string, RevenueBucket>();
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { month: key, revenue_cents: 0, payment_count: 0, new_orgs: 0 });
    }
    for (const inv of invoicesRes.data ?? []) {
      const paid = inv.amount_paid_cents ?? 0;
      if (!inv.created_at || paid <= 0) continue;
      const d = new Date(inv.created_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      // Net of refunds, the SAME way `collectedMtdCents` above is. Netting one
      // and not the other is the bug 20260804080000 had to undo on the tenant
      // side: the chart and the headline figure derive the same money two ways
      // and disagree, with no way to tell which is wrong.
      //
      // `payment_count` deliberately still counts it. A payment did happen;
      // refunding it later does not unmake the transaction, and a count that
      // silently drops refunded payments would misstate how many times tenants
      // actually paid.
      if (b) { b.revenue_cents += collectedNetCents(inv); b.payment_count += 1; }
    }
    for (const o of orgsRes.data ?? []) {
      const d = new Date(o.created_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      if (b) b.new_orgs += 1;
    }

    const trailingMonths = Array.from(buckets.values());

    // SaaS collected this month (platform_invoices), separate from recurring MRR.
    //
    // Net of refunds. Stripe leaves `invoice.amount_paid` at its full amount
    // when a charge is refunded — the money coming back is only on the charge —
    // so summing amount_paid alone counts money that was given back, for ever.
    // `refunded_cents` is written by the charge.refunded handler in the
    // platform webhook and is 0 on every row that has never been refunded.
    const collectedMtdCents = (invoicesRes.data ?? [])
      .filter((inv) => inv.created_at && inv.created_at >= monthStartIso)
      .reduce((s, inv) => s + collectedNetCents(inv), 0);

    const ar_open_cents = (arRes.data ?? []).reduce(
      (s, r) => s + Math.max(0, (r.amount_due_cents ?? 0) - (r.amount_paid_cents ?? 0)),
      0,
    );
    const allOrgs = allOrgsRes.data ?? [];
    const total_orgs = allOrgs.length;
    const paying_orgs = allOrgs.filter(
      (o) => o.billing_status === "active" || o.billing_status === "past_due" || o.billing_status === "grace",
    ).length;

    return {
      months: trailingMonths,
      // Top orgs by recurring SaaS contribution (their monthly plan price), NOT
      // by how much they collect from their own clients.
      topOrgs: saas.perOrg.slice(0, 5).map((o) => ({ id: o.id, name: o.name, revenue_cents: o.mrr_cents })),
      mrrCents: saas.mrrCents,
      // BUG-11: MRR now includes recurring add-ons. The split rides along so
      // the console can show where the number comes from — an MRR that jumped
      // with no explanation would just be a different kind of wrong.
      planMrrCents: saas.planMrrCents,
      addonMrrCents: saas.addonMrrCents,
      arrEstimateCents: saas.arrCents,
      collectedMtdCents,
      arOpenCents: ar_open_cents,
      totalOrgs: total_orgs,
      payingOrgs: paying_orgs,
      byTier: saas.byTier.map((t) => ({ tier: t.tier_name, revenue_cents: t.mrr_cents })),
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

    const [openInvRes, overdueRes, stuckVisitsRes, suppressedRes, aiErrRes, aiTotalRes, recentAuditRes] =
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
    const admin_actions_24h = recentAuditRes.count ?? 0;

    // TRIALS ABOUT TO EXPIRE, and what that already costs them.
    //
    // This is on the health page because expiry is not the inert state the
    // in-app banner implies. `org_can_add_client` returns false the moment
    // `trial_ends_at` passes -- the `clients_enforce_plan_limit` trigger on
    // public.clients has been live since 20260701164146 -- so an expired trial
    // loses the ability to take on a new customer, and loses AI via
    // aiAvailableFor. Neither depends on TRIAL_ENFORCEMENT, and the
    // TRIAL_ENFORCEMENT_FROM grandfather clause does not reach the trigger.
    //
    // The trial-expiry email exists as of 2026-08-20 (trial-expiry-emails.server.ts,
    // run by the nightly hook), but Stripe still cannot send it: `trial_ending`
    // comes from customer.subscription.trial_will_end, which never fires for an
    // app-side trial with no Stripe subscription. So the only thing standing
    // between a silent sender and a customer discovering the expiry themselves
    // is this card reporting whether the notice actually went out.
    const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const expiringRes = await supabaseAdmin
      .from("organizations")
      .select("id, name, trial_ends_at, contact_email")
      .eq("plan_status", "trialing")
      .is("deleted_at", null)
      .not("trial_ends_at", "is", null)
      .lte("trial_ends_at", in14Days)
      .order("trial_ends_at", { ascending: true });
    const expiring = (expiringRes.data ?? []) as Array<{
      id: string;
      name: string | null;
      trial_ends_at: string | null;
      contact_email: string | null;
    }>;
    // Did the notice actually go out? The card used to say a trial was
    // expiring and nothing about whether we had told anyone, which is the half
    // an operator can act on. Looked up per candidate rather than as a count,
    // because "one expiring, notice sent" and "one expiring, notice never
    // sent" are the two states worth telling apart.
    // Imported rather than restated: a card that measures a different window or
    // a different template name than the sender uses is reporting on a
    // different question and will be confidently wrong.
    const { TRIAL_NOTICE_DAYS_BEFORE, TRIAL_NOTICE_TEMPLATE } = await import(
      "@/lib/trial-expiry-emails.server"
    );
    const expiringIds = expiring.map((o) => o.id);
    let noticed = new Set<string>();
    if (expiringIds.length) {
      const { data: sent } = await supabaseAdmin
        .from("email_send_log")
        .select("recipient_email, created_at, template_name")
        .eq("template_name", TRIAL_NOTICE_TEMPLATE)
        // A row the sender marked `failed` is a send that never reached the
        // queue. Counting it as notified would turn the one card that can see
        // a broken sender green precisely when the sender is broken.
        .neq("status", "failed")
        .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      // The log has no organization_id column, so match on the addresses those
      // orgs would have been mailed at. Contact address first, owner login
      // second — the same order the sender resolves in, because matching on a
      // different rule than the sender used would report the wrong answer.
      const addrs = new Map<string, string>();
      for (const o of expiring) {
        if (o.contact_email) addrs.set(String(o.contact_email).toLowerCase(), o.id);
      }
      const missing = expiring.filter((o) => !o.contact_email);
      for (const o of missing) {
        const { data: owner } = await supabaseAdmin
          .from("user_roles")
          .select("user_id")
          .eq("organization_id", o.id)
          .eq("role", "owner")
          .limit(1)
          .maybeSingle();
        if (owner?.user_id) {
          try {
            const { data: u } = await supabaseAdmin.auth.admin.getUserById(owner.user_id);
            if (u?.user?.email) addrs.set(String(u.user.email).toLowerCase(), o.id);
          } catch {
            /* unreadable owner: the org simply shows as un-noticed */
          }
        }
      }
      for (const row of (sent ?? []) as Array<{ recipient_email: string }>) {
        const orgId = addrs.get(String(row.recipient_email).toLowerCase());
        if (orgId) noticed.add(orgId);
      }
    }

    const nowIso = new Date().toISOString();
    const trials_expiring_14d = expiring.filter((o) => (o.trial_ends_at ?? "") > nowIso).length;
    const trials_already_expired = expiring.filter((o) => (o.trial_ends_at ?? "") <= nowIso).length;

    // "Not notified" is only a fault for a trial the sender was DUE to mail.
    // sendTrialExpiryNotices fires inside TRIAL_NOTICE_DAYS_BEFORE of the end
    // date; a trial ten days out is correctly un-emailed and reporting it as a
    // miss would put this card in the red for a week over nothing, which is
    // how an operator learns to stop reading it. Already-expired trials stay
    // in the due set on purpose: those the sender genuinely missed, and it can
    // never catch up on them, so they are the one case worth a permanent red.
    const noticeDueBy = new Date(
      Date.now() + TRIAL_NOTICE_DAYS_BEFORE * 24 * 60 * 60 * 1000,
    ).toISOString();
    const due = expiring.filter((o) => (o.trial_ends_at ?? "") <= noticeDueBy);
    const next_trial_expiry = expiring.find((o) => (o.trial_ends_at ?? "") > nowIso) ?? null;

    return {
      trials_expiring_14d,
      trials_already_expired,
      /** Expiring trials the sender is due to have mailed by now. */
      trials_notice_due: due.length,
      /** Of those due, how many have actually been emailed. */
      trials_notified: due.filter((o) => noticed.has(o.id)).length,
      /** Of those due, how many the sender has not mailed. This is the fault. */
      trials_not_notified: due.filter((o) => !noticed.has(o.id)).length,
      next_trial_expiry_at: next_trial_expiry?.trial_ends_at ?? null,
      next_trial_expiry_org: next_trial_expiry?.name ?? null,
      open_invoices_count,
      open_invoices_total,
      overdue_invoices_count,
      overdue_invoices_total,
      stuck_visits,
      suppressed_emails,
      ai_errors_24h,
      ai_calls_24h,
      admin_actions_24h,
    };
  });

export type PlatformAuditRow = {
  id: string;
  actor_user_id: string | null;
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
      // Null on a webhook-written row; the label falls back in the UI.
      actor_email: r.actor_user_id ? (actorEmailsMap.get(r.actor_user_id) ?? null) : null,
      organization_id: r.organization_id,
      organization_name: r.organization_id ? orgNames.get(r.organization_id) ?? null : null,
      action: r.action,
      before_json: r.before_json,
      after_json: r.after_json,
      created_at: r.created_at,
    }));

    return { rows };
  });

// ---------- Plan creation + Stripe mirroring (platform admin → Plans page) ----------
//
// ── WHAT WAS MISSING, AND WHAT THE SCREEN SAID ────────────────────────────
//
// `platform_plans` has had INSERT and DELETE policies for platform admins since
// 20260810120000, and `updatePlatformPlan` for editing one. There was no way to
// CREATE one — no server function, no form — while the Plans page said "Stripe
// products/prices are mirrored from here once the platform Stripe key is set",
// which was true of nothing: no path in this repo has ever created a Stripe
// product or price for a plan. (`platform-addons.functions.ts` does it for
// ADD-ONS, which is where the sentence presumably came from.)
//
// ── WHY THE ROW IS WRITTEN FIRST, AND WRITTEN OFF SALE ────────────────────
//
// Two systems have to agree and there is no transaction across them, so the
// question is not "how do we avoid a half state" — it is "which half state is
// survivable". They are not symmetric:
//
//   * A plan row with no Stripe price, ON SALE, is the bad one. It appears in
//     `listPlatformPlans` (which does not filter on price ids) and is then
//     rejected by `createPlanSubscription` (which does), so a tenant picks it
//     and is told "That plan isn't available. Contact support."
//   * A plan row with no Stripe price, OFF SALE, is inert. It is not in any
//     picker, `assign_billing_tier_for_org` skips it (`is_active = true` is the
//     first thing that predicate asks), and the console shows it as not
//     mirrored with a button to try again.
//   * Stripe objects with no plan row bill nobody — a price only charges
//     through a subscription — and they are re-adopted by name on the retry
//     rather than duplicated, because every price is minted with its
//     `lookup_key`.
//
// So: insert inactive, mirror, write the ids back, and leave putting it on sale
// to the existing "Offer again" action, which already states the blast radius.
// Nothing here can move a tenant onto a plan or bill anybody.

const createPlatformPlanSchema = z.object({
  name: z.string().trim().min(1, "Name can't be empty").max(100),
  slug: z.string().trim().min(1, "Slug can't be empty").max(60),
  description: z.string().max(1000).nullable().optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  isEnterprise: z.boolean().optional(),
  // What the plan UNLOCKS, as opposed to what it costs. Required, and not
  // defaulted anywhere on the way to the column: a plan that does not say
  // resolves to the cheapest tier for everyone who buys it, silently. Checked
  // by planTierDeclarationProblem below, then written to
  // platform_plans.entitlement_tier, which is NOT NULL with no default.
  entitlementTier: z.string().trim().min(1, "Choose what this plan unlocks"),
  // MONTHLY base. Never annual dollars — same contract as updatePlatformPlan.
  priceCents: z.number().int().min(0, "Price must be >= 0").nullable().optional(),
  annualPriceCents: z.number().int().min(0, "Price must be >= 0").nullable().optional(),
  includedSeats: z.number().int().min(0).nullable().optional(),
  pricePerSeatCents: z.number().int().min(0, "Price must be >= 0").nullable().optional(),
  interval: z.enum(["month", "year"]).optional(),
  sortOrder: z.number().int().optional(),
  aiActionsIncluded: z.number().int().min(0).nullable().optional(),
  aiOverageCentsPerAction: z.number().int().min(0).nullable().optional(),
});

export type PlanMirrorReport = {
  mirrored: boolean;
  /** Present when mirroring could not run or refused. Never thrown past the
   *  plan row's own creation: the row exists, and saying "it failed" about a
   *  thing that succeeded is its own bug. */
  problem: string | null;
  productId: string | null;
  created: string[];
  reused: string[];
  skipped: Array<{ kind: string; reason: string }>;
};

/**
 * Mirror one plan row into whichever Stripe account STRIPE_SECRET_KEY names,
 * then write back the ids for the columns that are still EMPTY.
 *
 * Only empty columns. The add-on path learned this the hard way and says so:
 * a write-back that overwrites is how a live price id gets replaced by a test
 * one, and the symptom is a subscription created against the wrong account.
 */
async function mirrorPlanAndRecord(
  supabaseAdmin: any,
  planId: string,
  actorUserId: string,
): Promise<PlanMirrorReport> {
  const empty: PlanMirrorReport = {
    mirrored: false,
    problem: null,
    productId: null,
    created: [],
    reused: [],
    skipped: [],
  };

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return {
      ...empty,
      problem:
        "STRIPE_SECRET_KEY is not set on this deployment, so nothing was created in Stripe. The plan " +
        "is saved and off sale; mirror it once the key is set.",
    };
  }

  const { data: plan, error: planErr } = await supabaseAdmin
    .from("platform_plans")
    .select(
      "id, name, slug, description, currency, is_enterprise, price_cents, annual_price_cents, " +
        "included_seats, price_per_seat_cents, stripe_product_id, stripe_price_id, " +
        "stripe_annual_price_id, stripe_seat_price_id, stripe_annual_seat_price_id",
    )
    .eq("id", planId)
    .maybeSingle();
  if (planErr) return { ...empty, problem: planErr.message };
  if (!plan) return { ...empty, problem: "Plan not found." };

  const { makeStripe } = await import("@/lib/stripe-client.server");
  const { mirrorPlanToStripe, PlanMirrorRefusal } = await import(
    "@/lib/platform-plan-stripe.server"
  );

  let outcome;
  try {
    outcome = await mirrorPlanToStripe(await makeStripe(secret), plan);
  } catch (e: any) {
    // A refusal is a sentence written for the person reading it; anything else
    // is Stripe's own message, which is still better than "something failed".
    const problem = e instanceof PlanMirrorRefusal ? e.message : (e?.message ?? String(e));
    console.error(`plan mirror failed for ${plan.slug}`, problem);
    return { ...empty, problem };
  }

  const patch: Record<string, unknown> = {};
  if (outcome.productId && !plan.stripe_product_id) patch.stripe_product_id = outcome.productId;
  for (const [column, priceId] of Object.entries(outcome.priceIdByColumn)) {
    if (!(plan as Record<string, unknown>)[column]) patch[column] = priceId;
  }

  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("platform_plans")
      .update(patch as any)
      .eq("id", planId);
    if (error) {
      // The Stripe half stands and the database half did not. Say exactly that:
      // the objects exist, they carry their lookup keys, and running this again
      // adopts them by name instead of minting a second set.
      console.error(`plan ${plan.slug}: stripe objects created but ids not saved`, error.message);
      return {
        ...empty,
        productId: outcome.productId,
        created: outcome.created,
        reused: outcome.reused,
        skipped: outcome.skipped,
        problem:
          `The Stripe product and prices for ${plan.slug} were created, but saving their ids failed ` +
          `(${error.message}). Nothing is billing from them. Use “Mirror to Stripe” again — the ` +
          `prices carry their lookup keys, so the retry adopts the same ones rather than making more.`,
      };
    }
  }

  try {
    await supabaseAdmin.from("platform_admin_audit").insert({
      actor_user_id: actorUserId,
      organization_id: null,
      action: "mirror_plan_to_stripe",
      before_json: { id: planId, slug: plan.slug },
      after_json: {
        product_id: outcome.productId,
        created: outcome.created,
        reused: outcome.reused,
        skipped: outcome.skipped,
        ...patch,
      },
    });
  } catch { /* audit best-effort */ }

  return {
    mirrored: outcome.created.length > 0 || outcome.reused.length > 0,
    problem: null,
    productId: outcome.productId,
    created: outcome.created,
    reused: outcome.reused,
    skipped: outcome.skipped,
  };
}

/**
 * Is a platform Stripe key configured, and which account does it point at?
 *
 * The Plans page asks so it can say what will happen BEFORE the person fills in
 * a form — "created off sale and not mirrored" is a fine outcome to choose and a
 * poor one to discover. The mode matters as much as the presence: mirroring a
 * plan into the sandbox while believing it went live is a catalog that looks
 * complete and sells nothing.
 */
export const getPlatformStripeConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const secret = process.env.STRIPE_SECRET_KEY ?? "";
    // The same rule check-stripe-catalog.mjs uses: `sk_live_…` / `rk_live_…`.
    const mode = !secret ? null : /^[a-z]k_live_/.test(secret) ? "live" : "test";
    return { stripeConfigured: !!secret, mode };
  });

export const createPlatformPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createPlatformPlanSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { normalizePlanSlug, planShapeProblem, planSlugProblem, PLATFORM_CATALOG_CURRENCY } =
      await import("@/lib/platform-plan-catalog");

    const slug = normalizePlanSlug(data.slug);
    const currency = (data.currency ?? PLATFORM_CATALOG_CURRENCY).toLowerCase();
    const isEnterprise = data.isEnterprise ?? false;
    const interval = data.interval ?? "month";
    const priceCents = data.priceCents ?? null;
    const annualPriceCents = data.annualPriceCents ?? null;
    const includedSeats = data.includedSeats ?? null;
    const pricePerSeatCents = data.pricePerSeatCents ?? null;

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("platform_plans")
      .select("slug, sort_order");
    if (existingErr) throw new Error(existingErr.message);

    const slugProblem = planSlugProblem(
      slug,
      (existing ?? []).map((p: { slug: string }) => p.slug),
    );
    if (slugProblem) throw new Error(slugProblem);

    const shapeProblem = planShapeProblem({
      slug,
      currency,
      isEnterprise,
      priceCents,
      annualPriceCents,
      includedSeats,
      pricePerSeatCents,
      interval,
    });
    if (shapeProblem) throw new Error(shapeProblem);

    // The plan's own declaration of what it unlocks has to be one the running
    // app can actually serve — see planTierDeclarationProblem. Refusing here is
    // the whole point: an unrecognised slug used to sail through and hand every
    // one of that plan's customers the floor tier.
    const tierProblem = planTierDeclarationProblem(slug, data.entitlementTier);
    if (tierProblem) throw new Error(tierProblem);

    const sortOrder =
      data.sortOrder ??
      Math.max(0, ...(existing ?? []).map((p: { sort_order: number }) => p.sort_order ?? 0)) + 10;

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("platform_plans")
      .insert({
        name: data.name,
        slug,
        description: data.description ?? null,
        currency,
        interval,
        is_enterprise: isEnterprise,
        entitlement_tier: data.entitlementTier,
        price_cents: priceCents,
        annual_price_cents: annualPriceCents,
        included_seats: includedSeats,
        price_per_seat_cents: pricePerSeatCents,
        ai_actions_included: data.aiActionsIncluded ?? null,
        ai_overage_cents_per_action: data.aiOverageCentsPerAction ?? null,
        // The per-employee catalog does not use client bands: every live plan
        // carries 0/NULL and `assign_billing_tier_for_org` selects on
        // `included_seats`, not on these. NOT NULL with no default, so it has
        // to be written, and 0/NULL is the value that means "no band".
        client_limit_min: 0,
        client_limit_max: null,
        sort_order: sortOrder,
        // Always. See the section header: an unmirrored plan on sale is the one
        // half-state that reaches a customer.
        is_active: false,
      } as any)
      .select("id, slug, name")
      .maybeSingle();
    if (insErr) {
      // A duplicate slug can still land here if another admin created the same
      // one between the check above and this insert.
      if ((insErr as any).code === "23505") {
        throw new Error(`The slug “${slug}” is already used by another plan.`);
      }
      throw new Error(insErr.message);
    }
    if (!inserted) throw new Error("The plan could not be created.");

    try {
      await supabaseAdmin.from("platform_admin_audit").insert({
        actor_user_id: context.userId,
        organization_id: null,
        action: "create_plan",
        before_json: null,
        after_json: {
          id: inserted.id,
          slug,
          name: data.name,
          is_active: false,
          entitlement_tier: data.entitlementTier,
        },
      });
    } catch { /* audit best-effort */ }

    const mirror = await mirrorPlanAndRecord(supabaseAdmin, inserted.id, context.userId);
    return { planId: inserted.id as string, slug, name: inserted.name as string, mirror };
  });

/**
 * Mirror an existing plan that has no Stripe prices yet — the retry for every
 * way the second half can fail, and the path for a plan drafted before the
 * Stripe key was configured.
 *
 * Deliberately NOT an update: it fills empty columns and adopts prices by name.
 * Re-pricing a plan that tenants are already subscribed to is a different
 * decision with a different blast radius, and this is not it.
 */
export const mirrorPlatformPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ planId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mirror = await mirrorPlanAndRecord(supabaseAdmin, data.planId, context.userId);
    if (mirror.problem) throw new Error(mirror.problem);
    return mirror;
  });
