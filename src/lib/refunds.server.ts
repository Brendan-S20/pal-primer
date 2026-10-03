// Issuing a refund on a tenant's customer payment. The server half of
// src/lib/refunds.ts; the server functions in refunds.functions.ts are thin
// wrappers that build the environment below and call into here.
//
// Everything is passed in rather than imported so the rules can be tested
// against a fake Stripe and a fake database, and so no test can reach the real
// one by accident.
//
// ── HOW THE MONEY MOVES ───────────────────────────────────────────────────
//
// Every tenant charge is a DIRECT charge (platform-fee.ts, "HOW STRIPE APPLIES
// IT"): created with `{ stripeAccount }`, living on the tenant's connected
// account, settling into their balance. So the refund is made the same way —
// `refunds.create` with `{ stripeAccount }` as a REQUEST OPTION — and it comes
// out of the same balance the charge went into. Made without it, the call
// would look for the payment intent on the platform's own account and fail
// with "No such payment_intent".
//
// The account is the one the webhook will check the refund against:
// `resolveOrgStripeAccount(payment.organization_id)`, the single funnel every
// charge site, the embedded dashboard session and the webhook's
// `accountMatches` all use. For a franchise location whose franchise collects,
// that is the FRANCHISE's account, which is where the charge is.
//
// ── THE APPLICATION FEE: NOT HERE, ON PURPOSE ─────────────────────────────
//
// Neither `refund_application_fee` nor `reverse_transfer` is sent.
//
// `reverse_transfer` is a destination-charge parameter: it pulls money back
// from the connected account after the platform refunded the charge from its
// own balance. There is no transfer on a direct charge to reverse.
//
// `refund_application_fee` WOULD apply to a direct charge, and is left off
// so that there is exactly one theory of how our fee comes back. The
// `charge.refunded` branch of the Connect webhook already reverses it,
// proportionally, via `feeReversalCents` — computing the TOTAL that should
// have been returned by now and sending only the difference from what Stripe
// says has been. That is the path every refund a tenant makes in Stripe's own
// panel has always taken, and it is correct for partials and for replays.
// Setting the flag here as well would have Stripe return a proportional share
// in the same operation using ITS rounding, after which the webhook computes
// its target with OURS; the two can disagree by a cent, and the webhook would
// then send that cent. Harmless, but two actors on one number is how
// three-implementation bugs start. (`provisionSignup` does set the flag, and
// platform-fee.ts explains why that one is different: it unwinds a charge in
// full and writes no payment row.) The fee is zero today in any case —
// PLATFORM_FEE_BPS = 0 — so this is about the day it is not.
//
// ── THE LEDGER: ALSO NOT HERE ─────────────────────────────────────────────
//
// This function writes no reversal and does not touch `payments.status`.
// Stripe raises `charge.refunded` for a refund made through the API exactly as
// for one made in its dashboard, and that branch of
// src/routes/api/public/hooks/stripe.ts already:
//   - files the reversal via `file_reversal_review_item`, which
//     src/lib/reversals.server.ts reads for every revenue surface, with the
//     surcharge split from refund-split.ts;
//   - records the franchise adjustment on the revenue share;
//   - gives back prepaid credit for a refunded top-up;
//   - reverses our application fee (above);
//   - sets `payments.status = 'refunded'`.
// And `charge.refund.updated` walks it all back if the refund later fails.
// Writing any of that here as well would record the same refund twice the
// moment the webhook landed — which is the bug `file_reversal_review_item`'s
// raise-don't-add upsert exists to prevent, arriving from a new direction.
//
// ── THE AMOUNT ────────────────────────────────────────────────────────────
//
// What the office types is dollars back to the customer: a slice of the
// CHARGE, which is base + any card surcharge. The ceiling is therefore the
// charge's amount less its `amount_refunded`, read from Stripe at the moment
// of refunding. Not from a local column: `payments.status` flips to
// `refunded` on the first partial refund and carries no figure, and the
// reversal ledger is only as current as the last webhook. How much of a
// refund comes off revenue versus fee recovery is refund-split.ts's question,
// answered in the webhook from Stripe's cumulative figure; nothing here
// changes it.

