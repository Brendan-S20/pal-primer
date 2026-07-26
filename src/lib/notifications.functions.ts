import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Manually email an existing invoice to the client. With reminder: true the
// same template renders as a payment reminder ("Reminder: …" subject), and
// the idempotency key is date-stamped so staff can re-remind on later days
// without the pipeline deduping it away (max one reminder per day).
export const sendInvoiceEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ invoiceId: z.string().uuid(), reminder: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Emailing an invoice (with its no-login pay link) is a billing action —
    // gate it and scope the lookup to the caller's own org so a foreign
    // invoice id can't leak another tenant's pay link.
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: invRow, error } = await supabase
      .from("invoices")
      .select("id, organization_id, client_id, total_cents, period_start, period_end, public_token, clients(portal_token)")
      .eq("id", data.invoiceId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);
    // public_token isn't in the generated types yet.
    const inv = invRow as any;
    // Prefer the no-login public pay link (QA round 8); fall back to the
    // portal link for any legacy invoice without a token.
    const publicToken = (inv as any).public_token as string | undefined;
    const appUrl = process.env.APP_URL || "https://app.houndstack.com";
    let invoiceUrl = publicToken ? `${appUrl}/pay/i/${publicToken}` : undefined;
    if (!invoiceUrl) {
      const token = (inv as any).clients?.portal_token as string | undefined;
      const { buildPortalLink } = await import("@/lib/portal-links.server");
      invoiceUrl = (await buildPortalLink(inv.organization_id, token)) ?? appUrl;
    }
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
      idempotencyKey: data.reminder
        ? `invoice-reminder-${inv.id}-${new Date().toISOString().slice(0, 10)}`
        : `invoice-sent-${inv.id}`,
      templateData: {
        amountCents: inv.total_cents,
        invoiceUrl,
        periodLabel: period,
        reminder: data.reminder === true,
      },
      // Explicit "Send invoice" / "Send reminder" button — a manual send that
      // bypasses the imported comms hold and clears it on success.
      manual: true,
    });
    if (!res.ok) throw new Error(`Email not sent: ${res.reason}`);
    // Stamp sent_at (full auto billing): a "Send now" during the grace window
    // takes the invoice out of the nightly auto-send loop, so the client can
    // never get the invoice email twice. Reminders don't re-stamp.
    if (!data.reminder) {
      await supabase
        .from("invoices")
        .update({ sent_at: new Date().toISOString() } as any)
        .eq("id", inv.id)
        .is("sent_at" as any, null);
    }
    // The email is QUEUED here (a cron flips it to sent/failed within ~1 min).
    // Return the log id + recipient so the UI can poll for the real outcome
    // rather than claim "emailed" before it actually sends (finding #32).
    const { data: recip } = await supabase
      .from("clients")
      .select("primary_email")
      .eq("id", inv.client_id)
      .maybeSingle();
    return { ok: true, messageId: res.messageId ?? null, recipient: recip?.primary_email ?? null };
  });

// Poll the email pipeline's outcome for a queued message (finding #32).
export const getEmailSendStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ messageId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("email_send_log")
      .select("status, recipient_email, error_message, created_at")
      .eq("message_id", data.messageId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    return {
      status: (row?.status ?? "pending") as string,
      recipient: row?.recipient_email ?? null,
      error: row?.error_message ?? null,
    };
  });
