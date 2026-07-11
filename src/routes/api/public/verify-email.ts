import { createFileRoute } from "@tanstack/react-router";

// GET /api/public/verify-email?token=<uuid>
// Consumes a verification token minted by sendEmailVerification: marks the
// org's email verified (unlocking Stripe Express) and bounces to the app.
export const Route = createFileRoute("/api/public/verify-email")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token");
        const redirect = (path: string) =>
          new Response(null, { status: 302, headers: { Location: path } });
        if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
          return redirect("/dashboard?verify_error=invalid");
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: row } = await (supabaseAdmin as any)
          .from("email_verifications")
          .select("id, organization_id, expires_at, verified_at")
          .eq("token", token)
          .maybeSingle();
        if (!row) return redirect("/dashboard?verify_error=invalid");
        if (row.verified_at) return redirect("/dashboard?verified=1");
        if (new Date(row.expires_at) < new Date()) {
          return redirect("/dashboard?verify_error=expired");
        }

        const nowIso = new Date().toISOString();
        await (supabaseAdmin as any)
          .from("email_verifications")
          .update({ verified_at: nowIso })
          .eq("id", row.id);
        await (supabaseAdmin as any)
          .from("organizations")
          .update({ email_verified_at: nowIso })
          .eq("id", row.organization_id);
        return redirect("/dashboard?verified=1");
      },
    },
  },
});
