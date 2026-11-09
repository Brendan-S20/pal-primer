import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/google-cache-expiry
//
// Once a day, refresh or drop Google-derived data older than 30 days: Google
// Routes drive times in road_legs are deleted, and Google-sourced property
// pins are re-geocoded or cleared. The rule is src/lib/geocode-source.ts; the
// work is src/lib/google-cache-expiry.server.ts; pg_cron's
// `google-cache-expiry` job calls this (20261109200100). Same credential as
// the other cron endpoints: Bearer service-role read from Vault, or
// CRON_SECRET (authorizeCronRequest).

export const Route = createFileRoute("/api/public/hooks/google-cache-expiry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("google-cache-expiry", auth);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { geocodeAddressSourced } = await import("@/lib/geocode.server");
        const { expireGoogleDerivedData } = await import("@/lib/google-cache-expiry.server");
        try {
          // Counts only: this response lands in net._http_response, and an
          // address has no business there.
          const summary = await expireGoogleDerivedData(supabaseAdmin, {
            geocode: geocodeAddressSourced,
          });
          if (summary.errors.length) {
            console.error("google-cache-expiry: errors", summary.errors.slice(0, 20));
          }
          const { errors, ...counts } = summary;
          return json({ ok: errors.length === 0, ran_at: new Date().toISOString(), ...counts });
        } catch (e) {
          console.error("google-cache-expiry failed", (e as Error).message);
          return json({ ok: false, error: (e as Error).message }, 500);
        }
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
