// Refunding a customer from the invoice, rather than from Stripe's own panel.
//
// Until this existed the only way to give a customer money back was the
// embedded Connect "Payments" component on /payments. Below 1024px that
// component is deliberately replaced by `NeedsAWiderScreen` (its controls are too
// small to hit and we cannot resize them), so an owner standing in a driveway
// with a phone could not refund anybody at all. The invoice is where the money
// came in, so it is where it goes back out.
//
// This file is the half both sides share: the reasons a person can pick, how
// each maps onto the three Stripe knows about, and the rule for whether a
// payment row gets a Refund button at all. It imports nothing server-side, so
// the dialog can read it. The half that talks to Stripe is refunds.server.ts.

import { holdsPermission, type Permission } from "@/lib/permissions";
import type { AppRole } from "@/hooks/useMyRole";

/** Who may refund. The same capability every other money-moving invoice action
 *  is gated on: charging the saved card, taking a payment, marking paid and
 *  voiding all ask `manage_client_billing`. A refund is the same money going
 *  the other way, so a role that can take it can return it — and a role that
 *  cannot take it (dispatcher, tech) cannot return it either. */
export const REFUND_PERMISSION: Permission = "manage_client_billing";

/** What the office picks. Deliberately in their words rather than Stripe's. */
export const REFUND_REASONS = [
  "requested_by_customer",
  "service_problem",
  "duplicate",
  "fraudulent",
  "other",
] as const;

export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  requested_by_customer: "Customer asked for it",
  service_problem: "Problem with the service",
  duplicate: "Charged twice",
  fraudulent: "Fraudulent charge",
  other: "Other",
};

/**
 * The value sent as Stripe's `reason`, which accepts exactly three.
 *
 * `service_problem` is a customer asking for their money back, which is what
 * `requested_by_customer` means to Stripe. `other` sends NO reason rather than
 * guessing one: `fraudulent` in particular is not a label but an instruction —
 * Stripe adds the card to the account's block list and uses it to train Radar —
 * so it is only ever sent when somebody picked it. The office's own choice and
 * note travel in metadata either way, so nothing they typed is lost.
 */
export function stripeRefundReason(
  reason: RefundReason | undefined,
): "requested_by_customer" | "duplicate" | "fraudulent" | undefined {
  switch (reason) {
    case "requested_by_customer":
    case "service_problem":
      return "requested_by_customer";
    case "duplicate":
      return "duplicate";
    case "fraudulent":
      return "fraudulent";
    default:
      return undefined;
  }
}

/** Stripe caps a metadata value at 500 characters. */
export const REFUND_NOTE_MAX = 500;

/**
 * Dollars as typed into the amount field, to whole cents — or null when it is
 * not an amount. Accepts "45", "45.5", "45.50", "$1,045.50". Refuses a third
 * decimal rather than rounding it: a refund field that silently turns 45.555
 * into 45.56 is sending an amount nobody typed.
 */
export function parseRefundAmount(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** The fields of a payment row this rule reads. */
export type RefundablePaymentRow = {
  status: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number | null;
  surcharge_cents?: number | null;
  tip_cents?: number | null;
  /** Cumulative refunded, from the reversal ledger, when the caller has it. */
  refunded_cents?: number | null;
};

/**
 * Whether a payment row gets a Refund button.
 *
 * This is the UI's gate and it is COSMETIC: `refundInvoicePayment` asks the
 * same permission itself and re-checks every refusal against Stripe. What this
 * decides is only whether a control is drawn, and the two halves of it are
 * both real faults if wrong. A dispatcher shown a Refund button presses it and
 * gets "Not authorized" — a control that promises something the product will
 * not do. A cash payment shown one presses it and gets told nothing went
 * through Stripe, which is true but is the button's fault for being there.
 *
 * `refunded` is not excluded by status alone. The webhook sets it on the FIRST
 * refund, partial or not, so a $100 payment with $30 refunded reads
 * `refunded` and still has $70 a customer may be owed. Only the ledger's
 * cumulative figure can say it is spent, and when that is absent the button
 * stays and the server answers.
 */
export function canOfferRefund(
  role: AppRole | null | undefined,
  payment: RefundablePaymentRow,
  // The configured set (#863), from usePermissions().permissions; the role's
  // defaults when absent.
  permissions?: readonly Permission[] | null,
): boolean {
  if (!holdsPermission(role, REFUND_PERMISSION, permissions)) return false;
  if (!payment.stripe_payment_intent_id) return false;
  if (payment.status !== "succeeded" && payment.status !== "refunded") return false;
  const charged =
    (payment.amount_cents ?? 0) + (payment.surcharge_cents ?? 0) + (payment.tip_cents ?? 0);
  if (charged <= 0) return false;
  const refunded = payment.refunded_cents ?? 0;
  return refunded < charged;
}

// ── Cash and checks (#653, F-09) ────────────────────────────────────────────
//
// Money that never went through Stripe cannot be refunded through it. The
// office records what happened instead, against the payment, and must say
// why: refund_manual_payment (20261102160000) refuses a reason shorter than
// this, and refuses a second record on the same payment.

export const MANUAL_REFUND_REASON_MIN = 3;
export const MANUAL_REFUND_REASON_MAX = 300;

/** "refund": the money went back to the customer. "reversal": it never really
 *  arrived (a bounced check, a payment recorded in error), so a paid invoice
 *  is owed again. */
export const MANUAL_REFUND_KINDS = ["refund", "reversal"] as const;
export type ManualRefundKind = (typeof MANUAL_REFUND_KINDS)[number];

/** Whether a payment row gets "Record refund": a billing role, a payment
 *  taken outside Stripe that succeeded, with nothing recorded against it yet.
 *  Cosmetic, like canOfferRefund; the database asks again. */
export function canRecordManualRefund(
  role: AppRole | null | undefined,
  payment: RefundablePaymentRow,
  permissions?: readonly Permission[] | null,
): boolean {
  if (!holdsPermission(role, REFUND_PERMISSION, permissions)) return false;
  if (payment.stripe_payment_intent_id) return false;
  if (payment.status !== "succeeded") return false;
  if ((payment.amount_cents ?? 0) <= 0) return false;
  return (payment.refunded_cents ?? 0) === 0;
}

/** Why a reason cannot be recorded, or null. */
export function manualRefundReasonProblem(reason: string): string | null {
  const t = reason.trim();
  if (t.length < MANUAL_REFUND_REASON_MIN) return "Say why the money is going back.";
  if (t.length > MANUAL_REFUND_REASON_MAX)
    return `Keep the reason to ${MANUAL_REFUND_REASON_MAX} characters.`;
  return null;
}