import { splitRefund } from "@/lib/refund-split";
import { MANUAL_PAYMENT_METHODS } from "@/lib/manual-payments";
import { REFUND_REASON_LABELS, stripeRefundReason, type RefundReason } from "@/lib/refunds";

/** The slice of the Stripe client this module calls. Named so a test's fake
 *  has to have the same shape, and so it is visible that a refund needs
 *  nothing else. */
export interface RefundStripe {
  paymentIntents: {
    retrieve(
      id: string,
      params: { expand?: string[] },
      opts: { stripeAccount: string },
    ): Promise<{
      id: string;
      status?: string | null;
      latest_charge?: unknown;
    }>;
  };
  refunds: {
    create(
      params: {
        payment_intent: string;
        amount: number;
        reason?: "requested_by_customer" | "duplicate" | "fraudulent";
        metadata?: Record<string, string>;
      },
      opts: { stripeAccount: string; idempotencyKey: string },
    ): Promise<{ id: string; amount: number; status?: string | null }>;
  };
}

export type RefundEnv = {
  /** The caller's RLS-bound client. Every read goes through it, so a payment
   *  in another org is not merely refused but never seen. */
  supabase: any;
  stripe: RefundStripe;
  /** The connected account the org's charges are made on, or null. */
  accountFor: (orgId: string) => Promise<string | null>;
  /** Timeline entry. Best-effort: a failure here must not look like a failed
   *  refund, because the money has already moved. */
  log?: (entry: {
    orgId: string;
    clientId: string | null;
    actorUserId: string;
    kind: string;
    summary: string;
    meta?: Record<string, unknown>;
  }) => Promise<void>;
};

export type RefundRequest = {
  paymentId: string;
  /** Omitted: everything still refundable. */
  amountCents?: number;
  reason?: RefundReason;
  note?: string;
  /** Minted by the dialog when it opens. The same attempt sent twice — a
   *  double tap, a retried request — is the same refund. */
  attemptId: string;
};

export type RefundQuote = {
  paymentId: string;
  invoiceId: string;
  currency: string;
  /** Base + surcharge: what the card was charged. */
  chargedCents: number;
  /** The recovered card fee inside that charge. */
  surchargeCents: number;
  /** The customer's tip inside that charge. */
  tipCents: number;
  /** The sales tax inside the invoiced part of that charge. Optional so a
   *  quote from before sales tax existed still reads as "no tax". */
  taxCents?: number;
  /** Stripe's cumulative `amount_refunded`. */
  refundedCents: number;
  /** What can still go back. */
  refundableCents: number;
};

/** A refusal the office should read as-is. Separate from an unexpected
 *  failure so a test can tell "the rule said no" from "something broke". */
export class RefundRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRefused";
  }
}

export function formatUsd(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(cents / 100);
}

function isMissingOnAccount(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return (
    err?.code === "resource_missing" || /no such (payment_intent|charge)/i.test(err?.message ?? "")
  );
}

type Loaded = {
  quote: RefundQuote;
  stripeAccount: string;
  paymentIntentId: string;
  organizationId: string;
};

/**
 * Load a payment and ask Stripe how much of it can still go back. Every
 * refusal that does not depend on the amount lives here, so the dialog's
 * opening read and the refund itself refuse the same things in the same words.
 */
