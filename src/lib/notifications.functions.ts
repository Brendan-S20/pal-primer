import { createServerFn } from "@tanstack/react-start";
import { invoiceEmailTaxData } from "@/lib/sales-tax";
import { invoiceDueCents } from "@/lib/ar";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { appOrigin } from "@/lib/app-origin";
import { invoiceEmailDetails } from "@/lib/invoice-email-details";
import { invoiceSendKey } from "@/lib/email/invoice-send-key";
import type { EmailLogRow } from "@/lib/email/send-status";

// Manually email an existing invoice to the client. With reminder: true the
// same template renders as a payment reminder ("Reminder: …" subject), and
// the idempotency key is date-stamped so staff can re-remind on later days
// without the pipeline deduping it away (max one reminder per day).
//
// With firstSend: true (the New invoice dialog) it sends only if the invoice
// has never been sent, and queues under a message id derived from the
// invoice, so a double click or a retry that reaches here twice sends one
// email (#607): the queue processor refuses a message id it has sent, and
// Resend refuses a repeated Idempotency-Key.
//
// sent_at is NOT taken here. It is taken by the queue processor when the
// provider accepts the email (#612). Before, it was taken on queueing, so an
// invoice with email off read "Sent" and nobody had it. With no provider, or
// any other reason it cannot go, this returns ok: false with the pay link for
// the office to send by hand.
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
        "id, number, due_on, organization_id, client_id, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, credit_applied_cents, amount_paid_cents, period_start, period_end, public_token, sent_at, clients(portal_token, default_payment_method_id)",
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
    // First send only: an invoice the provider has already taken is not
    // emailed again by a second click.
    const firstSend = data.firstSend === true && !data.reminder;
    if (firstSend && (inv as { sent_at?: string | null }).sent_at) {
      return { ok: true, messageId: null, recipient: await recipient(), alreadySent: true };
    }
    const res = await enqueueAppEmail({
      organizationId: inv.organization_id,
      clientId: inv.client_id,
      templateName: "invoice-sent",
      notifyKey: "notify_email_invoice_sent",
      idempotencyKey: data.reminder
        ? `invoice-reminder-${inv.id}-${new Date().toISOString().slice(0, 10)}`
        : invoiceSendKey(inv.id),
      oncePerKey: firstSend,
      // No provider, no "Sent": the office is told and given the link.
      requireProvider: true,
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
    });
    const handle = async (messageId: string) => {
      const { signEmailStatusHandle } = await import("@/lib/email/status-handle.server");
      return signEmailStatusHandle(orgId, { kind: "invoice", id: inv.id }, messageId);
    };
    if (!res.ok) {
      // A first send whose earlier message exists. Only the provider having
      // taken it is "already sent" (#612 review): one still queued is polled
      // like a new one, and one that dead-lettered is not sent.
      if (res.reason === "already_sent" && res.messageId) {
        if (res.prior === "sent") {
          await supabase
            .from("invoices")
            .update({ sent_at: new Date().toISOString() })
            .eq("id", inv.id)
            .is("sent_at", null);
          return {
            ok: true,
            statusHandle: null,
            recipient: await recipient(),
            alreadySent: true,
          };
        }
        if (res.prior === "queued") {
          return {
            ok: true,
            statusHandle: await handle(res.messageId),
            recipient: await recipient(),
            link: invoiceUrl,
          };
        }
      }
      return {
        ok: false,
        reason: res.reason ?? "enqueue_failed",
        statusHandle: null,
        recipient: await recipient(),
        link: invoiceUrl,
      };
    }
    // The email is QUEUED here (a cron flips it to sent/failed within ~1 min).
    // Return a handle the page can poll for the real outcome rather than
    // claim "emailed" before it actually sends (finding #32).
    return {
      ok: true,
      statusHandle: res.messageId ? await handle(res.messageId) : null,
      recipient: await recipient(),
      link: invoiceUrl,
    };
  });

// Poll the email pipeline's outcome for a queued message (finding #32).
//
// The send log is service-role only, so reading it through the caller's
// client always came back empty and every poll said "pending" (#612 review).
// It is read as the service role now, and only for a handle signed to the
// caller's organization naming an invoice or client the caller can read.
export const getEmailSendStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ handle: z.string().max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    const { resolveCaller } = await import("@/lib/authz.server");
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { emailStatusForHandle } = await import("@/lib/email/status-handle.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return emailStatusForHandle(orgId, data.handle, {
      // Ownership through the caller's own client: RLS and the org filter
      // both have to agree the invoice or client is theirs.
      ownsSubject: async (subject) => {
        const { data: owned } = await context.supabase
          .from(subject.kind === "invoice" ? "invoices" : "clients")
          .select("id")
          .eq("id", subject.id)
          .eq("organization_id", orgId)
          .maybeSingle();
        return !!owned;
      },
      // Then, and only then, the service role: the log has no org column
      // and no policy a signed-in user passes.
      readLog: async (messageId) => {
        const { data: rows, error } = await supabaseAdmin
          .from("email_send_log")
          .select("status, recipient_email, error_message, created_at")
          .eq("message_id", messageId)
          .order("created_at", { ascending: false });
        if (error) throw new Error(error.message);
        return (rows ?? []) as EmailLogRow[];
      },
    });
  });
