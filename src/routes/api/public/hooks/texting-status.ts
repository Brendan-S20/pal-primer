import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/texting-status
//
// The status poll for each business's toll-free verification (#538). pg_cron's
// `texting-status` job calls this every ten minutes, and only while some
// registration is with Twilio: the job asks public.texting_status_due() first
// (see 20261029160000). Ten minutes so a change at Twilio is in Settings within
// fifteen. Same credential as the other cron endpoints, Bearer service-role
// read from Vault.
//
// An approval turns that business's texting on (activate_org_texting); a
// rejection emails HoundStack and tells the owner, once.

export const Route = createFileRoute("/api/public/hooks/texting-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("texting-status", auth);

        const { refreshAllTextingStatuses } = await import("@/lib/twilio-provisioning.server");
        try {
          // Counts only: this response lands in net._http_response.
          const counts = await refreshAllTextingStatuses();
          return json({ ok: true, ran_at: new Date().toISOString(), ...counts });
        } catch (e) {
          console.error("texting-status failed", (e as Error).message);
          return json({ ok: false, error: "texting status check failed" }, 500);
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
