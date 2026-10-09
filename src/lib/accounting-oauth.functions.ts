import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { qboRedirectUri, newOAuthState, OAUTH_STATE_TTL_MS } from "@/lib/qbo-redirect";

/**
 * Start connecting QuickBooks Online. Returns Intuit's authorize URL for the
 * browser to go to.
 *
 * CSRF: a random 256-bit `state` is stored in `oauth_states` with the org and
 * a ten-minute expiry. The callback accepts a code only with a state it can
 * find, unexpired, for QuickBooks, and deletes the row as it reads it, so a
 * state works once. `oauth_states` is deny-all to every signed-in user; only
 * the server can read or write it.
 */
export const startAccountingOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        provider: z.literal("quickbooks"),
        origin: z.string().url(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Connecting the books is a settings action: owner and office manager
    // (manage_settings), the same gate as every fn in accounting.functions.ts.
    const orgId = (await requirePermission(supabase, userId, "manage_settings")).orgId;

    const { qboCredentials, qboEnvironment } = await import("@/lib/qbo-config.server");
    const credentials = qboCredentials();
    if (!credentials) {
      // The env var names belong in the server log, not on a user's screen.
      console.error("qbo: the Intuit client id and secret are not configured (see .env.example)");
      throw new Error("QuickBooks isn't set up on this server yet. Contact support.");
    }
    const { appOrigin } = await import("@/lib/app-origin");
    const redirectUri = qboRedirectUri(data.origin, appOrigin());

    const { qboAuthorizeUrl, qboDiscovery } = await import("@/lib/qbo-oauth.server");
    const { realHttpDeps } = await import("@/lib/qbo-http.server");
    const discovery = await qboDiscovery(qboEnvironment(), realHttpDeps());

    const state = newOAuthState();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Old, unused states are swept on the way in.
    await supabaseAdmin.from("oauth_states").delete().lt("expires_at", new Date().toISOString());
    const { error } = await supabaseAdmin.from("oauth_states").insert({
      state,
      org_id: orgId,
      provider: "quickbooks",
      redirect_to: new URL(redirectUri).origin + "/settings/accounting",
      expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    });
    if (error) throw new Error(error.message);

    return { url: qboAuthorizeUrl(discovery, { clientId: credentials.clientId, redirectUri, state }) };
  });
