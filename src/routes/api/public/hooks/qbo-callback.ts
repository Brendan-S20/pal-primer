import { createFileRoute } from "@tanstack/react-router";

/**
 * QuickBooks Online OAuth callback.
 * Exchanges the authorization code for tokens and persists the connection
 * for the org that started the flow.
 */
export const Route = createFileRoute("/api/public/hooks/qbo-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const realmId = url.searchParams.get("realmId");
        const error = url.searchParams.get("error");

        if (error) return html(`QuickBooks returned an error: ${escape(error)}`, false);
        if (!code || !state || !realmId) return html("Missing code, state, or realmId", false);

        const clientId = process.env.QBO_CLIENT_ID;
        const clientSecret = process.env.QBO_CLIENT_SECRET;
        if (!clientId || !clientSecret) return html("QBO_CLIENT_ID / QBO_CLIENT_SECRET not configured", false);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: st, error: stErr } = await supabaseAdmin
          .from("oauth_states")
          .select("org_id, provider, redirect_to, expires_at")
          .eq("state", state)
          .maybeSingle();
        if (stErr || !st) return html("Invalid or expired state.", false);
        if (st.provider !== "quickbooks") return html("Provider mismatch.", false);
        if (new Date(st.expires_at as string) < new Date()) {
          await supabaseAdmin.from("oauth_states").delete().eq("state", state);
          return html("Connect flow expired. Please try again.", false);
        }

        const redirectUri = `${url.origin}/api/public/hooks/qbo-callback`;
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) {
          const t = await tokenRes.text();
          console.error("QBO token exchange failed", tokenRes.status, t);
          return html(`Token exchange failed: ${tokenRes.status}`, false);
        }
        const tok = (await tokenRes.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
          x_refresh_token_expires_in?: number;
        };
        const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();

        const { data: existing } = await supabaseAdmin
          .from("accounting_connections")
          .select("id")
          .eq("org_id", st.org_id)
          .eq("provider", "quickbooks")
          .maybeSingle();

        const payload = {
          org_id: st.org_id,
          provider: "quickbooks",
          realm_id: realmId,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          token_expires_at: expiresAt,
          connected_at: new Date().toISOString(),
        };
        if (existing?.id) {
          await supabaseAdmin.from("accounting_connections").update(payload).eq("id", existing.id);
        } else {
          await supabaseAdmin.from("accounting_connections").insert(payload);
        }
        await supabaseAdmin.from("oauth_states").delete().eq("state", state);

        const redirect = (st.redirect_to as string) ?? "/settings/accounting";
        return Response.redirect(redirect + "?connected=quickbooks", 302);
      },
    },
  },
});

function html(msg: string, ok: boolean) {
  const status = ok ? 200 : 400;
  return new Response(
    `<!doctype html><meta charset=utf-8><title>QuickBooks connect</title>
     <div style="font-family:system-ui;padding:2rem;max-width:520px;margin:auto">
       <h1>${ok ? "Connected" : "Connect failed"}</h1>
       <p>${msg}</p>
       <p><a href="/settings/accounting">Back to accounting settings</a></p>
     </div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
function escape(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
}
