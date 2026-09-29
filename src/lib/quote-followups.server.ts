// The nightly follow-up on unanswered quotes. See
// supabase/migrations/20260929020000_an-unanswered-quote-was-never-followed-up.sql.
//
// Server-only: import inside handlers with `await import(...)`.

import { orgToday } from "@/lib/org-day";
import { appOrigin } from "@/lib/app-origin";
import { followupDue } from "@/lib/quote-followups";
import { formatQuoteDay, quoteNumberLabel, quoteTotals } from "@/lib/quotes";

/** One reminder per due quote for this organization. Returns how many were
 *  emailed. Every due quote is stamped whether or not an email could go (no
 *  address, opted out, on hold), so a quote with nobody to remind is not
 *  retried every night. */
export async function sendQuoteFollowups(
  supabaseAdmin: any,
  org: { id: string; timezone?: string | null; quote_followup_days?: number | null },
  now: Date = new Date(),
): Promise<number> {
  const days = org.quote_followup_days ?? 3;
  if (days <= 0) return 0;
  const today = orgToday(org.timezone || undefined, now);
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("quotes")
    .select(
      "id, number, status, title, message, valid_until, public_token, sent_at, followup_sent_at, client_id, prospect_name, prospect_email, clients!quotes_client_id_fkey(primary_email), quote_line_items(amount_cents, recurring)",
    )
    .eq("organization_id", org.id)
    .eq("status", "sent")
    .is("followup_sent_at", null)
    .lte("sent_at", cutoff)
    .limit(500);
  if (error) {
    console.error("quote follow-ups: query failed", org.id, error.message);
    return 0;
  }

  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  let emailed = 0;
  for (const q of rows ?? []) {
    if (!followupDue(q, { days, orgToday: today, now })) continue;
    const client = Array.isArray(q.clients) ? q.clients[0] : q.clients;
    const recipient = ((q.client_id ? client?.primary_email : q.prospect_email) ?? "").trim();
    if (recipient) {
      const totals = quoteTotals(q.quote_line_items ?? []);
      const res = await enqueueAppEmail({
        organizationId: org.id,
        clientId: q.client_id ?? null,
        recipientName: q.prospect_name ?? null,
        toOverride: q.client_id ? undefined : recipient,
        templateName: "quote-sent",
        notifyKey: "notify_email_quote_sent",
        idempotencyKey: `quote-followup-${q.id}`,
        templateData: {
          reminder: true,
          quoteLabel: quoteNumberLabel(q.number),
          title: q.title ?? null,
          oneTimeCents: totals.oneTimeCents,
          recurringCents: totals.recurringCents,
          validUntilLabel: q.valid_until ? formatQuoteDay(q.valid_until) : null,
          quoteUrl: `${appOrigin()}/q/${q.public_token}`,
        },
      });
      if (res.ok) emailed++;
    }
    // Stamped only while still unanswered: a customer who accepted between
    // the query and now must not have their quote touched.
    await supabaseAdmin
      .from("quotes")
      .update({ followup_sent_at: now.toISOString() })
      .eq("id", q.id)
      .eq("status", "sent")
      .is("followup_sent_at", null);
  }
  return emailed;
}
