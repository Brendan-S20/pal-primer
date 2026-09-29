// Refund a customer from the invoice. The rules, the Stripe call and why the
// ledger is not written here are all in refunds.server.ts; these two server
// functions only authenticate, gate, and hand over.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { REFUND_NOTE_MAX, REFUND_PERMISSION, REFUND_REASONS } from "@/lib/refunds";

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
