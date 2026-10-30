import { createServerFn } from "@tanstack/react-start";
import { invoiceEmailTaxData } from "@/lib/sales-tax";
import { invoiceDueCents } from "@/lib/ar";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { appOrigin } from "@/lib/app-origin";
import { invoiceEmailDetails } from "@/lib/invoice-email-details";

// Manually email an existing invoice to the client. With reminder: true the
// same template renders as a payment reminder ("Reminder: …" subject), and
// the idempotency key is date-stamped so staff can re-remind on later days
// without the pipeline deduping it away (max one reminder per day).
//
// With firstSend: true (the New invoice dialog) it sends only if the invoice
// has never been sent, and claims sent_at before it queues anything, so a
// double click or a retry that reaches here twice sends one email (#607).
export const sendInvoiceEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        invoiceId: z.string().uuid(),
        reminder: z.boolean().optional(),
        firstSend: z.boolean().optional(),
      })
      .parse(d),
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
      .select(
        "id, number, due_on, organization_id, client_id, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, credit_applied_cents, amount_paid_cents, period_start, period_end, public_token, clients(portal_token, default_payment_method_id)",
      )
      .eq("id", data.invoiceId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);
    const inv = invRow;
    const { data: lineRows, error: lErr } = await supabase
      .from("invoice_line_items")
      .select("description, quantity, unit_amount_cents, amount_cents")
      .eq("invoice_id", inv.id)
      .order("created_at");
    if (lErr) throw new Error(lErr.message);
    const recipient = async () => {
      const { data: recip } = await supabase
        .from("clients")
        .select("primary_email")
        .eq("id", inv.client_id)
        .maybeSingle();
      return recip?.primary_email ?? null;
    };
    // Prefer the no-login public pay link (QA round 8); fall back to the
    // portal link for any legacy invoice without a token.
    const publicToken = inv.public_token;
    const appUrl = appOrigin();
    let invoiceUrl = publicToken ? `${appUrl}/pay/i/${publicToken}` : undefined;
    if (!invoiceUrl) {
      const token = inv.clients?.portal_token ?? undefined;
      const { buildPortalLink } = await import("@/lib/portal-links.server");
      invoiceUrl = (await buildPortalLink(inv.organization_id, token)) ?? appUrl;
    }
    const period =
      inv.period_start && inv.period_end
        ? `Services from ${inv.period_start} to ${inv.period_end}`
        : undefined;
    // No card on file yet: offer the portal's card form under the pay button,
    // so the client can put one on file without the office taking payment.
    let cardUrl: string | undefined;
    if (inv.clients?.portal_token && !inv.clients.default_payment_method_id) {
      const { buildPortalCardLink } = await import("@/lib/portal-links.server");
      cardUrl = await buildPortalCardLink(inv.organization_id, inv.clients.portal_token);
    }
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    // The invoice itself, as a PDF, for the customer's records. Read with the
    // service-role client because the email pipeline is (the invoice was
    // just loaded above through the caller's own client, org-scoped). Drawn
    // only if the email is actually going, and never throws: no PDF means the
    // email goes without one, not that it does not go.
    const pdfAttachment = async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { invoicePdfAttachment } = await import("@/lib/document-pdf.server");
      const pdf = await invoicePdfAttachment(supabaseAdmin, inv.id);
      return pdf ? [pdf] : [];
    };
    // First send only: take sent_at now, atomically. Whoever does not get it
    // was beaten to it by a send that is already on its way.
    const firstSend = data.firstSend === true && !data.reminder;
    let claimedAt: string | null = null;
    if (firstSend) {
      claimedAt = new Date().toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("invoices")
        .update({ sent_at: claimedAt } as any)
        .eq("id", inv.id)
        .is("sent_at" as any, null)
        .select("id");
      if (claimErr) throw new Error(claimErr.message);
      if (!claimed?.length) {
        return { ok: true, messageId: null, recipient: await recipient(), alreadySent: true };
      }
    }
    // Hand a first-send claim back, so the Send button can try again.
    const releaseClaim = async () => {
      if (!claimedAt) return;
      await supabase
        .from("invoices")
        .update({ sent_at: null } as any)
        .eq("id", inv.id)
        .eq("sent_at" as any, claimedAt);
    };
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
        ...invoiceEmailDetails(inv, lineRows ?? []),
        ...(cardUrl ? { cardUrl } : {}),
        // Partly paid: the email says what was paid and what is left, so a
        // reminder does not ask for money that already arrived.
        ...((inv.amount_paid_cents ?? 0) > 0
          ? { amountPaidCents: inv.amount_paid_cents, balanceCents: invoiceDueCents(inv) }
          : {}),
        // Sales tax, only when there is some: the email for an untaxed
        // invoice carries exactly the data it always did.
        ...invoiceEmailTaxData(inv),
      },
      // Explicit "Send invoice" / "Send reminder" button — a manual send that
      // bypasses the imported comms hold and clears it on success.
      manual: true,
      attachments: pdfAttachment,
    }).catch(async (e) => {
      await releaseClaim();
      throw e;
    });
    if (!res.ok) {
      await releaseClaim();
      throw new Error(`Email not sent: ${res.reason}`);
    }
    // Stamp sent_at (full auto billing): a "Send now" during the grace window
    // takes the invoice out of the nightly auto-send loop, so the client can
    // never get the invoice email twice. Reminders don't re-stamp.
    if (!data.reminder && !claimedAt) {
      await supabase
        .from("invoices")
        .update({ sent_at: new Date().toISOString() } as any)
        .eq("id", inv.id)
        .is("sent_at" as any, null);
    }
    // The email is QUEUED here (a cron flips it to sent/failed within ~1 min).
    // Return the log id + recipient so the UI can poll for the real outcome
    // rather than claim "emailed" before it actually sends (finding #32).
    return { ok: true, messageId: res.messageId ?? null, recipient: await recipient() };
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
