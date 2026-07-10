import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Tenant Stripe Connect (OAuth) management. Connecting a Stripe account to
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

/** Begin the Connect OAuth flow; returns an authorize URL to redirect to. */
export const startStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ origin: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { connectClientId } = await import("@/lib/stripe-connect.server");
    const clientId = connectClientId();

    const crypto = await import("node:crypto");
    const state = crypto.randomBytes(24).toString("hex");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("oauth_states").insert({
      state,
      org_id: orgId,
      provider: "stripe_connect",
      redirect_to: `${data.origin}/settings/payments`,
    });
    if (error) throw new Error(error.message);

    const redirectUri = `${data.origin}/api/public/hooks/stripe-connect-callback`;
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", "read_write");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return { url: url.toString() };
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

/** Deauthorize the connected account and clear the org's Connect fields. */
export const disconnectStripeConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { resolveOrgStripeAccount, connectStripe, connectClientId } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(orgId);
    if (acct) {
      try {
        const stripe = await connectStripe();
        await stripe.oauth.deauthorize({ client_id: connectClientId(), stripe_user_id: acct.accountId });
      } catch (e) {
        console.error("stripe connect deauthorize failed", (e as Error).message);
      }
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as any).from("organizations").update({
      stripe_connect_account_id: null,
      stripe_connect_status: "disconnected",
      stripe_connect_charges_enabled: false,
      stripe_connect_connected_at: null,
    }).eq("id", orgId);
    return { ok: true };
  });