async function loadRefundable(env: RefundEnv, orgId: string, paymentId: string): Promise<Loaded> {
  const { data: pay, error } = await env.supabase
    .from("payments")
    .select(
      "id, organization_id, invoice_id, amount_cents, surcharge_cents, tip_cents, tax_cents, currency, status, method, stripe_payment_intent_id",
    )
    .eq("id", paymentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Checked again in code, not left to the query filter and RLS. This is the
  // line that decides whose money moves, and it should not depend on the
  // client passed in being the RLS-bound one.
  if (!pay || pay.organization_id !== orgId) throw new RefundRefused("Payment not found.");

  const method = (pay.method ?? null) as string | null;
  if (method && (MANUAL_PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new RefundRefused(
      "This payment was recorded by hand, so no money went through Stripe and there is nothing to refund here. Give it back the way it came in.",
    );
  }
  const paymentIntentId = pay.stripe_payment_intent_id as string | null;
  if (!paymentIntentId) {
    // Also the right answer for a row that only ever had a checkout session:
    // the webhook finds a refund's payment by its payment intent, so a refund
    // on a payment with none would move money the ledger could never record.
    throw new RefundRefused(
      "This payment has no Stripe charge on record, so it can't be refunded from here.",
    );
  }
  if (pay.status !== "succeeded" && pay.status !== "refunded") {
    throw new RefundRefused("Only a payment that went through can be refunded.");
  }

  const stripeAccount = await env.accountFor(orgId);
  if (!stripeAccount) {
    throw new RefundRefused(
      "This business has no connected Stripe account, so the refund can't be sent. Check the Payments page.",
    );
  }

  let pi: Awaited<ReturnType<RefundStripe["paymentIntents"]["retrieve"]>>;
  try {
    pi = await env.stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] },
      { stripeAccount },
    );
  } catch (e) {
    if (isMissingOnAccount(e)) {
      // A connected-account cutover orphans every charge made on the old
      // account; so does a location whose collection routing changed after
      // this payment. Either way the charge exists, just not where we are
      // looking, and the owner needs to know where to go instead.
      throw new RefundRefused(
        "Stripe can't find this charge on the connected account. It may have been taken on a previous Stripe account; refund it from that account's Stripe dashboard.",
      );
    }
    throw e;
  }

  const charge = (typeof pi.latest_charge === "object" ? pi.latest_charge : null) as {
    id?: string;
    amount?: number;
    amount_refunded?: number;
    refunded?: boolean;
    status?: string;
    currency?: string;
  } | null;
  if (!charge || charge.status !== "succeeded") {
    throw new RefundRefused(
      "Stripe has no completed charge for this payment, so there is nothing to refund.",
    );
  }

  const chargedCents = Number(charge.amount ?? 0);
  const refundedCents = Number(charge.amount_refunded ?? 0);
  const refundableCents = Math.max(chargedCents - refundedCents, 0);
  if (charge.refunded || refundableCents <= 0) {
    throw new RefundRefused("This payment has already been refunded in full.");
  }

  return {
    stripeAccount,
    paymentIntentId,
    organizationId: pay.organization_id,
    quote: {
      paymentId: pay.id,
      invoiceId: pay.invoice_id,
      currency: String(charge.currency ?? pay.currency ?? "usd"),
      chargedCents,
      surchargeCents: Math.max(Number(pay.surcharge_cents ?? 0), 0),
      tipCents: Math.max(Number(pay.tip_cents ?? 0), 0),
      taxCents: Math.max(Number((pay as { tax_cents?: number | null }).tax_cents ?? 0), 0),
      refundedCents,
      refundableCents,
    },
  };
}

/** What the dialog opens on: the ceiling and the default, from Stripe. */
export async function quoteRefund(
  env: RefundEnv,
  orgId: string,
  paymentId: string,
): Promise<RefundQuote> {
  return (await loadRefundable(env, orgId, paymentId)).quote;
}

/**
 * The idempotency key for one refund attempt.
 *
 * Built from the dialog's attempt id rather than from anything read off
 * Stripe. The obvious alternative — the payment plus how much was already
 * refunded — protects the two taps that race, but not the second tap that
 * arrives after the first finished: it reads the NEW refunded total, builds a
 * new key, and a partial refund goes out twice. The attempt id is the same
 * for both taps whatever order they land in.
 *
 * The amount is in the key so an attempt whose amount was edited after a
 * failure is a new request rather than a replay of the old one with different
 * parameters, which Stripe rejects as an idempotency_error.
 */
export function refundIdempotencyKey(
  paymentId: string,
  attemptId: string,
  amountCents: number,
): string {
  return `invoice-refund-${paymentId}-${attemptId}-${amountCents}`;
}

