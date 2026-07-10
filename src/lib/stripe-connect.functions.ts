import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Tenant Stripe Connect (Express) management. Connecting a Stripe account to
// charge the org's own clients is an admin/settings action → manage_settings.

export const getStripeConnectStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("organizations")
      .select("stripe_connect_account_id, stripe_connect_status, stripe_connect_charges_enabled, stripe_connect_connected_at")
      .eq("id", orgId)
      .maybeSingle();
    return {
      connected: !!data?.stripe_connect_account_id,
      accountId: (data?.stripe_connect_account_id as string) ?? null,
      status: (data?.stripe_connect_status as string) ?? null,
      chargesEnabled: !!data?.stripe_connect_charges_enabled,
      connectedAt: (data?.stripe_connect_connected_at as string) ?? null,
    };
  });

/**
 * Begin (or resume) Express onboarding. Creates the connected account on first
 * use, then returns a Stripe-hosted Account Link URL to redirect to. Safe to
 * call again to refresh an expired link — the account is reused.
 */
export const startStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { data: userData } = await context.supabase.auth.getUser();
    const email = userData.user?.email ?? undefined;

    const { ensureExpressAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const accountId = await ensureExpressAccount(orgId, email);
    const stripe = await connectStripe();
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${data.origin}/settings/payments?stripe_refresh=1`,
      return_url: `${data.origin}/settings/payments?connected=1`,
      type: "account_onboarding",
    });
    return { url: link.url };
  });

/** Re-check the connected account's charge-readiness with Stripe. */
export const refreshStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { resolveOrgStripeAccount, fetchConnectAccountState } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (!acct) return { connected: false, chargesEnabled: false, status: null as string | null };
    const state = await fetchConnectAccountState(acct.accountId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("organizations").update({
      stripe_connect_charges_enabled: state.chargesEnabled,
      stripe_connect_status: state.status,
    }).eq("id", orgId);
    return { connected: true, chargesEnabled: state.chargesEnabled, status: state.status };
  });

/** Delete the Express account (platform-owned) and clear the org's fields. */
export const disconnectStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { resolveOrgStripeAccount, connectStripe, clearOrgClientStripeRefs } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (acct) {
      try {
        const stripe = await connectStripe();
        await stripe.accounts.del(acct.accountId);
      } catch (e) {
        // Express accounts with a balance / activity can't be deleted; we still
        // drop our reference so the org can reconnect a fresh account.
        console.error("stripe express account delete failed", (e as Error).message);
      }
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("organizations").update({
      stripe_connect_account_id: null,
      stripe_connect_status: "disconnected",
      stripe_connect_charges_enabled: false,
      stripe_connect_connected_at: null,
    }).eq("id", orgId);
    await clearOrgClientStripeRefs(orgId);
    return { ok: true };
  });
