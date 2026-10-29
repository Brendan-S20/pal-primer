// The office's record of a one-visit or package Start from the booking link
// (#574): an invoice, already paid, with a line for what was bought, and a
// payment row for the PaymentIntent.
//
// The repeating plan's signup writes a credit_ledger prepayment and, unless
// there was a first cleanup, nothing else, so the office saw money in Stripe
// and a balance on the client but no invoice and no payment for the charge.
// A one-visit or package Start is a single sale, and the office reads a
// single sale on Invoices and Payments, so it gets both.
//
// One invoice per intent, because payments.stripe_payment_intent_id is
// unique: a first cleanup charged in the same intent is a second line on
// this invoice rather than an invoice of its own (billSignupFirstCleanup is
// not called for these modes).
//
// One visit: kind prepaid_topup, and the session's share credited to the
// client with the invoice named, so the visit draws it down when it is done,
// as every prepaid visit does, and a refund of this payment reverses it
// (reverse_prepaid_credit_for_payment reads prepaid_topup).
// A package: kind postpaid, nothing credited. The package counts its own
// sessions, and the invoice is the one client_packages.invoice_id points at.
//
// Paid on insert, never open and then flipped: an open invoice is one
// autopay can charge. Idempotent on the intent, because Stripe redelivers and
// provisionSignup marks the signup provisioned only after this.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { firstCleanupDescription } from "@/lib/first-cleanup";
import { newInvoice } from "@/lib/db-insert";

export type SignupStartSale = {
  orgId: string;
  clientId: string;
  mode: "one_time" | "package";
  /** What was bought, as the invoice line reads. */
  description: string;
  /** The session or the package, without the first cleanup. */
  amountCents: number;
  firstCleanupCents: number;
  firstCleanupLabel: string | null;
  dogCount: number;
  currency: string;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  stripeRef: string;
};

export async function billSignupStart(
  db: SupabaseClient<any>,
  p: SignupStartSale,
): Promise<{ invoiceId: string; created: boolean }> {
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
  const firstCleanup = Math.max(0, p.firstCleanupCents);
  const total = p.amountCents + firstCleanup;

  const { data: inv, error: iErr } = await db
    .from("invoices")
    .insert(
      newInvoice({
        organization_id: p.orgId,
        client_id: p.clientId,
        kind: p.mode === "one_time" ? "prepaid_topup" : "postpaid",
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
        notes:
          p.mode === "one_time"
            ? "One visit, paid on the booking link"
            : "Package, paid on the booking link",
      }),
    )
    .select("id")
    .single();
  if (iErr || !inv) throw new Error(iErr?.message || "signup invoice insert failed");
  const invoiceId = (inv as { id: string }).id;

  const lines = [
    {
      invoice_id: invoiceId,
      description: p.description,
      amount_cents: p.amountCents,
      quantity: 1,
      unit_amount_cents: p.amountCents,
      ...(p.subscriptionId ? { subscription_id: p.subscriptionId } : {}),
    },
    ...(firstCleanup > 0
      ? [
          {
            invoice_id: invoiceId,
            description: firstCleanupDescription(p.firstCleanupLabel, p.dogCount),
            amount_cents: firstCleanup,
            quantity: 1,
            unit_amount_cents: firstCleanup,
          },
        ]
      : []),
  ];
  const { error: lErr } = await db.from("invoice_line_items").insert(lines);
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
    // The invoice is right and is what the office reads; the ledger row is
    // short. Loud, not thrown: throwing now would unwind a sale.
    console.error("signup invoice paid but its payment row failed", invoiceId, payErr);
  }

  if (p.mode === "one_time" && p.amountCents > 0) {
    const { error: cErr } = await db.from("credit_ledger").insert({
      organization_id: p.orgId,
      client_id: p.clientId,
      delta_cents: p.amountCents,
      kind: "prepayment",
      invoice_id: invoiceId,
      note: `Signup prepay via Stripe ${p.stripeRef}`,
    });
    if (cErr) console.error("signup one-visit credit failed", invoiceId, cErr);
  }

  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(db, {
      orgId: p.orgId,
      clientId: p.clientId,
      actorLabel: "Online signup",
      kind: "invoice.created",
      summary: `${p.description} paid on the booking link: $${(total / 100).toFixed(2)} (Stripe ${p.stripeRef})`,
    });
  } catch {
    // The timeline is best-effort; the invoice is written either way.
  }

  return { invoiceId, created: true };
}
