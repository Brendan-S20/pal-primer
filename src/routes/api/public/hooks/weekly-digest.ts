import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/weekly-digest
// Iterates orgs with notify_email_weekly_digest=true and digest_recipient_email set,
// computes the past week's metrics, asks Lovable AI for insights, and enqueues the
// digest email. Idempotency is per-org-per-week via last_digest_sent_at (skips if
// a digest was already sent in the past 6 days).

export const Route = createFileRoute("/api/public/hooks/weekly-digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        const providedApiKey = request.headers.get("apikey");
        if (!anonKey || providedApiKey !== anonKey) {
          return json({ error: "unauthorized" }, 401);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { computeDigestMetrics, generateDigestInsights, sendDigestEmail } = await import(
          "@/lib/digest.server"
        );

        const { data: orgs, error } = await supabaseAdmin
          .from("organizations")
          .select(
            "id, name, notify_email_weekly_digest, digest_recipient_email, last_digest_sent_at",
          )
          .eq("notify_email_weekly_digest", true)
          .not("digest_recipient_email", "is", null);
        if (error) return json({ error: error.message }, 500);

        const now = Date.now();
        const results: Array<Record<string, unknown>> = [];
        for (const org of orgs ?? []) {
          const perOrg: Record<string, unknown> = { org: (org as any).name, id: (org as any).id };
          try {
            const last = (org as any).last_digest_sent_at
              ? new Date((org as any).last_digest_sent_at).getTime()
              : 0;
            if (last && now - last < 6 * 86_400_000) {
              perOrg.skipped = "recent_digest";
              results.push(perOrg);
              continue;
            }
            const metrics = await computeDigestMetrics((org as any).id);
            if (!metrics) {
              perOrg.error = "no_metrics";
              results.push(perOrg);
              continue;
            }
            const insights = await generateDigestInsights(metrics);
            const res = await sendDigestEmail({
              orgId: (org as any).id,
              recipient: (org as any).digest_recipient_email,
              metrics,
              insights,
            });
            perOrg.ok = res.ok;
            if (!res.ok) perOrg.reason = res.reason;
          } catch (e: any) {
            perOrg.error = String(e?.message ?? e);
          }
          results.push(perOrg);
        }

        return json({ ok: true, ran_at: new Date().toISOString(), orgs: results });
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
