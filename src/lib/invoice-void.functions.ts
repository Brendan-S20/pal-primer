// Void after a full refund (#674). Nov 10 2026, the owner: "Allow Void after
// a refund".
//
// `voidInvoice` (invoices.functions.ts) is for an UNPAID invoice: the
// database refuses a paid one, and the app then cancels the pay page's
// PaymentIntent on Stripe. This one is for a paid invoice whose money all
// went back, and it is record only. It makes no Stripe call of any kind: no
// refund, no reversal of one, no charge, no intent to cancel, because the
// intent that paid it succeeded long ago. The database function refuses a
// partly refunded invoice (refund the rest first), keeps paid_at and both
// amounts, and releases the visit lines so the visit can be invoiced again
// once. Nothing is sent to the client; the audit entry is the only trace.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { invoiceRef } from "@/lib/invoice-labels";
import { refuseIfChanged } from "@/lib/stale-write";

export const voidRefundedInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        // What getInvoice returned as `version` (#655): a refund or a void
        // somebody else saved since makes this one refuse rather than land.
        expectedVersion: z.string().max(64).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // The roles that may void stay as they are today; the database asks the
    // same question again with has_permission.
    await requirePermission(context.supabase, context.userId, "manage_client_billing");

    if (data.expectedVersion !== undefined) {
      const { data: inv, error } = await context.supabase
        .from("invoices")
        .select("updated_at")
        .eq("id", data.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!inv) throw new Error("Invoice not found");
      refuseIfChanged(inv.updated_at, data.expectedVersion);
    }

    // Not in the generated types yet (#870 owns them); the function is in
    // supabase/migrations/20261111010000_a-refunded-invoice-can-be-voided.sql.
    const db = context.supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
    const { error } = await db.rpc("void_refunded_invoice", {
      _invoice_id: data.id,
    });
    if (error) throw new Error(error.message);

    const { data: inv } = await context.supabase
      .from("invoices")
      .select("organization_id, client_id")
      .eq("id", data.id)
      .single();
    if (inv) {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(context.supabase, {
        orgId: inv.organization_id,
        clientId: inv.client_id,
        actorUserId: context.userId,
        kind: "invoice.voided",
        summary: `Voided invoice ${await invoiceRef(context.supabase, data.id)} after its full refund. No money moved.`,
      });
    }
    return { ok: true as const };
  });
