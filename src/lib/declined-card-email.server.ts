// Server-only: tell a client, by email, that an automatic charge to their
// card on file was declined. Called by the Stripe Connect webhook on
// `payment_intent.payment_failed` for an autopay charge. Import inside
// handlers with `await import(...)`.
//
// ── WHY EMAIL ─────────────────────────────────────────────────────────────
//
// This used to be a text from the platform's number. Since 2026-10-06 a
// business's clients are texted only from the business's own number, which
// no business has yet, so the client was told nothing while the office got
// its in-app notice. The text path is still in the webhook and lights up per
// business when its number does; this email goes either way.
//
// ── ONCE PER INVOICE PER DAY ──────────────────────────────────────────────
//
// Stripe delivers a webhook at least once and retries for up to three days,
// and the dunning ladder charges again on later days. So the key is the
// invoice and the CALENDAR DAY OF THE DECLINE (UTC, as the overdue reminders
// key theirs), taken from the event's own `created` and not from the clock:
// a redelivery of Monday's decline that arrives on Tuesday is still Monday's
// and sends nothing. A second decline on the same day sends nothing; the
// next day's sends again. `oncePerKey` makes the key durable (see
// enqueueAppEmail).
//
// ── WHO DOES NOT GET IT ───────────────────────────────────────────────────
//
// Exactly who does not get an overdue reminder, by the same switches, all
// applied inside enqueueAppEmail: the business's "Overdue and declined-card
// reminders" email setting (notify_email_overdue), a client who opted out of
// email at this business, a client on an imported comms hold, and an address
// on the suppression list.

export type DeclinedCardEmailResult = Awaited<
  ReturnType<typeof import("@/lib/email/enqueue.server").enqueueAppEmail>
>;

/** "2026-10-07": the UTC calendar day a decline happened on. */
export function declineDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function emailClientAboutDeclinedCard(p: {
  organizationId: string;
  clientId: string;
  invoiceId: string;
  /** What was being charged toward the invoice (no surcharge, no tip). */
  amountCents: number;
  /** When Stripe says the charge was declined: the event's `created`. */
  declinedAt: Date;
}): Promise<DeclinedCardEmailResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  const { buildPortalLink } = await import("@/lib/portal-links.server");
  const { invoiceRef } = await import("@/lib/invoice-labels");
  const { appOrigin } = await import("@/lib/app-origin");

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("portal_token")
    .eq("id", p.clientId)
    .maybeSingle();

  // The same link the overdue reminder carries, with the same fallback.
  const portalUrl =
    (await buildPortalLink(p.organizationId, (client as any)?.portal_token ?? null)) ??
    appOrigin();

  return enqueueAppEmail({
    organizationId: p.organizationId,
    clientId: p.clientId,
    templateName: "payment-failed",
    notifyKey: "notify_email_overdue",
    idempotencyKey: `payment-failed-${p.invoiceId}-${declineDay(p.declinedAt)}`,
    oncePerKey: true,
    templateData: {
      invoiceNumber: await invoiceRef(supabaseAdmin, p.invoiceId),
      amountCents: p.amountCents,
      portalUrl,
    },
  });
}
