// What a refund leaves behind on the invoice and on the signup it paid for
// (#674, #675).
//
// Pure, so the webhook's arithmetic and the screens' labels can be tested
// without Stripe or a database. The webhook (src/routes/api/public/hooks/
// stripe.ts) is still the only writer: it calls these to decide WHAT to
// write, from Stripe's cumulative `amount_refunded`.
//
// ── WHY THE INVOICE STAYS `paid` ──────────────────────────────────────────
//
// An invoice that was billed, paid and then refunded is not a void invoice.
// `billedDay` (src/lib/ar.ts) treats a void as never billed, and the refund is
// already deducted as its own dated contra line by src/lib/reversals.server.ts.
// Flipping the status to 'void' would take the sale out of the period it was
// billed in AND deduct the refund again, rewriting a closed month twice. So
// the status keeps saying what happened to the BILL, and two numbers say what
// happened to the MONEY: `amount_paid_cents` (kept) and
// `amount_refunded_cents` (given back). The label reads both.

import { splitRefund } from "@/lib/refund-split";

export type RefundablePayment = {
  amount_cents: number | null;
  surcharge_cents?: number | null;
  tip_cents?: number | null;
  tax_cents?: number | null;
};

/**
 * How much of `payments.amount_cents` — the money applied to the invoice —
 * Stripe's cumulative `amount_refunded` gave back.
 *
 * A charge is base + surcharge + tip, and a refund is dollars off the whole
 * charge. Only the invoiced share (revenue + its sales tax) ever reduced what
 * the invoice was owed, so only that share comes back off it; the surcharge
 * and tip shares were recorded beside `amount_cents` and go back beside it.
 * A refund of the whole charge returns the whole amount exactly, whatever the
 * proportional rounding would have said.
 */
export function invoicedShareRefunded(refundedCents: number, pay: RefundablePayment): number {
  const amount = Math.max(0, Math.round(Number(pay.amount_cents ?? 0)));
  const surcharge = Math.max(0, Math.round(Number(pay.surcharge_cents ?? 0)));
  const tip = Math.max(0, Math.round(Number(pay.tip_cents ?? 0)));
  const charged = amount + surcharge + tip;
  const refunded = Math.max(0, Math.round(Number(refundedCents ?? 0)));
  if (refunded <= 0 || amount <= 0) return 0;
  if (refunded >= charged) return amount;
  const split = splitRefund(refunded, charged, surcharge, tip, Number(pay.tax_cents ?? 0));
  return Math.min(amount, Math.max(0, split.revenueCents + split.taxCents));
}

export type SignupRefundRow = {
  status: string | null;
  refunded_at: string | null;
  stripe_refund_id: string | null;
  refunded_amount_cents: number | null;
};

/**
 * The columns to write on a signup_request whose payment the business
 * refunded after the account was made (#675). Null means leave the row alone.
 *
 * Only a PROVISIONED signup. A failed one is refunded by `provisionSignup`
 * itself, which writes these columns in the same update that marks it failed;
 * a pending one has no charge to refund.
 *
 * `amountRefundedCents` is Stripe's cumulative figure, so a second partial
 * refund raises the amount rather than replacing it with its own slice. It
 * goes down only when `authoritative` (a re-read after a refund failed), and
 * at zero the refund is undone: all three columns go back to null.
 */
export function signupRefundPatch(
  sr: SignupRefundRow | null,
  ev: {
    refundId: string | null;
    amountRefundedCents: number;
    at: string;
    authoritative?: boolean;
  },
): Partial<SignupRefundRow> | null {
  if (!sr || sr.status !== "provisioned") return null;
  const amount = Math.max(0, Math.round(Number(ev.amountRefundedCents ?? 0)));
  const had = Math.max(0, Number(sr.refunded_amount_cents ?? 0));

  if (amount <= 0) {
    if (!ev.authoritative || (!sr.refunded_at && !sr.stripe_refund_id && had === 0)) return null;
    return { refunded_at: null, stripe_refund_id: null, refunded_amount_cents: null };
  }
  if (!ev.authoritative && amount <= had && sr.refunded_at) return null;
  if (ev.authoritative && amount === had && sr.refunded_at) return null;

  return {
    // The day the money first went back; a later partial does not move it.
    refunded_at: sr.refunded_at ?? ev.at,
    stripe_refund_id: ev.refundId ?? sr.stripe_refund_id,
    refunded_amount_cents: amount,
  };
}

export type InvoiceRefundState = "refunded" | "partly_refunded" | null;

/**
 * Whether a PAID invoice's money went back. `amount_refunded_cents` counts
 * only refunds the webhook recorded with an amount, so a chargeback or a row
 * from before the column existed never reads as a refund.
 */
export function invoiceRefundState(inv: {
  status: string;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
}): InvoiceRefundState {
  if (inv.status !== "paid") return null;
  if ((inv.amount_refunded_cents ?? 0) <= 0) return null;
  return (inv.amount_paid_cents ?? 0) <= 0 ? "refunded" : "partly_refunded";
}

/** The status chip's label and tone: the stored status, unless the money on
 *  a paid invoice went back, in which case "Paid" would say it was kept. */
export function invoiceStatusChip(inv: {
  status: string;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
}): { status: string; label?: string } {
  const r = invoiceRefundState(inv);
  if (r === "refunded") return { status: "inactive", label: "Refunded" };
  if (r === "partly_refunded") return { status: "warning", label: "Partly refunded" };
  return { status: inv.status };
}
