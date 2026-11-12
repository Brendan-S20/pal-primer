// What a refund leaves behind on the invoice and on the signup it paid for
// (#674, #675).
//
// Pure, so the webhook's arithmetic and the screens' labels can be tested
// without Stripe or a database. The webhook (src/routes/api/public/hooks/
// stripe.ts) is still the only writer: it calls these to decide WHAT to
// write, from Stripe's cumulative `amount_refunded`.
//
// ── WHY A REFUND LEAVES THE INVOICE `paid` ───────────────────────────────
//
// An invoice that was billed, paid and then refunded is not void by itself.
// The refund is already deducted as its own dated contra line by
// src/lib/reversals.server.ts, so the status keeps saying what happened to
// the BILL, and two numbers say what happened to the MONEY:
// `amount_paid_cents` (kept) and `amount_refunded_cents` (given back). The
// label reads both.
//
// ── AND WHAT VOIDING IT AFTERWARDS MEANS ─────────────────────────────────
//
// Voiding is the office's choice once the money is all back (#674, Nov 10
// 2026: "Allow Void after a refund"). It is offered only on an invoice
// refunded in full; a partly refunded one is told to refund the rest first,
// because voiding it would leave money the business kept tied to an invoice
// that no longer exists. The void changes the record and nothing else:
// `void_refunded_invoice` moves no money, keeps `paid_at` and both amounts,
// and releases the visit lines so the visit can be invoiced again once.
// `voidedAfterRefund` is how the reports tell that void from an ordinary one:
// its sale stays in the period it was billed in, and the refund stays the
// only deduction, so revenue and receivables read the same before and after.

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
  // A refund id the row does not have yet is news even when the amount is
  // not. `charge.refunded` learns the id from the charge's refund list, which
  // can fail or come back empty; `charge.refund.updated` IS the refund. If the
  // event that carried the amount carried no id, the one that carries the id
  // must still be able to write it, or stripe_refund_id stays null for good.
  const fillsId = !!ev.refundId && !sr.stripe_refund_id;
  if (!ev.authoritative && amount <= had && sr.refunded_at && !fillsId) return null;
  if (ev.authoritative && amount === had && sr.refunded_at && !fillsId) return null;

  return {
    // The day the money first went back; a later partial does not move it.
    refunded_at: sr.refunded_at ?? ev.at,
    stripe_refund_id: ev.refundId ?? sr.stripe_refund_id,
    // An older event that only arrived to fill the id never lowers the amount.
    refunded_amount_cents: ev.authoritative ? amount : Math.max(amount, had),
  };
}

/**
 * The refund id a `charge.refund.updated` event can vouch for: the refund it
 * is about, unless that refund failed or was canceled — then the money did
 * not go back on it, and naming it on the signup would point at a refund
 * that never happened.
 */
export function refundIdFromReread(
  refund: { id?: unknown; status?: unknown } | null | undefined,
): string | null {
  if (!refund || typeof refund.id !== "string" || !refund.id) return null;
  if (refund.status === "failed" || refund.status === "canceled") return null;
  return refund.id;
}

/**
 * What a payment's status becomes after `charge.refund.updated` re-reads the
 * charge from Stripe, or null to leave it alone.
 *
 * Nothing back: a 'refunded' payment returns to 'succeeded' (the refund
 * failed). Something back on a payment still 'succeeded': it becomes
 * 'refunded', because `charge.refunded` may not have landed (out of order, or
 * missed) and the invoice only counts a payment's refunded_cents once the
 * payment says it was refunded — otherwise the invoice reads Paid in full
 * while the money is back with the customer (#674). Any other status was set
 * by something that is not a refund and is not this branch's to change.
 */
export function paymentStatusAfterReread(
  status: string | null | undefined,
  trueRefundedCents: number,
): "succeeded" | "refunded" | null {
  const refunded = Math.max(0, Math.round(Number(trueRefundedCents ?? 0)));
  if (refunded <= 0) return status === "refunded" ? "succeeded" : null;
  return status === "succeeded" ? "refunded" : null;
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

export type VoidAfterRefund = { offered: true } | { offered: false; reason: string | null };

/**
 * Whether Void is offered on a PAID invoice because its money went back
 * (#674). Offered only once the refund is the whole of what was paid. On a
 * partly refunded invoice it is not, and `reason` is what the screen says
 * instead. On a paid invoice nothing was refunded on, or any other status,
 * nothing is offered and there is nothing to say: an open invoice has the
 * ordinary Void.
 */
export function voidAfterRefund(inv: {
  status: string;
  amount_paid_cents?: number | null;
  amount_refunded_cents?: number | null;
}): VoidAfterRefund {
  const r = invoiceRefundState(inv);
  if (r === "refunded") return { offered: true };
  if (r === "partly_refunded") {
    return {
      offered: false,
      reason:
        "Refund the rest of this invoice before voiding it. Part of the payment is still kept.",
    };
  }
  return { offered: false, reason: null };
}

/**
 * A void invoice that was paid and refunded before it was voided (#674).
 * `void_invoice` refuses a paid invoice, so `paid_at` on a void one is only
 * ever left there by `void_refunded_invoice`. Reports keep its sale on the
 * day it was billed and let the refund be the only deduction; an ordinary
 * void was never billed to anyone.
 */
export function voidedAfterRefund(inv: {
  status: string | null | undefined;
  paid_at?: string | null;
}): boolean {
  return inv.status === "void" && !!inv.paid_at;
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
