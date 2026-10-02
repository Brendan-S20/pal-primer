// Writing down the first cleanup a customer paid for at online signup.
//
// The signup charge has always been first cleanup + first visit, taken in one
// PaymentIntent. The webhook credited the visit share to the customer's
// balance (credit_ledger, 'prepayment') and did nothing with the rest: no
// invoice, no line, no payment row. So the first cleanup was money in the
// tenant's Stripe balance that no HoundStack report could see, and a customer
// who asked "what was the $75?" had nothing in the portal to point at.
//
// Now it is an invoice with one line, already paid, and a payment row for the
// same intent. Paid on insert rather than inserted open and then flipped: an
// open invoice is one autopay can charge, and a crash between the two writes
// would bill the customer a second time for something they paid for minutes
// ago.
//
// Idempotent on the intent. Stripe redelivers, and provisionSignup returns
// early only once the signup is marked provisioned, which happens AFTER this;
// a crash in between must not write a second invoice on the retry.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { firstCleanupDescription } from "@/lib/first-cleanup";

export type SignupFirstCleanup = {
  orgId: string;
  clientId: string;
  amountCents: number;
  currency: string;
  /** The tier the customer picked, in the owner's words that day. */
  tierLabel: string | null;
  dogCount: number;
  paymentIntentId: string | null;
  stripeRef: string;
};

export async function billSignupFirstCleanup(
  db: SupabaseClient<any>,
  p: SignupFirstCleanup,
): Promise<{ invoiceId: string; created: boolean } | null> {
  if (!(p.amountCents > 0)) return null;

  if (p.paymentIntentId) {
    const { data: already } = await db
      .from("invoices")
      .select("id")
      .eq("organization_id", p.orgId)
      .eq("stripe_payment_intent_id", p.paymentIntentId)
      .maybeSingle();
    if (already) return { invoiceId: (already as { id: string }).id, created: false };
  }

  const { data: org } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", p.orgId)
    .maybeSingle();
  const today = orgToday((org as { timezone?: string } | null)?.timezone || DEFAULT_ORG_TIMEZONE);
  const nowIso = new Date().toISOString();

  const { data: inv, error: iErr } = await db
    .from("invoices")
    .insert({
      organization_id: p.orgId,
      client_id: p.clientId,
      kind: "postpaid",
      status: "paid",
      subtotal_cents: p.amountCents,
      total_cents: p.amountCents,
      currency: p.currency,
      period_start: today,
      period_end: today,
      issued_at: nowIso,
      paid_at: nowIso,
      due_on: today,
      stripe_payment_intent_id: p.paymentIntentId,
      notes: "First cleanup, paid at online signup",
    })
    .select("id")
    .single();
  if (iErr || !inv) throw new Error(iErr?.message || "first-cleanup invoice insert failed");
  const invoiceId = (inv as { id: string }).id;

  const { error: lErr } = await db.from("invoice_line_items").insert({
    invoice_id: invoiceId,
    description: firstCleanupDescription(p.tierLabel, p.dogCount),
    amount_cents: p.amountCents,
    quantity: 1,
    unit_amount_cents: p.amountCents,
  });
  if (lErr) {
    // Never leave a paid invoice with nothing on it.
    await db.from("invoices").delete().eq("id", invoiceId);
    throw new Error(lErr.message);
  }

  const { collectingOrgIdFor } = await import("@/lib/stripe-connect.server");
  const { error: payErr } = await db.from("payments").insert({
    organization_id: p.orgId,
    collected_by_organization_id: await collectingOrgIdFor(p.orgId),
    invoice_id: invoiceId,
    amount_cents: p.amountCents,
    currency: p.currency,
    status: "succeeded",
    stripe_payment_intent_id: p.paymentIntentId,
    paid_at: nowIso,
  });
  if (payErr) {
    // The invoice is the record the customer and the office read, and it is
    // right; the ledger row is short. Loud, not thrown, for the reason
    // markInvoicePaidFromStripe gives: throwing now would unwind a sale.
    console.error("first-cleanup invoice paid but its payment row failed", invoiceId, payErr);
  }

  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(db, {
      orgId: p.orgId,
      clientId: p.clientId,
      actorLabel: "Online signup",
      kind: "invoice.created",
      summary: `First cleanup paid at signup: $${(p.amountCents / 100).toFixed(2)} (Stripe ${p.stripeRef})`,
    });
  } catch {
    // The timeline is best-effort; the invoice is written either way.
  }

  return { invoiceId, created: true };
}
