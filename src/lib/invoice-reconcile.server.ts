// Direct-against-Stripe reconciliation for tenant invoices paid via Checkout.
// The Connect webhook (/api/public/hooks/stripe) is the real-time path; this
// module is the fallback that survives webhook misconfiguration: it reads the
// invoice's checkout session on the org's connected account and applies the
// same paid-state transition. Safe to call repeatedly and concurrently with
// the webhook — the status flip is an atomic claim, so only one writer
// records the payment.
import type { SupabaseClient } from "@supabase/supabase-js";

type MarkPaidArgs = {
  invoiceId: string;
  organizationId: string;
  amountCents: number;
  currency: string;
  paymentIntentId: string | null;
  checkoutSessionId?: string | null;
  raw: unknown;
};

/** Flip an invoice to paid, record the payment, and queue the receipt email.
 *  Returns false when another writer (webhook or reconcile) already claimed
 *  the flip — the caller must not record anything in that case. */
export async function markInvoicePaidFromStripe(
  supabaseAdmin: SupabaseClient,
  args: MarkPaidArgs,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data: claimed, error } = await supabaseAdmin
    .from("invoices")
    .update({ status: "paid", paid_at: nowIso, stripe_payment_intent_id: args.paymentIntentId })
    .eq("id", args.invoiceId)
    .neq("status", "paid")
    .select("id, client_id");
  if (error) throw new Error(error.message);
  if (!claimed || claimed.length === 0) return false;
  const clientId = (claimed[0] as { client_id: string | null }).client_id;

  await supabaseAdmin.from("payments").insert({
    organization_id: args.organizationId,
    invoice_id: args.invoiceId,
    amount_cents: args.amountCents,
    currency: args.currency,
    status: "succeeded",
    stripe_checkout_session_id: args.checkoutSessionId ?? null,
    stripe_payment_intent_id: args.paymentIntentId,
    paid_at: nowIso,
    raw_event: JSON.parse(JSON.stringify(args.raw ?? null)),
  });

  // Activity timeline: payments are meaningful changes (spec). Service-role
  // write, so the actor is the payment processor, not a user.
  try {
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabaseAdmin, {
      orgId: args.organizationId,
      clientId,
      actorLabel: "Stripe",
      kind: "payment.received",
      summary: `Payment of $${(args.amountCents / 100).toFixed(2)} received for invoice #${args.invoiceId.slice(0, 8)}`,
    });
  } catch (e) {
    console.warn("payment activity log failed", e);
  }

  if (clientId) {
    try {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      await enqueueAppEmail({
        organizationId: args.organizationId,
        clientId,
        templateName: "payment-received",
        notifyKey: "notify_email_payment_received",
        idempotencyKey: `receipt-${args.invoiceId}`,
        templateData: {
          amountCents: args.amountCents,
          paidAt: new Date().toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          }),
        },
      });
    } catch (e) {
      console.error("receipt email failed", args.invoiceId, e);
    }
  }
  return true;
}

export type ReconcileOutcome =
  | "marked_paid"    // Stripe says paid; we flipped it just now
  | "already_paid"   // nothing to do (or another writer claimed the flip first)
  | "not_paid_yet"   // session/intent exists but hasn't been paid
  | "no_session"     // invoice has no checkout session or payment intent
  | "skipped";       // void/missing invoice, no connected account, or Stripe unreachable

/** Check the invoice's checkout session — and, for the inline Payment Element
 *  flow, its payment intent — on the org's connected account, and mark the
 *  invoice paid if Stripe says it is. Never throws. */
export async function reconcileInvoicePayment(invoiceId: string): Promise<ReconcileOutcome> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, status, total_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id")
      .eq("id", invoiceId)
      .maybeSingle();
    if (!inv) return "skipped";
    if (inv.status === "paid") return "already_paid";
    if (inv.status === "void") return "skipped";
    if (!inv.stripe_checkout_session_id && !inv.stripe_payment_intent_id) return "no_session";

    const { resolveOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(inv.organization_id);
    if (!acct) return "skipped";
    const stripe = await connectStripe();
    const acctOpts = { stripeAccount: acct.accountId };

    // 1) Hosted Checkout path (staff link + portal "Pay now" redirect).
    if (inv.stripe_checkout_session_id) {
      try {
        const session = await stripe.checkout.sessions.retrieve(
          inv.stripe_checkout_session_id, undefined, acctOpts);
        if (session.payment_status === "paid") {
          const pi = typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null;
          const ok = await markInvoicePaidFromStripe(supabaseAdmin, {
            invoiceId: inv.id,
            organizationId: inv.organization_id,
            amountCents: session.amount_total ?? inv.total_cents ?? 0,
            currency: session.currency ?? inv.currency ?? "usd",
            paymentIntentId: pi,
            checkoutSessionId: session.id,
            raw: { source: "reconcile", session_id: session.id, payment_status: session.payment_status },
          });
          return ok ? "marked_paid" : "already_paid";
        }
      } catch (e) {
        console.error("reconcile: session retrieve failed", invoiceId, e);
      }
    }

    // 2) Inline Payment Element path (PI stored on the invoice, no session).
    // The metadata check ties the PI to this exact invoice so a stale or
    // foreign intent id on the row can never mark it paid.
    if (inv.stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          inv.stripe_payment_intent_id, undefined, acctOpts);
        if (pi.status === "succeeded" && pi.metadata?.invoice_id === inv.id) {
          const ok = await markInvoicePaidFromStripe(supabaseAdmin, {
            invoiceId: inv.id,
            organizationId: inv.organization_id,
            amountCents: pi.amount ?? inv.total_cents ?? 0,
            currency: pi.currency ?? inv.currency ?? "usd",
            paymentIntentId: pi.id,
            raw: { source: "reconcile", payment_intent_id: pi.id, pi_status: pi.status },
          });
          return ok ? "marked_paid" : "already_paid";
        }
      } catch (e) {
        console.error("reconcile: payment intent retrieve failed", invoiceId, e);
      }
    }

    return "not_paid_yet";
  } catch (e) {
    console.error("invoice reconcile failed", invoiceId, e);
    return "skipped";
  }
}

