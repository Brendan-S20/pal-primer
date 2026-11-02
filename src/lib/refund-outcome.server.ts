/* eslint-disable @typescript-eslint/no-explicit-any -- the Supabase client is passed in so a test can hand it a fake, as in refunds.server.ts */
// The two writes a refund makes besides the reversal ledger (#674, #675),
// called from the Stripe webhook's `charge.refunded` and
// `charge.refund.updated` branches — the only place a tenant refund is
// recorded, whether it was made from the invoice (refunds.server.ts) or in
// Stripe's own panel.
//
// The client is the webhook's SERVICE-ROLE `supabaseAdmin`, passed in so a
// test can hand it a fake, and named for what it must be: `payments` has no
// UPDATE policy, so the caller's RLS client would update zero rows and report
// success (tests/payments-and-connect-are-platform-owned.test.ts). Both writes
// are best-effort and log rather than throw: the reversal ledger and the
// payment's status are the facts that have to land, and these follow them.

import {
  invoicedShareRefunded,
  signupRefundPatch,
  type RefundablePayment,
  type SignupRefundRow,
} from "@/lib/refund-outcome";

/**
 * Write `payments.refunded_cents` — the part of `amount_cents` that went back
 * — from Stripe's cumulative `amount_refunded`. The payments trigger then
 * moves the invoice's `amount_paid_cents` and `amount_refunded_cents`.
 *
 * Only ever RAISES the figure unless `authoritative`: `charge.refunded` events
 * can arrive out of order, and an older one carries a smaller cumulative
 * figure. `charge.refund.updated` re-reads the charge from Stripe, so its
 * figure is current and may lower it (a refund that failed).
 */
export async function recordRefundOnPayment(
  supabaseAdmin: any,
  pay: RefundablePayment & { id: string },
  amountRefundedCents: number,
  opts: { authoritative?: boolean } = {},
): Promise<number> {
  const share = invoicedShareRefunded(amountRefundedCents, pay);
  try {
    let q = supabaseAdmin.from("payments").update({ refunded_cents: share }).eq("id", pay.id);
    if (!opts.authoritative) q = q.lt("refunded_cents", share);
    const { error } = await q;
    if (error) console.error("payment refunded_cents write failed", { paymentId: pay.id }, error);
  } catch (e) {
    console.error("payment refunded_cents write failed", { paymentId: pay.id }, e);
  }
  return share;
}

/**
 * Record a refund on the provisioned signup this payment bought (#675).
 *
 * `signup_requests.stripe_refund_id / refunded_at / refunded_amount_cents`
 * were written only by `provisionSignup`, when provisioning failed and the
 * webhook refunded the charge itself. A business that later refunded a
 * signup it HAD provisioned left all three null, so Leads still said
 * "Started service online" for somebody who had their money back.
 *
 * Found by the charge's payment intent, which the signup row carries for
 * both the Checkout and the inline Payment Element flows, within the org the
 * payment belongs to.
 */
export async function recordRefundOnSignup(
  supabaseAdmin: any,
  where: { organizationId: string; paymentIntentId: string },
  ev: { refundId: string | null; amountRefundedCents: number; at: string; authoritative?: boolean },
): Promise<Partial<SignupRefundRow> | null> {
  try {
    const { data: sr, error } = await supabaseAdmin
      .from("signup_requests")
      .select("id, status, refunded_at, stripe_refund_id, refunded_amount_cents")
      .eq("organization_id", where.organizationId)
      .eq("stripe_payment_intent_id", where.paymentIntentId)
      .eq("status", "provisioned")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("signup refund lookup failed", where, error);
      return null;
    }
    const patch = signupRefundPatch(sr ?? null, ev);
    if (!patch || !sr?.id) return null;
    const { error: upErr } = await supabaseAdmin
      .from("signup_requests")
      .update(patch)
      .eq("id", sr.id);
    if (upErr) {
      console.error("signup refund write failed", { signupRequestId: sr.id }, upErr);
      return null;
    }
    return patch;
  } catch (e) {
    console.error("signup refund write failed", where, e);
    return null;
  }
}
