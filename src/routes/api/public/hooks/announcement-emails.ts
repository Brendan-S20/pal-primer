import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/announcement-emails?s=<CRON_SECRET>
// Cron endpoint that sends outbound email for platform announcements marked
// send_email=true, where email_sent_at is null and the announcement is in
// its active window. Recipients are org contact_email addresses filtered by
// the announcement audience.

export const Route = createFileRoute("/api/public/hooks/announcement-emails")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const cronSecret = process.env.CRON_SECRET;
        const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        const providedSecret =
          request.headers.get("x-cron-secret") ??
          new URL(request.url).searchParams.get("s");
        const providedApiKey = request.headers.get("apikey");
        const okSecret = cronSecret && providedSecret === cronSecret;
        const okAnon = anonKey && providedApiKey === anonKey;
        if (!okSecret && !okAnon) return json({ error: "unauthorized" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = new Date().toISOString();

        const { data: pending, error } = await supabaseAdmin
          .from("platform_announcements")
          .select("id, title, body, severity, audience, starts_at, ends_at, send_email, email_sent_at")
          .eq("send_email", true)
          .is("email_sent_at", null)
          .lte("starts_at", now)
          .limit(50);
        if (error) return json({ error: error.message }, 500);

        const summary: Array<Record<string, unknown>> = [];

        for (const a of pending ?? []) {
          if (a.ends_at && new Date(a.ends_at) <= new Date()) {
            summary.push({ id: a.id, skipped: "expired" });
            continue;
          }

          let orgQ = supabaseAdmin
            .from("organizations")
            .select("id, name, contact_email, plan_status")
            .not("contact_email", "is", null);

          if (["active", "past_due", "canceled", "free"].includes(a.audience)) {
            orgQ = orgQ.eq("plan_status", a.audience as "active" | "past_due" | "canceled" | "free");
          } else if (a.audience === "trialing") {
            orgQ = orgQ.eq("plan_status", "free");
          }
          const { data: orgs } = await orgQ;

          let recipients: Array<{ email: string; org_name: string }> = (orgs ?? [])
            .filter((o) => o.contact_email)
            .map((o) => ({ email: o.contact_email as string, org_name: o.name }));

          // Audience: admins → email platform admins by looking up user_roles.
          if (a.audience === "admins") {
            const { data: admins } = await supabaseAdmin
              .from("user_roles")
              .select("user_id")
              .eq("role", "platform_admin");
            const uids = Array.from(new Set((admins ?? []).map((r) => r.user_id)));
            const emails: Array<{ email: string; org_name: string }> = [];
            for (const uid of uids) {
              try {
                const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
                if (u?.user?.email) emails.push({ email: u.user.email, org_name: "Scoop CRM" });
              } catch { /* ignore */ }
            }
            recipients = emails;
          }

          // Suppression list dedupe.
          const uniq = new Map<string, { email: string; org_name: string }>();
          for (const r of recipients) uniq.set(r.email.toLowerCase(), r);
          const list = Array.from(uniq.values());

          const { data: suppressed } = list.length
            ? await supabaseAdmin
                .from("suppressed_emails")
                .select("email")
                .in("email", list.map((r) => r.email.toLowerCase()))
            : { data: [] as { email: string }[] };
          const suppressedSet = new Set((suppressed ?? []).map((s) => s.email.toLowerCase()));

          const html = renderAnnouncementHtml(a.title, a.body, a.severity);
          const text = `${a.title}\n\n${a.body}`;
          const subject = `[Scoop CRM] ${a.title}`;

          let enqueued = 0;
          for (const r of list) {
            if (suppressedSet.has(r.email.toLowerCase())) continue;
            const messageId = crypto.randomUUID();
            await supabaseAdmin.from("email_send_log").insert({
              message_id: messageId,
              template_name: "platform_announcement",
              recipient_email: r.email,
              status: "pending",
            });
            const { error: enqErr } = await supabaseAdmin.rpc("enqueue_email", {
              queue_name: "transactional_emails",
              payload: {
                message_id: messageId,
                to: r.email,
                from: `Scoop CRM <noreply@notify.thenorth.consulting>`,
                sender_domain: "notify.thenorth.consulting",
                subject,
                html,
                text,
                purpose: "transactional",
                label: "platform_announcement",
                idempotency_key: `announce:${a.id}:${r.email.toLowerCase()}`,
                queued_at: new Date().toISOString(),
              },
            });
            if (!enqErr) enqueued++;
          }

          await supabaseAdmin
            .from("platform_announcements")
            .update({ email_sent_at: new Date().toISOString() })
            .eq("id", a.id);

          summary.push({ id: a.id, title: a.title, recipients: list.length, enqueued });
        }

        return json({ ok: true, processed: (pending ?? []).length, summary });
      },
    },
  },
});

function renderAnnouncementHtml(title: string, body: string, severity: string) {
  const color =
    severity === "critical"
      ? "#dc2626"
      : severity === "warning"
      ? "#d97706"
      : severity === "success"
      ? "#059669"
      : "#2563eb";
  const safeBody = body.replace(/</g, "&lt;").replace(/\n/g, "<br/>");
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:${color};color:#fff;padding:16px 20px;font-weight:600">${title}</div>
    <div style="padding:20px;line-height:1.55;font-size:15px">${safeBody}</div>
    <div style="padding:12px 20px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0">Sent by Scoop CRM · Platform announcement</div>
  </div></body></html>`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