export type PiSyncOutcome =
  | "none"        // no stored payment intent
  | "processing"  // an in-flight bank debit — the invoice IS being paid
  | "synced"      // confirmable intent updated to the current open amount
  | "canceled"    // nothing due (or invoice no longer open) — intent canceled
  | "other";      // succeeded/canceled/etc. — reconcile handles those

/** Keep a stored, still-confirmable PaymentIntent in step with the invoice's
 *  CURRENT open amount. Credit application shrinks the open amount after an
 *  intent may already be sitting in a client's open pay page; without this the
 *  client confirms the stale gross amount AND the credit is consumed. Called
 *  after every credit application. Never throws. */
export async function syncInvoicePaymentIntentAmount(invoiceId: string): Promise<PiSyncOutcome> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, status, total_cents, credit_applied_cents, currency, stripe_payment_intent_id")
      .eq("id", invoiceId)
      .maybeSingle();
    if (!inv?.stripe_payment_intent_id) return "none";

    const { resolveOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(inv.organization_id);
    if (!acct) return "other";
    const stripe = await connectStripe();
    const acctOpts = { stripeAccount: acct.accountId };

    const pi = await stripe.paymentIntents.retrieve(inv.stripe_payment_intent_id, undefined, acctOpts);
    if (pi.status === "processing") return "processing";
    const confirmable =
      pi.status === "requires_payment_method" ||
      pi.status === "requires_confirmation" ||
      pi.status === "requires_action";
    if (!confirmable) return "other";

    const dueCents = Math.max(
      (inv.total_cents ?? 0) - ((inv as { credit_applied_cents?: number | null }).credit_applied_cents ?? 0),
      0,
    );
    if (inv.status !== "open" || dueCents <= 0) {
      await stripe.paymentIntents.cancel(pi.id, {}, acctOpts);
      return "canceled";
    }
    if (pi.amount !== dueCents) {
      await stripe.paymentIntents.update(pi.id, { amount: dueCents }, acctOpts);
    }
    return "synced";
  } catch (e) {
    console.error("invoice PI amount sync failed", invoiceId, e);
    return "other";
  }
}

/** True when the invoice's stored PaymentIntent is an in-flight bank debit.
 *  Money paths must not apply credit or charge on top of a processing debit —
 *  both would collect twice when it clears. Never throws (unknown → false,
 *  the atomic paid-claim remains the last line of defense). */
export async function invoiceHasProcessingIntent(invoiceId: string): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv } = await supabaseAdmin
      .from("invoices")
      .select("id, organization_id, stripe_payment_intent_id")
      .eq("id", invoiceId)
      .maybeSingle();
    if (!inv?.stripe_payment_intent_id) return false;
    const { resolveOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await resolveOrgStripeAccount(inv.organization_id);
    if (!acct) return false;
    const stripe = await connectStripe();
    const pi = await stripe.paymentIntents.retrieve(
      inv.stripe_payment_intent_id, undefined, { stripeAccount: acct.accountId });
    return pi.status === "processing";
  } catch {
    return false;
  }
}

/** Sweep an org's open invoices that have a checkout session or payment
 *  intent attached. Returns how many were flipped to paid. */
export async function reconcileOpenInvoicesForOrg(orgId: string, limit = 25): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows } = await supabaseAdmin
    .from("invoices")
    .select("id")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .or("stripe_checkout_session_id.not.is.null,stripe_payment_intent_id.not.is.null")
    .order("updated_at", { ascending: false })
    .limit(limit);
  let flipped = 0;
  for (const r of rows ?? []) {
    if ((await reconcileInvoicePayment(r.id)) === "marked_paid") flipped++;
  }
  return flipped;
}
