import { createFileRoute } from "@tanstack/react-router";

/**
 * QuickBooks Online OAuth callback: the Redirect URI registered on the Intuit
 * app (https://app.houndstack.com/api/public/hooks/qbo-callback). Verifies the
 * single-use CSRF state, exchanges the code at the token endpoint from
 * Intuit's discovery document, stores the tokens encrypted, and sends the
 * browser back to Settings → Accounting. The logic is in
 * src/lib/qbo-callback.server.ts.
 */
export const Route = createFileRoute("/api/public/hooks/qbo-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleQboCallback } = await import("@/lib/qbo-callback.server");
        const { qboCredentials } = await import("@/lib/qbo-config.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { saveQboGrant, oauthDeps } = await import("@/lib/qbo-connection.server");
        const { exchangeQboCode } = await import("@/lib/qbo-oauth.server");
        return handleQboCallback(request.url, {
          now: Date.now,
          configured: qboCredentials() !== null,
          consumeState: async (state) => {
            const { data } = await supabaseAdmin
              .from("oauth_states")
              .delete()
              .eq("state", state)
              .select("org_id, provider, expires_at")
              .maybeSingle();
            return data ?? null;
          },
          exchange: (p) => exchangeQboCode(p, oauthDeps()),
          saveGrant: saveQboGrant,
        });
      },
    },
  },
});
