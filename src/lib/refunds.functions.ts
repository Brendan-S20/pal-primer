// Refund a customer from the invoice. The rules, the Stripe call and why the
// ledger is not written here are all in refunds.server.ts; these two server
// functions only authenticate, gate, and hand over.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  MANUAL_REFUND_KINDS,
  MANUAL_REFUND_REASON_MAX,
  MANUAL_REFUND_REASON_MIN,
  REFUND_NOTE_MAX,
  REFUND_PERMISSION,
  REFUND_REASONS,
} from "@/lib/refunds";

async function refundEnv(supabase: unknown) {
  const { connectStripe, resolveOrgStripeAccount } = await import("@/lib/stripe-connect.server");
  const { logActivity } = await import("@/lib/activity.server");
  const stripe = await connectStripe();
  return {
    supabase,
    stripe: stripe as unknown as import("@/lib/refunds.server").RefundStripe,
    // The same funnel the charge sites and the webhook's `accountMatches` use,
    // so the refund is made on the account the webhook will accept it from.
    accountFor: async (orgId: string) => (await resolveOrgStripeAccount(orgId))?.accountId ?? null,
    log: (entry: Parameters<typeof logActivity>[1]) => logActivity(supabase, entry),
  };
}

/** How much of a payment can still go back — read from Stripe when the
 *  dialog opens, so its default is the real remaining amount. */
export const getPaymentRefundQuote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ paymentId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, REFUND_PERMISSION);
    const { quoteRefund } = await import("@/lib/refunds.server");
    return quoteRefund(await refundEnv(supabase), orgId, data.paymentId);
  });

/** Send money back to the customer on a Stripe payment. */
export const refundInvoicePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        paymentId: z.string().uuid(),
        // Omitted: the full remaining refundable amount.
        amountCents: z.number().int().positive().max(100_000_000).optional(),
        reason: z.enum(REFUND_REASONS).optional(),
        note: z.string().trim().max(REFUND_NOTE_MAX).optional(),
        attemptId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, REFUND_PERMISSION);
    const { issueRefund } = await import("@/lib/refunds.server");
    return issueRefund(await refundEnv(supabase), { orgId, userId: context.userId }, data);
  });

/** Cash or a check given back, or reversed (a bounced check), with a reason
 *  (#653, F-09). One database call: refund_manual_payment marks the payment,
 *  files the dated reversal the reports deduct, and reopens a paid invoice a
 *  reversal leaves owing. */
export const recordManualRefund = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        paymentId: z.string().uuid(),
        amountCents: z.number().int().positive().max(100_000_000),
        reason: z.string().trim().min(MANUAL_REFUND_REASON_MIN).max(MANUAL_REFUND_REASON_MAX),
        kind: z.enum(MANUAL_REFUND_KINDS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, REFUND_PERMISSION);
    const { data: r, error } = await supabase.rpc("refund_manual_payment", {
      _payment_id: data.paymentId,
      _amount_cents: data.amountCents,
      _reason: data.reason,
      _reverse: data.kind === "reversal",
    });
    if (error) throw new Error(error.message);
    const out = r as unknown as {
      invoice_id: string;
      organization_id: string;
      client_id: string;
      amount_cents: number;
      reopened: boolean;
    };
    const { invoiceRef } = await import("@/lib/invoice-labels");
    const { logActivity } = await import("@/lib/activity.server");
    const dollars = `$${(out.amount_cents / 100).toFixed(2)}`;
    const verb = data.kind === "reversal" ? "Reversed" : "Refunded";
    await logActivity(supabase, {
      orgId: out.organization_id,
      clientId: out.client_id,
      actorUserId: context.userId,
      kind: "invoice.payment_refunded",
      summary: `${verb} ${dollars} on invoice ${await invoiceRef(supabase, out.invoice_id)}: ${data.reason}`,
    });
    return { amountCents: out.amount_cents, reopened: out.reopened };
  });
