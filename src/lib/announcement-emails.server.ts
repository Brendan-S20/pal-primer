// Sending a platform announcement by email.
//
// ── WHY THIS IS A MODULE AND NOT A ROUTE HANDLER ───────────────────────────
//
// It was 120 lines inside `POST /api/public/hooks/announcement-emails`, a cron
// endpoint that NOTHING SCHEDULES. So an announcement created with "Also send
// email" switched on was never emailed to anyone, and the dialog said "Sends
// when the announcement first goes live" — copy describing a behaviour the
// product does not have. Same shape as the weekly digest, the franchise
// rollup and `trialing` before it: built, correct, and set in motion by
// nothing.
//
// Scheduling platform-wide outbound email is the owner's decision, not a
// cleanup task — a cron that mails every tenant whenever somebody ticks a
// checkbox is a foot-gun. So the send lives here, where BOTH a future
// scheduler and a deliberate "send now" from the platform screen can call it,
// and a human is the trigger until the owner says otherwise.
//
// ── THE AUDIENCE BUG THIS FIXES ────────────────────────────────────────────
//
// The `trialing` audience filtered on `plan_status = 'free'`. That was a
// reasonable stand-in when no organization could be `trialing` — the status
// existed in the enum and nothing ever set it — but BUILD-7 made it real, so
// the filter now selects exactly the wrong tenants: every legacy free account
// and not one actual trial. An announcement aimed at people mid-trial would
// have gone to the six accounts that predate trials entirely.

import { systemFooterHtml, systemHeaderHtml } from "@/lib/email-templates/_brand";

export type AnnouncementSendResult = {
  id: string;
  title: string;
  recipients: number;
  enqueued: number;
  skipped?: string;
};

/** Audiences that map straight onto a plan_status value. */
const PLAN_STATUS_AUDIENCES = new Set(["active", "past_due", "canceled", "free", "trialing"]);

export function renderAnnouncementHtml(title: string, body: string, severity: string): string {
  const color =
    severity === "critical"
      ? "#dc2626"
      : severity === "warning"
        ? "#d97706"
        : severity === "success"
          ? "#059669"
          : "#2563eb";
  const safeBody = body.replace(/</g, "&lt;").replace(/\n/g, "<br/>");
  // HoundStack chrome above and below the card (#577): the band sits on
  // the card's top edge, as in SystemLayout. The card is unchanged.
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:32px 16px 40px;color:#0f172a">
  <div style="max-width:600px;margin:0 auto">
  ${systemHeaderHtml()}
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;overflow:hidden">
    <div style="background:${color};color:#fff;padding:16px 20px;font-weight:600">${title}</div>
    <div style="padding:20px;line-height:1.55;font-size:15px">${safeBody}</div>
  </div>
  ${systemFooterHtml("Sent by HoundStack · Platform announcement")}
  </div></body></html>`;
}

/**
 * Enqueue one announcement's emails and stamp it as sent.
 *
 * Returns what it did rather than throwing on an empty audience: "0 recipients"
 * is a real, reportable outcome and the caller should be able to say so.
 */
async function sendOne(supabaseAdmin: any, a: any): Promise<AnnouncementSendResult> {
  if (a.ends_at && new Date(a.ends_at) <= new Date()) {
    return { id: a.id, title: a.title, recipients: 0, enqueued: 0, skipped: "expired" };
  }

  let recipients: Array<{ email: string; org_name: string }> = [];

  if (a.audience === "admins") {
    const { data: admins } = await supabaseAdmin.from("platform_admins").select("user_id");
    const uids = Array.from(new Set((admins ?? []).map((r: any) => r.user_id)));
    for (const uid of uids) {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(uid);
        if (u?.user?.email) recipients.push({ email: u.user.email, org_name: "HoundStack" });
      } catch {
        /* a platform admin whose auth record is gone is not a reason to abort
           the whole send */
      }
    }
  } else {
    let orgQ = supabaseAdmin
      .from("organizations")
      .select("id, name, contact_email, plan_status")
      .not("contact_email", "is", null);
    // See the header: `trialing` used to be rewritten to `free` here, which
    // now selects precisely the wrong organizations.
    if (PLAN_STATUS_AUDIENCES.has(a.audience)) orgQ = orgQ.eq("plan_status", a.audience);
    const { data: orgs } = await orgQ;
    recipients = (orgs ?? [])
      .filter((o: any) => o.contact_email)
      .map((o: any) => ({ email: o.contact_email as string, org_name: o.name }));
  }

  const uniq = new Map<string, { email: string; org_name: string }>();
  for (const r of recipients) uniq.set(r.email.toLowerCase(), r);
  const list = [...uniq.values()];

  const { data: suppressed } = list.length
    ? await supabaseAdmin
        .from("suppressed_emails")
        .select("email")
        .in(
          "email",
          list.map((r) => r.email.toLowerCase()),
        )
    : { data: [] as { email: string }[] };
  const suppressedSet = new Set((suppressed ?? []).map((s: any) => s.email.toLowerCase()));

  const html = renderAnnouncementHtml(a.title, a.body, a.severity);
  const text = `${a.title}\n\n${a.body}`;
  const subject = `[HoundStack] ${a.title}`;

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
        from: `HoundStack <noreply@notify.houndstack.com>`,
        sender_domain: "notify.houndstack.com",
        subject,
        html,
        text,
        purpose: "transactional",
        label: "platform_announcement",
        // Keyed on announcement + recipient, so pressing "send now" twice, or a
        // scheduler racing a human, cannot mail the same person twice.
        idempotency_key: `announce:${a.id}:${r.email.toLowerCase()}`,
        queued_at: new Date().toISOString(),
      },
    });
    if (!enqErr) enqueued++;
  }

  // Stamped last. If this write fails the announcement stays pending and the
  // idempotency key above is what stops a retry from double-sending.
  await supabaseAdmin
    .from("platform_announcements")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("id", a.id);

  return { id: a.id, title: a.title, recipients: list.length, enqueued };
}

/**
 * Send every announcement that is due, or one specific announcement.
 *
 * `announcementId` is what the platform screen's "send now" passes. Without it
 * this is the sweep a scheduler would run.
 */
export async function sendPendingAnnouncementEmails(
  announcementId?: string,
): Promise<{ processed: number; summary: AnnouncementSendResult[] }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();

  let q = supabaseAdmin
    .from("platform_announcements")
    .select("id, title, body, severity, audience, starts_at, ends_at, send_email, email_sent_at")
    .eq("send_email", true)
    .is("email_sent_at", null);

  if (announcementId) {
    q = q.eq("id", announcementId);
  } else {
    // Only the sweep waits for the start time. Someone pressing "send now" on a
    // scheduled announcement has said what they want; refusing on a technicality
    // would just make them edit the date.
    q = q.lte("starts_at", now).limit(50);
  }

  const { data: pending, error } = await q;
  if (error) throw new Error(error.message);

  const summary: AnnouncementSendResult[] = [];
  for (const a of pending ?? []) summary.push(await sendOne(supabaseAdmin, a));
  return { processed: (pending ?? []).length, summary };
}
