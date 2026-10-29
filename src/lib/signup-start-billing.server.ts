// The office's record of a one-visit or package signup (#574).
//
// A repeating plan bought online is prepaid: the webhook credits the visit
// share to the customer's balance (credit_ledger, 'prepayment') and the
// prepaid invoice for that visit draws it down later. A single visit or a
// package has no later: it was paid for in full the moment the card went
// through. So it is written down the way the first cleanup is
// (first-cleanup-billing.server.ts): one invoice, already paid, with a line
// per thing bought, and a payment row for the same intent.
//
// The visit's own line carries its visit_id. Both billing generators
// (admin_generate_invoice_for_client and generate_prepaid_invoice) join
// invoice_line_items on visit_id and skip a visit that already has a line,
// so the visit is never billed a second time, whatever the client's cadence.
// A package's sessions are excluded from billing by client_package_id
// already (20261023100000).
//
// Idempotent on the intent: Stripe redelivers, and provisionSignup only
// returns early once the signup is marked provisioned, which happens after
// this.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { newInvoice } from "@/lib/db-insert";

export type SignupStartLine = {
  description: string;
  amountCents: number;
  visitId?: string | null;
  subscriptionId?: string | null;
};

export type SignupStartBill = {
  orgId: string;
  clientId: string;
  currency: string;
  lines: SignupStartLine[];
  /** The invoice's note: what was bought, in the office's words. */
  notes: string;
  paymentIntentId: string | null;
  stripeRef: string;
};

export async function billSignupStart(
  db: SupabaseClient<any>,
  p: SignupStartBill,
): Promise<{ invoiceId: string; created: boolean } | null> {
  const lines = p.lines.filter((l) => l.amountCents > 0);
  const total = lines.reduce((sum, l) => sum + Math.round(l.amountCents), 0);
  if (!(total > 0)) return null;

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

  // Paid on insert rather than inserted open and flipped: an open invoice is
  // one autopay can charge, and a crash between two writes would bill the
  // customer again for something they paid for minutes ago.
  const { data: inv, error: iErr } = await db
    .from("invoices")
    .insert(
      newInvoice({
        organization_id: p.orgId,
        client_id: p.clientId,
        kind: "postpaid",
        status: "paid",
        subtotal_cents: total,
        total_cents: total,
        currency: p.currency,
        period_start: today,
        period_end: today,
        issued_at: nowIso,
        paid_at: nowIso,
        due_on: today,
        stripe_payment_intent_id: p.paymentIntentId,
        notes: p.notes,
      }),
    )
    .select("id")
    .single();
  if (iErr || !inv) throw new Error(iErr?.message || "signup invoice insert failed");
  const invoiceId = (inv as { id: string }).id;

  const { error: lErr } = await db.from("invoice_line_items").insert(
    lines.map((l) => ({
      invoice_id: invoiceId,
      description: l.description,
      amount_cents: Math.round(l.amountCents),
      quantity: 1,
      unit_amount_cents: Math.round(l.amountCents),
      visit_id: l.visitId ?? null,
      subscription_id: l.subscriptionId ?? null,
    })),
  );
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
    amount_cents: total,
    currency: p.currency,
    status: "succeeded",
    stripe_payment_intent_id: p.paymentIntentId,
    paid_at: nowIso,
  });
  if (payErr) {
    // The invoice is right and is what the customer and the office read;
    // the payment row is short. Loud, not thrown: throwing now would unwind
    // a sale the customer has an account for.
    console.error("signup invoice paid but its payment row failed", invoiceId, payErr);
  }

  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(db, {
      orgId: p.orgId,
      clientId: p.clientId,
      actorLabel: "Online signup",
      kind: "invoice.created",
      summary: `${p.notes}: $${(total / 100).toFixed(2)} (Stripe ${p.stripeRef})`,
    });
  } catch {
    // The timeline is best-effort; the invoice is written either way.
  }

  return { invoiceId, created: true };
}
