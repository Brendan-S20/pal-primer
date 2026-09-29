// Email campaigns, the server half: reading the audience and feeding the
// campaign lane. Import inside handlers with `await import(...)`.
//
// ── HOW A CAMPAIGN GOES OUT ────────────────────────────────────────────────
//
//   Send pressed      sendCampaign works out the audience and calls
//                     start_email_campaign, which checks the business address,
//                     freezes the recipients (one row per client, UNIQUE per
//                     campaign) and flips draft -> sending, all under one lock.
//   every minute      /email/queue/process calls feedCampaignLane with however
//                     much room the campaign_emails lane has (at most one
//                     batch), renders and enqueues that many, then reads the
//                     lane AFTER auth and transactional mail.
//   nothing left      settle_email_campaigns flips sending -> sent.
//
// So the pace is the processor's: batch_size (10) a minute unless an operator
// raises it in email_send_state, and a 5,000-recipient campaign takes about
// eight hours. That is on purpose. The alternative, all of it on the
// transactional queue at once, dead-letters most of it as expired after the
// first hour (transactional_email_ttl_minutes) and holds up every invoice and
// reminder behind it until then.
import { enqueueAppEmail } from "@/lib/email/enqueue.server";
import { campaignIdempotencyKey, normalizeEmail, type AudienceClient } from "@/lib/campaigns";

async function admin() {
  // The service role, because email_campaign_recipients and the functions
  // that claim and settle it are reachable by no API role.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Every client in the organization with the columns the audience is decided
 *  on. Paged, because PostgREST stops at 1,000 rows and a campaign is allowed
 *  five times that. `supabase` is the caller's client, so RLS is the tenant
 *  boundary here as it is everywhere else. */
export async function loadAudienceClients(supabase: any, orgId: string): Promise<AudienceClient[]> {
  const out: AudienceClient[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, display_name, primary_email, active, tags, email_opt_out, comms_paused")
      .eq("organization_id", orgId)
      .order("id")
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as AudienceClient[];
    out.push(...rows);
    if (rows.length < page) break;
    // A hard stop well past any real customer base, so a runaway loop is a
    // bounded one.
    if (from > 50_000) break;
  }
  return out;
}

type Claimed = {
  recipient_id: string;
  campaign_id: string;
  organization_id: string;
  client_id: string;
  email: string;
};

type CampaignContentRow = {
  id: string;
  subject: string;
  heading: string;
  body: string;
  button_label: string | null;
  button_url: string | null;
};

/**
 * Render and enqueue up to `limit` frozen recipients onto campaign_emails.
 *
 * Every recipient passes enqueueAppEmail's own checks again at this moment,
 * not at the moment Send was pressed: somebody who unsubscribed from last
 * week's campaign an hour into this one's eight is not sent it. Not `manual`,
 * so the imported comms hold is honoured too.
 */
export async function feedCampaignLane(
  limit: number,
): Promise<{ claimed: number; queued: number; skipped: number }> {
  const db = await admin();
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  if (n === 0) return { claimed: 0, queued: 0, skipped: 0 };

  const { data: claimedRows, error } = await db.rpc("claim_email_campaign_recipients", {
    _limit: n,
  });
  if (error) throw new Error(`claim_email_campaign_recipients: ${error.message}`);
  const claimed = (claimedRows ?? []) as Claimed[];

  let queued = 0;
  let skipped = 0;
  if (claimed.length > 0) {
    const campaignIds = [...new Set(claimed.map((c) => c.campaign_id))];
    const { data: campaigns, error: cErr } = await db
      .from("email_campaigns")
      .select("id, subject, heading, body, button_label, button_url")
      .in("id", campaignIds);
    if (cErr) throw new Error(cErr.message);
    const byId = new Map<string, CampaignContentRow>(
      ((campaigns ?? []) as CampaignContentRow[]).map((c) => [c.id, c]),
    );

    for (const r of claimed) {
      const campaign = byId.get(r.campaign_id);
      let outcome: { ok: true; messageId: string | null } | { ok: false; reason: string };
      if (!campaign) {
        outcome = { ok: false, reason: "enqueue_failed" };
      } else if (await addressOptedOut(db, r.organization_id, r.email)) {
        // A different client row with the same inbox unsubscribed after the
        // audience was frozen. The address said no; see selectAudience.
        outcome = { ok: false, reason: "address_opted_out" };
      } else {
        const res = await enqueueAppEmail({
          organizationId: r.organization_id,
          clientId: r.client_id,
          templateName: "campaign",
          templateData: {
            subject: campaign.subject,
            heading: campaign.heading,
            body: campaign.body,
            buttonLabel: campaign.button_label,
            buttonUrl: campaign.button_url,
          },
          idempotencyKey: campaignIdempotencyKey(r.campaign_id, r.client_id),
          queue: "campaign_emails",
          clientUnsubscribe: true,
        });
        outcome = res.ok
          ? { ok: true, messageId: res.messageId ?? null }
          : { ok: false, reason: res.reason ?? "enqueue_failed" };
      }

      const now = new Date().toISOString();
      const patch = outcome.ok
        ? { status: "queued", message_id: outcome.messageId, queued_at: now, skip_reason: null }
        : { status: "skipped", skip_reason: outcome.reason };
      const { error: uErr } = await db
        .from("email_campaign_recipients")
        .update(patch)
        .eq("id", r.recipient_id)
        .eq("status", "claimed");
      if (uErr)
        console.error("campaign recipient update failed", {
          id: r.recipient_id,
          error: uErr.message,
        });
      if (outcome.ok) queued++;
      else skipped++;
    }
  }

  const { error: sErr } = await db.rpc("settle_email_campaigns");
  if (sErr) console.error("settle_email_campaigns failed", sErr.message);
  return { claimed: claimed.length, queued, skipped };
}

async function addressOptedOut(db: any, orgId: string, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const { data } = await db
    .from("clients")
    .select("id")
    .eq("organization_id", orgId)
    .eq("email_opt_out", true)
    .ilike(
      "primary_email",
      e.replace(/[\\%_]/g, (m: string) => `\\${m}`),
    )
    .limit(1);
  return (data ?? []).length > 0;
}
