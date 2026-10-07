import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/late-check
//
// The periodic late check: a truck stuck at one long stop with location
// sharing off sends no GPS ping and finishes no stop, so neither of the other
// two late triggers fires. pg_cron's `late-check` job calls this every five
// minutes, and only when some open stop's arrival window is near: the job's
// command asks public.late_check_due() first, so a night or an empty day costs
// no HTTP at all (see 20261007160000). Same credential as the other cron
// endpoints, Bearer service-role read from Vault.
//
// Working hours are decided HERE, per organization, on that organization's
// own clock, not in the cron expression: one schedule serves every timezone.
// The rules and the arithmetic are checkStuckTrucks in field-notify.server.ts.

export const Route = createFileRoute("/api/public/hooks/late-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("late-check", auth);

        const { checkStuckTrucks } = await import("@/lib/field-notify.server");
        try {
          // Counts only: this response lands in net._http_response, and a
          // tech's name or a customer's address has no business there.
          const summary = await checkStuckTrucks();
          return json({ ok: true, ran_at: new Date().toISOString(), ...summary });
        } catch (e) {
          console.error("late-check failed", (e as Error).message);
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
