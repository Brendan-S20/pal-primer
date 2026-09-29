import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { resolveSupabaseUrl } from "@/lib/supabase-url";

// Two kinds of token arrive here, and both through the same /unsubscribe page.
//
//   email_unsubscribe_tokens    one per ADDRESS, platform-wide. Redeeming it
//                               writes suppressed_emails, which stops every
//                               email to that address from every business.
//   client_unsubscribe_tokens   one per CLIENT, minted for campaign email.
//                               Redeeming it sets email_opt_out on that one
//                               client in that one organization, through
//                               redeem_client_unsubscribe_token, and touches
//                               nothing else. A customer who unsubscribes from
//                               one business's spring promotion still gets
//                               every other business's invoices.
//
// The address-wide table is asked first because it is the older and larger;
// the tokens are 64 random hex characters in both, so they cannot collide.
type ClientTokenState = "ready" | "already" | "invalid";

function redactEmail(email: string | null | undefined): string {
  if (!email) return "***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart[0]}***@${domain}`;
}

export const Route = createFileRoute("/email/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const supabaseUrl = resolveSupabaseUrl();
        const supabaseServiceKey =
          process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseServiceKey) {
          console.error("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY is not set");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Extract token from query params
        const url = new URL(request.url);
        const token = url.searchParams.get("token");

        if (!token) {
          return Response.json({ error: "Token is required" }, { status: 400 });
        }

        // A person, not the page's fetch. A campaign's List-Unsubscribe header
        // points HERE, because this is the URL that answers the RFC 8058
        // one-click POST; a mail client that cannot POST opens it in a browser
        // instead, and a browser should get the confirmation page, not JSON.
        if ((request.headers.get("accept") ?? "").includes("text/html")) {
          return new Response(null, {
            status: 303,
            headers: { Location: `/unsubscribe?token=${encodeURIComponent(token)}` },
          });
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        // Look up the token
        const { data: tokenRecord, error: lookupError } = await supabase
          .from("email_unsubscribe_tokens")
          .select("*")
          .eq("token", token)
          .maybeSingle();

        if (lookupError || !tokenRecord) {
          const { data: state } = await supabase.rpc("client_unsubscribe_token_state", {
            _token: token,
          });
          switch (state as ClientTokenState | null) {
            case "ready":
              return Response.json({ valid: true });
            case "already":
              return Response.json({ valid: false, reason: "already_unsubscribed" });
            default:
              return Response.json({ error: "Invalid or expired token" }, { status: 404 });
          }
        }

        if (tokenRecord.used_at) {
          return Response.json({ valid: false, reason: "already_unsubscribed" });
        }

        return Response.json({ valid: true });
      },

      POST: async ({ request }) => {
        const supabaseUrl = resolveSupabaseUrl();
        const supabaseServiceKey =
          process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseServiceKey) {
          console.error("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY is not set");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Extract token from query params (always present for RFC 8058 one-click)
        const url = new URL(request.url);
        let token: string | null = url.searchParams.get("token");

        // Detect RFC 8058 one-click unsubscribe: POST with form-encoded body
        // containing "List-Unsubscribe=One-Click". Email clients (Gmail, Apple Mail,
        // etc.) send this when the user clicks "Unsubscribe" in the mail UI.
        const contentType = request.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formText = await request.text();
          const params = new URLSearchParams(formText);
          // For one-click, token comes from query param (already set above).
          // Otherwise, token may be in the form body.
          if (!params.get("List-Unsubscribe")) {
            const formToken = params.get("token");
            if (formToken) {
              token = formToken;
            }
          }
        } else {
          // JSON body (from the app's unsubscribe page)
          try {
            const body = await request.json();
            if (body.token) {
              token = body.token;
            }
          } catch {
            // Fall through — token stays from query param
          }
        }

        if (!token) {
          return Response.json({ error: "Token is required" }, { status: 400 });
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        // Look up the token
        const { data: tokenRecord, error: lookupError } = await supabase
          .from("email_unsubscribe_tokens")
          .select("*")
          .eq("token", token)
          .maybeSingle();

        if (lookupError || !tokenRecord) {
          // A campaign's client-scoped token: one client, one organization.
          const { data: outcome, error: redeemError } = await supabase.rpc(
            "redeem_client_unsubscribe_token",
            { _token: token },
          );
          if (redeemError) {
            console.error("Failed to redeem client unsubscribe token", { error: redeemError });
            return Response.json({ error: "Failed to process unsubscribe" }, { status: 500 });
          }
          if (outcome === "unsubscribed") {
            console.log("Client unsubscribed from campaign email");
            return Response.json({ success: true });
          }
          if (outcome === "already") {
            return Response.json({ success: false, reason: "already_unsubscribed" });
          }
          return Response.json({ error: "Invalid or expired token" }, { status: 404 });
        }

        if (tokenRecord.used_at) {
          return Response.json({ success: false, reason: "already_unsubscribed" });
        }

        // Atomic check-and-update to avoid TOCTOU race
        const { data: updated, error: updateError } = await supabase
          .from("email_unsubscribe_tokens")
          .update({ used_at: new Date().toISOString() })
          .eq("token", token)
          .is("used_at", null)
          .select()
          .maybeSingle();

        if (updateError) {
          console.error("Failed to mark token as used", { error: updateError, token });
          return Response.json({ error: "Failed to process unsubscribe" }, { status: 500 });
        }

        if (!updated) {
          return Response.json({ success: false, reason: "already_unsubscribed" });
        }

        // Add email to suppressed list (upsert to handle duplicates)
        const { error: suppressError } = await supabase
          .from("suppressed_emails")
          .upsert(
            { email: tokenRecord.email.toLowerCase(), reason: "unsubscribe" },
            { onConflict: "email" },
          );

        if (suppressError) {
          console.error("Failed to suppress email", {
            error: suppressError,
            email_redacted: redactEmail(tokenRecord.email),
          });
          return Response.json({ error: "Failed to process unsubscribe" }, { status: 500 });
        }

        console.log("Email unsubscribed", {
          email_redacted: redactEmail(tokenRecord.email),
        });

        return Response.json({ success: true });
      },
    },
  },
});