export async function issueRefund(
  env: RefundEnv,
  caller: { orgId: string; userId: string },
  req: RefundRequest,
): Promise<{
  refundId: string;
  amountCents: number;
  status: string;
  remainingCents: number;
  currency: string;
}> {
  const loaded = await loadRefundable(env, caller.orgId, req.paymentId);
  const { quote } = loaded;

  const amount = req.amountCents ?? quote.refundableCents;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new RefundRefused("Enter an amount to refund.");
  }
  if (amount > quote.refundableCents) {
    throw new RefundRefused(
      quote.refundedCents > 0
        ? `Only ${formatUsd(quote.refundableCents, quote.currency)} of this payment is left to refund. ${formatUsd(quote.refundedCents, quote.currency)} has already gone back.`
        : `A refund can't be more than the ${formatUsd(quote.chargedCents, quote.currency)} that was charged.`,
    );
  }

  const note = (req.note ?? "").trim();
  const metadata: Record<string, string> = {
    houndstack_payment_id: quote.paymentId,
    invoice_id: quote.invoiceId,
    organization_id: loaded.organizationId,
    refunded_by_user_id: caller.userId,
    source: "invoice_refund",
  };
  if (req.reason) metadata.reason = req.reason;
  if (note) metadata.note = note;

  const stripeReason = stripeRefundReason(req.reason);
  const refund = await env.stripe.refunds.create(
    {
      payment_intent: loaded.paymentIntentId,
      amount,
      ...(stripeReason ? { reason: stripeReason } : {}),
      metadata,
    },
    {
      stripeAccount: loaded.stripeAccount,
      idempotencyKey: refundIdempotencyKey(quote.paymentId, req.attemptId, amount),
    },
  );

  if (env.log) {
    try {
      const { data: inv } = await env.supabase
        .from("invoices")
        .select("client_id")
        .eq("id", quote.invoiceId)
        .maybeSingle();
      const split = splitRefund(
        amount,
        quote.chargedCents,
        quote.surchargeCents,
        quote.tipCents,
        quote.taxCents ?? 0,
      );
      const why = req.reason ? ` (${REFUND_REASON_LABELS[req.reason].toLowerCase()})` : "";
      await env.log({
        orgId: caller.orgId,
        clientId: (inv?.client_id as string | null) ?? null,
        actorUserId: caller.userId,
        kind: "invoice.refunded",
        summary: `Refunded ${formatUsd(amount, quote.currency)} to the client${why}`,
        meta: {
          invoice_id: quote.invoiceId,
          payment_id: quote.paymentId,
          refund_id: refund.id,
          amount_cents: amount,
          // The same split the webhook will file, for whoever reads the
          // timeline next to a revenue figure and wonders why they differ.
          revenue_cents: split.revenueCents,
          surcharge_cents: split.surchargeCents,
          tip_cents: split.tipCents,
          tax_cents: split.taxCents,
          reason: req.reason ?? null,
          note: note || null,
        },
      });
    } catch (e) {
      console.warn("[refund] activity entry failed; the refund itself went through", e);
    }
  }

  return {
    refundId: refund.id,
    amountCents: Number(refund.amount ?? amount),
    status: String(refund.status ?? "pending"),
    remainingCents: quote.refundableCents - amount,
    currency: quote.currency,
  };
}

/**
 * Cumulative refunded cents per payment, from the reversal ledger — for the
 * payment rows on an invoice. The ledger rather than Stripe because this runs
 * on every invoice open and needs no network; it is as current as the last
 * `charge.refunded`, which is seconds. The dialog asks Stripe itself before
 * anything moves.
 */
export async function refundedCentsByPayment(
  supabase: any,
  orgId: string,
  paymentIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(paymentIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("review_items")
    .select("subject_id, detail")
    .eq("organization_id", orgId)
    .eq("kind", "payment_refunded")
    .in("subject_id", ids);
  // Best-effort: a role that cannot read the review queue still sees its
  // payments, just without the refunded figure.
  if (error) return out;
  for (const r of data ?? []) {
    const cents = Number(r?.detail?.amount_cents ?? 0);
    if (r?.subject_id && cents > 0) {
      out.set(r.subject_id, Math.max(out.get(r.subject_id) ?? 0, cents));
    }
  }
  return out;
}
