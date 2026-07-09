import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Manually email an existing invoice to the client.
export const sendInvoiceEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: inv, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, period_start, period_end, clients(portal_token)")
      .eq("id", data.invoiceId)
      .single();
    if (error) throw new Error(error.message);
    const token = (inv as any).clients?.portal_token as string | undefined;
    const { buildPortalLink } = await import("@/lib/portal-links.server");
    const invoiceUrl =
      (await buildPortalLink(inv.organization_id, token)) ??
      (process.env.APP_URL || "https://app.houndstack.com");
    const period =
      inv.period_start && inv.period_end
        ? `Services from ${inv.period_start} to ${inv.period_end}`
        : undefined;
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const res = await enqueueAppEmail({
      organizationId: inv.organization_id,
      clientId: inv.client_id,
      templateName: "invoice-sent",
      notifyKey: "notify_email_invoice_sent",
      idempotencyKey: `invoice-sent-${inv.id}`,
      templateData: {
        amountCents: inv.total_cents,
        invoiceUrl,
        periodLabel: period,
      },
    });
    if (!res.ok) throw new Error(`Email not sent: ${res.reason}`);
    return { ok: true };
  });
