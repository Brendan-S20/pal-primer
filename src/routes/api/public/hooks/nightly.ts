import { createFileRoute } from "@tanstack/react-router";

// POST /api/public/hooks/nightly?s=<CRON_SECRET>
// Called by pg_cron on a schedule. Iterates orgs and:
//   1) auto-generates recurring visits N days ahead (if enabled)
//   2) auto-generates postpaid invoices through today (if enabled)
//   3) sends overdue-invoice SMS reminders (if enabled + client has phone + not opted out)
// All work uses service_role via supabaseAdmin so no user session is required.

export const Route = createFileRoute("/api/public/hooks/nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        if (!secret) return json({ error: "not_configured" }, 500);
        const url = new URL(request.url);
        const provided = url.searchParams.get("s") ?? request.headers.get("x-cron-secret");
        if (provided !== secret) return json({ error: "unauthorized" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const today = new Date();
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const todayStr = iso(today);

        const { data: orgs, error: orgErr } = await supabaseAdmin
          .from("organizations")
          .select(
            "id, name, sms_from_number, auto_generate_visits, auto_generate_days_ahead, auto_invoice_enabled, overdue_reminders_enabled, overdue_reminder_days",
          );
        if (orgErr) return json({ error: orgErr.message }, 500);

        const summary: Array<Record<string, unknown>> = [];

        for (const org of orgs ?? []) {
          const perOrg: Record<string, unknown> = { org: org.name, id: org.id };

          if (org.auto_generate_visits) {
            const ahead = new Date(today);
            ahead.setDate(ahead.getDate() + (org.auto_generate_days_ahead ?? 14));
            const { data: n, error } = await supabaseAdmin.rpc("admin_generate_visits_through", {
              _org_id: org.id,
              _through: iso(ahead),
            });
            perOrg.visits_generated = error ? `err: ${error.message}` : (n as number);
          }

          if (org.auto_invoice_enabled) {
            const { data: n, error } = await supabaseAdmin.rpc("admin_generate_invoices_for_org", {
              _org_id: org.id,
              _through: todayStr,
            });
            perOrg.invoices_generated = error ? `err: ${error.message}` : (n as number);
          }

          if (org.overdue_reminders_enabled && org.sms_from_number) {
            perOrg.reminders_sent = await sendOverdueReminders(
              supabaseAdmin,
              org.id,
              org.sms_from_number,
              org.overdue_reminder_days ?? 7,
            );
          }

          summary.push(perOrg);
        }

        return json({ ok: true, ran_at: new Date().toISOString(), orgs: summary });
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

async function sendOverdueReminders(
  supabaseAdmin: any,
  orgId: string,
  from: string,
  reminderDays: number,
): Promise<number | string> {
  const cutoffIso = new Date(Date.now() - reminderDays * 86400000).toISOString();
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, issued_at, last_reminder_at, kind")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .lte("issued_at", cutoffIso);
  if (error) return `err: ${error.message}`;
  if (!invoices?.length) return 0;

  // Throttle: only send if never reminded, or last reminder > reminderDays ago
  const eligible = invoices.filter((inv: any) => {
    if (!inv.last_reminder_at) return true;
    const days = (Date.now() - new Date(inv.last_reminder_at).getTime()) / 86400000;
    return days >= reminderDays;
  });
  if (!eligible.length) return 0;

  const clientIds = [...new Set(eligible.map((i: any) => i.client_id))];
  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, display_name, primary_phone, sms_opt_out, portal_token")
    .in("id", clientIds);
  const byId = new Map((clients ?? []).map((c: any) => [c.id, c]));

  const { sendTwilioSms } = await import("@/lib/twilio.server");
  let sent = 0;
  for (const inv of eligible) {
    const client = byId.get(inv.client_id) as any;
    if (!client || client.sms_opt_out || !client.primary_phone) continue;
    const dollars = ((inv.total_cents ?? 0) / 100).toFixed(2);
    const body = `Hi ${client.display_name}, this is a friendly reminder that invoice for $${dollars} is past due. Pay: ${appUrl()}/portal/${client.portal_token}`;
    try {
      const res = await sendTwilioSms({ from, to: client.primary_phone, body });
      await supabaseAdmin.from("messages").insert({
        organization_id: orgId,
        client_id: client.id,
        direction: "outbound",
        body,
        from_number: from,
        to_number: client.primary_phone,
        twilio_sid: res.sid,
        status: res.status,
      });
      await supabaseAdmin
        .from("invoices")
        .update({ last_reminder_at: new Date().toISOString() })
        .eq("id", inv.id);
      sent++;
    } catch (e) {
      console.error("reminder send failed", inv.id, e);
    }
  }
  return sent;
}

function appUrl() {
  return process.env.APP_URL || "https://pal-primer.lovable.app";
}
