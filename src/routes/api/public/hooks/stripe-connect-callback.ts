import { createFileRoute } from "@tanstack/react-router";

// Stripe Connect OAuth callback. Exchanges the authorization code for the
// tenant's connected account id (stripe_user_id) and stores it on the org.
export const Route = createFileRoute("/api/public/hooks/stripe-connect-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        if (oauthError) return html(`Stripe returned an error: ${escapeHtml(oauthError)}`);
        if (!code || !state) return html("Missing code or state.");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: st } = await supabaseAdmin
          .from("oauth_states")
          .select("org_id, provider, redirect_to, expires_at")
          .eq("state", state)
          .maybeSingle();
        if (!st || st.provider !== "stripe_connect") return html("Invalid or expired connect link.");
        if (st.expires_at && new Date(st.expires_at as string) < new Date()) {
          await supabaseAdmin.from("oauth_states").delete().eq("state", state);
          return html("Connect flow expired. Please try again.");
        }

        try {
          const { connectStripe, fetchConnectAccountState } = await import("@/lib/stripe-connect.server");
          const stripe = await connectStripe();
          const token = await stripe.oauth.token({ grant_type: "authorization_code", code });
          const accountId = token.stripe_user_id;
          if (!accountId) return html("Stripe did not return a connected account.");

          let chargesEnabled = false;
          let status = "pending";
          try {
            const s = await fetchConnectAccountState(accountId);
            chargesEnabled = s.chargesEnabled;
            status = s.status;
          } catch {
            /* account retrieve can lag OAuth; refresh in Settings → Payments */
          }

          // If this connects a DIFFERENT account than before, saved client cards
          // (on the old account) are now invalid — clear them so they re-save.
          const { data: prev } = await (supabaseAdmin as any)
            .from("organizations")
            .select("stripe_connect_account_id")
            .eq("id", st.org_id)
            .maybeSingle();
          const changed = prev?.stripe_connect_account_id && prev.stripe_connect_account_id !== accountId;

          await (supabaseAdmin as any).from("organizations").update({
            stripe_connect_account_id: accountId,
            stripe_connect_status: status,
            stripe_connect_charges_enabled: chargesEnabled,
            stripe_connect_connected_at: new Date().toISOString(),
          }).eq("id", st.org_id);

          if (changed) {
            const { clearOrgClientStripeRefs } = await import("@/lib/stripe-connect.server");
            await clearOrgClientStripeRefs(st.org_id as string);
          }

          await supabaseAdmin.from("oauth_states").delete().eq("state", state);

          const dest = (st.redirect_to as string) || "/settings/payments";
          return new Response(null, { status: 302, headers: { Location: `${dest}?connected=1` } });
        } catch (e) {
          console.error("stripe-connect-callback failed", (e as Error).message);
          return html("Couldn't complete the Stripe connection. Please try again.");
        }
      },
    },
  },
});

function html(message: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
      `<h1 style="font-size:1.1rem">Stripe connection</h1><p>${message}</p>` +
      `<p><a href="/settings/payments">Back to Payments settings</a></p></body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
