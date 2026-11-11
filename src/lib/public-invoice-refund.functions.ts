// What a refunded invoice says on its own pay page (#674).
//
// /pay/i/{token} is read through getPublicInvoice (invoices.functions.ts),
// which does not return `amount_refunded_cents`, so a refunded invoice there
// still read Paid. This is the one extra column, by the same capability: the
// unguessable public_token. It returns the refund figure and nothing else,
// no name, no email, no other client PII, so it adds nothing to what the link
// already shows.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getPublicInvoiceRefund = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv, error } = await supabaseAdmin
      .from("invoices")
      .select("amount_refunded_cents")
      .eq("public_token", data.token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) return { found: false as const };
    return {
      found: true as const,
      amountRefundedCents: Number(
        (inv as { amount_refunded_cents: number | null }).amount_refunded_cents ?? 0,
      ),
    };
  });
