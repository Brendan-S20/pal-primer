import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/webhook-deliveries
//
// The outbound webhook worker. pg_cron's `deliver-webhooks` job calls it once
// a minute, and only when the outbox has something due: the job's command
// selects from webhook_deliveries before it makes the request, so an idle
// minute costs no HTTP at all (see 20260929080000). Same credential as the
// other cron endpoints, Bearer service-role read from Vault.
//
// One run claims up to BATCH_SIZE due deliveries, sends them five at a time
// with a ten second timeout each, and records every result. Retries, the
// schedule, the SSRF re-check and the auto-disable are all in
// src/lib/webhook-delivery.server.ts.

export const Route = createFileRoute("/api/public/hooks/webhook-deliveries")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("webhook-deliveries", auth);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { processWebhookDeliveries, productionWorkerDeps } =
          await import("@/lib/webhook-delivery.server");

        try {
          const summary = await processWebhookDeliveries(
            supabaseAdmin as any,
            await productionWorkerDeps(),
          );
          // Counts only: the per-delivery errors can quote a receiver's
          // response body, and this response lands in net._http_response.
          const { results: _results, ...counts } = summary;
          return json({ ok: true, ran_at: new Date().toISOString(), ...counts });
        } catch (e) {
          console.error("webhook-deliveries failed", (e as Error).message);
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
