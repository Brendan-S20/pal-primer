import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/announcement-emails?s=<CRON_SECRET>
//
// The sweep: sends every platform announcement that is marked send_email, has
// not been emailed, and is inside its active window.
//
// NOTHING SCHEDULES THIS. That is deliberate rather than an oversight —
// scheduling platform-wide outbound email is the owner's decision, and a cron
// that mails every tenant whenever somebody ticks a checkbox is a foot-gun. The
// endpoint is kept because it is the shape a scheduler needs when the owner
// wants one; until then a platform admin sends each announcement deliberately
// from /platform/announcements.
//
// The 120 lines that used to live here are in lib/announcement-emails.server so
// both callers run exactly the same send — including the same per-recipient
// idempotency key, which is what makes a human and a future scheduler safe to
// have at once.

export const Route = createFileRoute("/api/public/hooks/announcement-emails")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Was CRON_SECRET *or* the public anon key, which made the second half
        // of that "or" the whole security of platform-wide outbound email. See
        // cron-auth.server.ts.
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("announcement-emails", auth);

        try {
          const { sendPendingAnnouncementEmails } = await import(
            "@/lib/announcement-emails.server"
          );
          const result = await sendPendingAnnouncementEmails();
          return json({ ok: true, ...result });
        } catch (e) {
          // See the same call in hooks/stripe.ts.
          const { reportServerError } = await import("@/lib/monitoring/report.server");
          await reportServerError(e, {
            request,
            force: true,
            tags: { hook: "announcement-emails" },
          });
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
