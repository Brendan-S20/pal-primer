// Quotes: the server half.
//
// Office functions run as the signed-in user, so RLS on quotes and
// quote_line_items is the boundary and requirePermission is the courtesy that
// turns a denial into a sentence. The permission is manage_client_billing, the
// one manual invoices use: a quote is a price offered to a customer, and the
// people who may bill a customer are the people who may offer them a price.
//
// The customer's two functions (getPublicQuote, respondToPublicQuote) have NO
// auth middleware, exactly like getPublicInvoice / createPublicInvoicePaymentIntent
// in invoices.functions.ts: the unguessable public_token is the capability,
// and they reach the database through the service-role client. Where the
// invoice pair reads the table directly after a token lookup, these call the
// two SECURITY DEFINER functions the migration grants to service_role alone,
// so the rules (never a draft, answer exactly once, not after expiry) live in
// one place that a replay can prove.
//
// See supabase/migrations/20260928170000_a-bid-had-nothing-to-accept.sql.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { appOrigin, appUrl } from "@/lib/app-origin";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import {
  QUOTE_LIMITS,
  defaultQuoteValidUntil,
  effectiveQuoteStatus,
  formatQuoteDay,
  lineAmountCents,
  oneTimeInvoiceItems,
  quoteBillTo,
  quoteNumberLabel,
  quoteRecipientName,
  quoteRespondErrorMessage,
  quoteTotals,
} from "@/lib/quotes";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Two FKs from quotes to clients (the recipient and the client it became),
 *  so PostgREST needs to be told which one to embed. */
const QUOTE_SELECT =
  "id, number, status, title, message, valid_until, public_token, sent_at, accepted_at, declined_at, accepted_name, decline_reason, converted_at, converted_client_id, one_time_invoice_id, deposit_cents, deposit_invoice_id, client_id, lead_id, prospect_name, prospect_email, prospect_phone, created_at, updated_at, clients!quotes_client_id_fkey(id, display_name, primary_email, primary_phone)";

type Sb = any;

async function orgClock(supabase: Sb, orgId: string) {
  const { data } = await supabase
    .from("organizations")
    .select("timezone, name")
    .eq("id", orgId)
    .maybeSingle();
  const timezone = (data?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
  return { timezone, today: orgToday(timezone), orgName: (data?.name as string | null) ?? "" };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function publicQuoteUrl(token: string): string {
  // appOrigin(), never the page's origin: this link goes in an email and a
  // text, and from the native app the page origin is capacitor://localhost.
  return `${appOrigin()}/q/${token}`;
}

// ── Reads ──────────────────────────────────────────────────────────────────

export const listQuotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const clock = await orgClock(supabase, orgId);
    const { data, error } = await supabase
      .from("quotes")
      .select(
        "id, number, status, title, valid_until, sent_at, accepted_at, declined_at, converted_at, created_at, client_id, lead_id, prospect_name, clients!quotes_client_id_fkey(display_name), quote_line_items(amount_cents, recurring)",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const quotes = (data ?? []).map((q: any) => {
      const client = one(q.clients) as { display_name: string } | null;
      const totals = quoteTotals(q.quote_line_items ?? []);
      return {
        id: q.id as string,
        number: q.number as number,
        label: quoteNumberLabel(q.number),
        status: effectiveQuoteStatus(q.status, q.valid_until, clock.today),
        title: (q.title as string | null) ?? null,
        recipientName: quoteRecipientName({
          client_display_name: client?.display_name,
          prospect_name: q.prospect_name,
        }),
        isProspect: !q.client_id,
        validUntil: (q.valid_until as string | null) ?? null,
        sentAt: (q.sent_at as string | null) ?? null,
        acceptedAt: (q.accepted_at as string | null) ?? null,
        declinedAt: (q.declined_at as string | null) ?? null,
        convertedAt: (q.converted_at as string | null) ?? null,
        createdAt: q.created_at as string,
        oneTimeCents: totals.oneTimeCents,
        recurringCents: totals.recurringCents,
      };
    });
    return { quotes, today: clock.today, timezone: clock.timezone };
  });

export const getQuote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: q, error } = await supabase
      .from("quotes")
      .select(QUOTE_SELECT)
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");
    const { data: lines, error: lErr } = await supabase
      .from("quote_line_items")
      .select("id, description, quantity, unit_amount_cents, amount_cents, recurring, sort")
      .eq("quote_id", data.id)
      .order("sort")
      .order("created_at");
    if (lErr) throw new Error(lErr.message);
    let leadName: string | null = null;
    if (q.lead_id) {
      const { data: lead } = await supabase
        .from("leads")
        .select("name")
        .eq("id", q.lead_id)
        .maybeSingle();
      leadName = lead?.name ?? null;
    }
    let depositInvoice: { id: string; number: number | null; status: string } | null = null;
    if (q.deposit_invoice_id) {
      const { data: di } = await supabase
        .from("invoices")
        .select("id, number, status")
        .eq("id", q.deposit_invoice_id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (di) {
        depositInvoice = {
          id: di.id as string,
          number: (di.number as number | null) ?? null,
          status: di.status as string,
        };
      }
    }
    const clock = await orgClock(supabase, orgId);
    const client = one(q.clients as any) as {
      id: string;
      display_name: string;
      primary_email: string | null;
      primary_phone: string | null;
    } | null;
    const normalizedLines = (lines ?? []).map((l: any) => ({
      id: l.id as string,
      description: l.description as string,
      quantity: Number(l.quantity),
      unit_amount_cents: l.unit_amount_cents as number,
      amount_cents: l.amount_cents as number,
      recurring: !!l.recurring,
    }));
    return {
      quote: {
        id: q.id as string,
        number: q.number as number,
        label: quoteNumberLabel(q.number),
        rawStatus: q.status as string,
        status: effectiveQuoteStatus(q.status, q.valid_until, clock.today),
        title: (q.title as string | null) ?? null,
        message: (q.message as string | null) ?? null,
        validUntil: (q.valid_until as string | null) ?? null,
        sentAt: (q.sent_at as string | null) ?? null,
        acceptedAt: (q.accepted_at as string | null) ?? null,
        acceptedName: (q.accepted_name as string | null) ?? null,
        declinedAt: (q.declined_at as string | null) ?? null,
        declineReason: (q.decline_reason as string | null) ?? null,
        convertedAt: (q.converted_at as string | null) ?? null,
        convertedClientId: (q.converted_client_id as string | null) ?? null,
        oneTimeInvoiceId: (q.one_time_invoice_id as string | null) ?? null,
        depositCents: (q.deposit_cents as number | null) ?? null,
        depositInvoice,
        createdAt: q.created_at as string,
        clientId: (q.client_id as string | null) ?? null,
        clientName: client?.display_name ?? null,
        clientEmail: client?.primary_email ?? null,
        leadId: (q.lead_id as string | null) ?? null,
        leadName,
        prospectName: (q.prospect_name as string | null) ?? null,
        prospectEmail: (q.prospect_email as string | null) ?? null,
        prospectPhone: (q.prospect_phone as string | null) ?? null,
        recipientName: quoteRecipientName({
          client_display_name: client?.display_name,
          prospect_name: q.prospect_name,
        }),
        recipientEmail: (client ? client.primary_email : q.prospect_email) ?? null,
        // A draft has no link: public_quote_document returns nothing for it,
        // so handing one out would be handing out a dead end.
        publicUrl: q.status === "draft" ? null : publicQuoteUrl(q.public_token as string),
        /** The link's token, for the same reason and on the same condition. */
        publicToken: q.status === "draft" ? null : ((q.public_token as string | null) ?? null),
      },
      lines: normalizedLines,
      totals: quoteTotals(normalizedLines),
      today: clock.today,
      timezone: clock.timezone,
      orgName: clock.orgName,
    };
  });

// ── Drafts ─────────────────────────────────────────────────────────────────

const lineSchema = z.object({
  description: z.string().trim().min(1).max(QUOTE_LIMITS.description),
  quantity: z
    .number()
    .positive()
    .max(QUOTE_LIMITS.maxQuantity)
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "At most two decimal places"),
  unitAmountCents: z.number().int().min(0).max(QUOTE_LIMITS.maxUnitCents),
  recurring: z.boolean(),
});

const draftSchema = z
  .object({
    id: z.string().uuid().optional(),
    clientId: z.string().uuid().nullable().optional(),
    prospect: z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z
          .union([z.literal(""), z.string().trim().toLowerCase().email().max(320)])
          .optional(),
        phone: z.string().trim().max(40).optional(),
      })
      .nullable()
      .optional(),
    leadId: z.string().uuid().nullable().optional(),
    title: z.string().trim().max(QUOTE_LIMITS.title).optional(),
    message: z.string().max(QUOTE_LIMITS.message).optional(),
    validUntil: z.string().regex(DAY).nullable().optional(),
    /** Asked for on accepting; null is no deposit. The same range as the
     *  quotes_deposit_cents_range CHECK. */
    depositCents: z
      .number()
      .int()
      .min(QUOTE_LIMITS.minDepositCents, "A deposit is at least $1.00")
      .max(QUOTE_LIMITS.maxDepositCents, "A deposit is at most $10,000")
      .nullable()
      .optional(),
    lines: z.array(lineSchema).min(1).max(QUOTE_LIMITS.maxLines),
  })
  .refine((d) => !!d.clientId !== !!d.prospect, {
    message: "Choose a client, or type the prospect's name, but not both",
  });

export const saveQuoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => draftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const clock = await orgClock(supabase, orgId);
    if (data.validUntil && data.validUntil < clock.today) {
      throw new Error("The valid-until date has already passed.");
    }

    if (data.clientId) {
      const { data: c } = await supabase
        .from("clients")
        .select("id")
        .eq("id", data.clientId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (!c) throw new Error("Client not found");
    }
    if (data.leadId) {
      const { data: l } = await supabase
        .from("leads")
        .select("id")
        .eq("id", data.leadId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (!l) throw new Error("Lead not found");
    }

    const fields = {
      client_id: data.clientId ?? null,
      lead_id: data.leadId ?? null,
      prospect_name: data.prospect?.name ?? null,
      prospect_email: data.prospect?.email || null,
      prospect_phone: data.prospect?.phone || null,
      title: data.title?.trim() || null,
      message: data.message?.trim() || null,
      valid_until: data.validUntil ?? null,
      deposit_cents: data.depositCents ?? null,
    };

    let quoteId: string;
    let created = false;
    let oldLineIds: string[] = [];
    if (data.id) {
      const { data: existing, error } = await supabase
        .from("quotes")
        .select("id, status")
        .eq("id", data.id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!existing) throw new Error("Quote not found");
      if (existing.status !== "draft") {
        throw new Error("A quote cannot be edited once it has been sent. Duplicate it instead.");
      }
      const { error: uErr } = await supabase.from("quotes").update(fields).eq("id", data.id);
      if (uErr) throw new Error(uErr.message);
      // The lines being replaced, by id. They are deleted only AFTER the new
      // ones are in: deleting first meant a failed insert left the draft with
      // no lines at all, and the office's work gone with them.
      const { data: old, error: oErr } = await supabase
        .from("quote_line_items")
        .select("id")
        .eq("quote_id", data.id);
      if (oErr) throw new Error(oErr.message);
      oldLineIds = (old ?? []).map((r: { id: string }) => r.id);
      quoteId = data.id;
    } else {
      const { data: ins, error } = await supabase
        .from("quotes")
        .insert({ ...fields, organization_id: orgId, created_by: userId })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      quoteId = ins.id as string;
      created = true;
    }

    const { data: inserted, error: lErr } = await supabase
      .from("quote_line_items")
      .insert(
        data.lines.map((l, i) => ({
          quote_id: quoteId,
          description: l.description,
          quantity: l.quantity,
          unit_amount_cents: l.unitAmountCents,
          amount_cents: lineAmountCents(l.quantity, l.unitAmountCents),
          recurring: l.recurring,
          sort: i,
        })),
      )
      .select("id");
    if (lErr) {
      // Do not leave a new quote with no lines behind. An edited draft still
      // has its old lines, untouched; the office sees the error and saves again.
      if (created) await supabase.from("quotes").delete().eq("id", quoteId);
      throw new Error(lErr.message);
    }
    if (oldLineIds.length) {
      const { error: dErr } = await supabase.from("quote_line_items").delete().in("id", oldLineIds);
      if (dErr) {
        // Both sets would show. Take the new ones back out, so the draft reads
        // as it did before this save rather than as the two added together.
        const newIds = (inserted ?? []).map((r: { id: string }) => r.id);
        if (newIds.length) await supabase.from("quote_line_items").delete().in("id", newIds);
        throw new Error(dErr.message);
      }
    }
    return { id: quoteId };
  });

export const deleteQuoteDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: gone, error } = await supabase
      .from("quotes")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .eq("status", "draft")
      .select("id");
    if (error) throw new Error(error.message);
    if (!gone?.length)
      throw new Error("Only a draft can be deleted. Withdraw a sent quote instead.");
    return { ok: true };
  });

/** A new draft with the same recipient, wording and lines. How a declined,
 *  expired or withdrawn quote is revised: the one the customer saw stays as
 *  it was. */
export const duplicateQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const { data: q, error } = await supabase
      .from("quotes")
      .select(
        "client_id, lead_id, prospect_name, prospect_email, prospect_phone, title, message, deposit_cents",
      )
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");
    const { data: lines } = await supabase
      .from("quote_line_items")
      .select("description, quantity, unit_amount_cents, amount_cents, recurring, sort")
      .eq("quote_id", data.id)
      .order("sort");
    const clock = await orgClock(supabase, orgId);
    const { data: ins, error: iErr } = await supabase
      .from("quotes")
      .insert({
        ...q,
        organization_id: orgId,
        created_by: userId,
        valid_until: defaultQuoteValidUntil(clock.today),
      })
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);
    if (lines?.length) {
      const { error: lErr } = await supabase
        .from("quote_line_items")
        .insert(lines.map((l: any) => ({ ...l, quote_id: ins.id })));
      if (lErr) {
        await supabase.from("quotes").delete().eq("id", ins.id);
        throw new Error(lErr.message);
      }
    }
    return { id: ins.id as string };
  });

// ── Sending ────────────────────────────────────────────────────────────────

/**
 * Send (or resend) a quote.
 *
 * The status is stamped FIRST, because the link in the email only opens once
 * the quote is no longer a draft. Then the email, if there is an address and
 * the org has quote emails on. A quote with no email address (a prospect who
 * gave only a phone number) is still sent: the office copies the link and
 * texts it, which is how most of these businesses talk to their customers.
 * The result says which happened, so the page never claims an email that did
 * not go.
 */
export const sendQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const clock = await orgClock(supabase, orgId);
    const { data: q, error } = await supabase
      .from("quotes")
      .select(QUOTE_SELECT)
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");

    const status = effectiveQuoteStatus(q.status, q.valid_until, clock.today);
    if (status === "expired") {
      throw new Error("This quote has expired. Duplicate it to send a fresh one.");
    }
    if (status !== "draft" && status !== "sent") {
      throw new Error(`This quote was ${status}. Duplicate it to send a new one.`);
    }
    if (q.valid_until && q.valid_until < clock.today) {
      throw new Error("The valid-until date has already passed. Change it before sending.");
    }
    const { data: lines, error: lErr } = await supabase
      .from("quote_line_items")
      .select("amount_cents, recurring")
      .eq("quote_id", data.id);
    if (lErr) throw new Error(lErr.message);
    if (!lines?.length) throw new Error("Add at least one line before sending.");

    const firstSend = q.status === "draft";
    if (firstSend) {
      const { error: sErr } = await supabase
        .from("quotes")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("status", "draft");
      if (sErr) throw new Error(sErr.message);
    }

    const link = publicQuoteUrl(q.public_token as string);
    const label = quoteNumberLabel(q.number);
    const client = one(q.clients as any) as {
      display_name: string;
      primary_email: string | null;
    } | null;
    const recipient = ((client ? client.primary_email : q.prospect_email) ?? "").trim() || null;
    const totals = quoteTotals(lines);

    let emailed = false;
    let reason: string | null = null;
    let messageId: string | null = null;
    if (!recipient) {
      reason = "no_email";
    } else {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      const res = await enqueueAppEmail({
        organizationId: orgId,
        clientId: (q.client_id as string | null) ?? null,
        recipientName: q.prospect_name ?? null,
        toOverride: q.client_id ? undefined : recipient,
        templateName: "quote-sent",
        notifyKey: "notify_email_quote_sent",
        // A resend is a new email on purpose; the first send is deduped.
        idempotencyKey: firstSend
          ? `quote-sent-${q.id}`
          : `quote-resent-${q.id}-${new Date().toISOString().slice(0, 16)}`,
        templateData: {
          quoteLabel: label,
          title: q.title ?? null,
          oneTimeCents: totals.oneTimeCents,
          recurringCents: totals.recurringCents,
          validUntilLabel: q.valid_until ? formatQuoteDay(q.valid_until) : null,
          message: q.message ?? null,
          quoteUrl: link,
        },
        // Every quote email is somebody pressing Send.
        manual: true,
      });
      emailed = res.ok;
      reason = res.ok ? null : (res.reason ?? "enqueue_failed");
      messageId = res.messageId ?? null;
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: (q.client_id as string | null) ?? null,
      actorUserId: userId,
      kind: firstSend ? "quote.sent" : "quote.resent",
      summary: `${firstSend ? "Sent" : "Resent"} quote ${label}${emailed && recipient ? ` to ${recipient}` : ""}`,
      meta: { quoteId: q.id, emailed, reason },
    });

    return { emailed, reason, recipient, link, messageId, firstSend };
  });

/** Take a sent quote off the table. It reads as expired on the customer's
 *  page and can no longer be accepted. */
export const withdrawQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const { data: rows, error } = await supabase
      .from("quotes")
      .update({ status: "expired" })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .eq("status", "sent")
      .select("id, number, client_id");
    if (error) throw new Error(error.message);
    const q = rows?.[0];
    if (!q) throw new Error("Only a sent quote that has not been answered can be withdrawn.");
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: q.client_id ?? null,
      actorUserId: userId,
      kind: "quote.withdrawn",
      summary: `Withdrew quote ${quoteNumberLabel(q.number)}`,
      meta: { quoteId: q.id },
    });
    return { ok: true };
  });

/** Called by the new-service form and the new-client wizard once an accepted
 *  quote has become work, so the quote says so and is not converted twice. */
export const markQuoteConverted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const { data: rows, error } = await supabase
      .from("quotes")
      .update({ converted_at: new Date().toISOString(), converted_client_id: data.clientId })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .eq("status", "accepted")
      .is("converted_at", null)
      .select("id, number");
    if (error) throw new Error(error.message);
    const q = rows?.[0];
    if (q) {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: data.clientId,
        actorUserId: userId,
        kind: "quote.converted",
        summary: `Started work from quote ${quoteNumberLabel(q.number)}`,
        meta: { quoteId: q.id },
      });
    }
    // A prospect's deposit had nobody to bill until now. Made (once) with the
    // service role after the permission check above; a quote with no deposit
    // gets nothing. The office sends it from the quote page.
    const depositInvoiceId = await makeDepositInvoice(data.id);
    return { converted: !!q, depositInvoiceId };
  });

/** Bill an accepted quote's one-time lines (the initial cleanup, usually) on
 *  an ordinary open invoice to the client it was for or became.
 *
 *  A button, not something conversion does by itself: the cleanup is billed
 *  when it is done, and an open invoice is one autopay will charge. Pressing
 *  it twice returns the first invoice; `one_time_invoice_id` is set with a
 *  conditional update, so two presses at once cannot both win, and the loser
 *  removes the invoice it made. */
export const invoiceQuoteOneTimeCharges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const { data: q, error } = await supabase
      .from("quotes")
      .select("id, number, status, client_id, converted_client_id, one_time_invoice_id")
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");
    if (q.one_time_invoice_id) {
      return { invoiceId: q.one_time_invoice_id as string, created: false };
    }
    if (q.status !== "accepted") {
      throw new Error("Only an accepted quote's charges can be invoiced.");
    }
    const billTo = quoteBillTo(q);
    if (!billTo) {
      throw new Error("Convert the quote to a client first, so there is somebody to bill.");
    }
    const { data: lines, error: lErr } = await supabase
      .from("quote_line_items")
      .select("description, quantity, unit_amount_cents, amount_cents, recurring, sort")
      .eq("quote_id", q.id)
      .order("sort");
    if (lErr) throw new Error(lErr.message);
    const items = oneTimeInvoiceItems(lines ?? []);
    if (items.length === 0) throw new Error("This quote has no one-time charges to invoice.");

    const label = quoteNumberLabel(q.number as number);
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const inv = await insertManualInvoice(supabase, {
      orgId,
      userId,
      clientId: billTo,
      items,
      notes: `One-time charges from quote ${label}`,
      activityLabel: `invoice for ${label}`,
    });

    const { data: won, error: wErr } = await supabase
      .from("quotes")
      .update({ one_time_invoice_id: inv.invoiceId })
      .eq("id", q.id)
      .is("one_time_invoice_id", null)
      .select("one_time_invoice_id");
    if (wErr || !won?.length) {
      // Somebody else's press got there first, or the stamp failed. Either
      // way this invoice must not stand beside theirs.
      await supabase.from("invoices").delete().eq("id", inv.invoiceId);
      if (wErr) throw new Error(wErr.message);
      const { data: again } = await supabase
        .from("quotes")
        .select("one_time_invoice_id")
        .eq("id", q.id)
        .maybeSingle();
      return { invoiceId: (again?.one_time_invoice_id as string) ?? "", created: false };
    }
    return { invoiceId: inv.invoiceId, created: true, totalCents: inv.totalCents };
  });

/** The quote's deposit invoice: made the first time there is an accepted quote
 *  with a deposit and somebody to bill, and returned as it is every time
 *  after. Null when there is no deposit or nobody to bill yet. Never throws:
 *  an acceptance or a conversion that has happened must not be reported as
 *  failed because its deposit invoice could not be made; the office sees
 *  "no deposit invoice yet" and the quote page offers to make it. */
async function makeDepositInvoice(quoteId: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).rpc("quote_deposit_invoice", {
      _quote_id: quoteId,
    });
    if (error) {
      console.error("quote_deposit_invoice failed", quoteId, error.message);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (e) {
    console.error("quote_deposit_invoice failed", quoteId, (e as Error).message);
    return null;
  }
}

/** The office's "Make deposit invoice", for the case makeDepositInvoice could
 *  not do at acceptance or conversion. The same once-only function. */
export const createQuoteDepositInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
    const { data: q, error } = await supabase
      .from("quotes")
      .select("id, status, deposit_cents, client_id, converted_client_id")
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");
    if (q.status !== "accepted")
      throw new Error("Only an accepted quote's deposit can be invoiced.");
    if (!q.deposit_cents) throw new Error("This quote has no deposit.");
    if (!q.client_id && !q.converted_client_id) {
      throw new Error("Convert the quote to a client first, so there is somebody to bill.");
    }
    const invoiceId = await makeDepositInvoice(q.id as string);
    if (!invoiceId) throw new Error("The deposit invoice could not be made. Try again.");
    return { invoiceId };
  });

// ── The customer's link: /q/{token} ────────────────────────────────────────
//
// NO auth middleware on these two, and that is the design, not an omission:
// see the header. Both return display data only.

async function publicAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

type PublicQuoteDoc = {
  number: number;
  status: string;
  title: string | null;
  message: string | null;
  valid_until: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_name: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  recipient_name: string | null;
  org_name: string | null;
  org_email: string | null;
  org_phone: string | null;
  org_timezone: string | null;
  currency: string | null;
  deposit_cents: number | null;
  deposit_pay_token: string | null;
  deposit_paid: boolean | null;
  lines: Array<{
    description: string;
    quantity: number | string;
    unit_amount_cents: number;
    amount_cents: number;
    recurring: boolean;
  }>;
};

export const getPublicQuote = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const supabaseAdmin = await publicAdmin();
    const { data: doc, error } = await supabaseAdmin.rpc("public_quote_document", {
      _token: data.token,
    });
    if (error) throw new Error("This quote could not be loaded. Please try again.");
    if (!doc) return { found: false as const };
    const d = doc as unknown as PublicQuoteDoc;
    const lines = (d.lines ?? []).map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitAmountCents: l.unit_amount_cents,
      amountCents: l.amount_cents,
      recurring: !!l.recurring,
    }));
    const totals = quoteTotals(
      lines.map((l) => ({ amount_cents: l.amountCents, recurring: l.recurring })),
    );
    return {
      found: true as const,
      quote: {
        label: quoteNumberLabel(d.number),
        status: d.status,
        title: d.title,
        message: d.message,
        validUntil: d.valid_until,
        sentAt: d.sent_at,
        acceptedAt: d.accepted_at,
        acceptedName: d.accepted_name,
        declinedAt: d.declined_at,
        declineReason: d.decline_reason,
        recipientName: d.recipient_name,
        currency: d.currency ?? "usd",
        depositCents: d.deposit_cents ?? null,
        /** The deposit invoice's pay link while it is open; null before it
         *  exists and once it is paid. */
        depositPayUrl: d.deposit_pay_token ? appUrl(`/pay/i/${d.deposit_pay_token}`) : null,
        depositPaid: !!d.deposit_paid,
      },
      org: {
        name: d.org_name ?? "Your service provider",
        email: d.org_email,
        phone: d.org_phone,
        timezone: d.org_timezone,
      },
      lines,
      totals: { oneTimeCents: totals.oneTimeCents, recurringCents: totals.recurringCents },
    };
  });

type RespondResult = {
  quote_id: string;
  organization_id: string;
  client_id: string | null;
  number: number;
  status: string;
  accepted_at: string | null;
  accepted_name: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  recipient_name: string | null;
  changed: boolean;
};

export const respondToPublicQuote = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        accept: z.boolean(),
        name: z.string().max(200).optional(),
        reason: z.string().max(QUOTE_LIMITS.declineReason).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const supabaseAdmin = await publicAdmin();
    const { data: out, error } = await supabaseAdmin.rpc("public_quote_respond", {
      _token: data.token,
      _accept: data.accept,
      _name: data.name ?? "",
      _reason: data.reason ?? "",
    });
    // The refusal codes become sentences; nothing from Postgres reaches a
    // customer's screen verbatim.
    if (error) throw new Error(quoteRespondErrorMessage(error.message));
    const r = out as unknown as RespondResult;

    // The deposit, when the quote asks for one and there is a client to bill.
    // Made on every accepted call, not only the first: it is once-only in the
    // database, and a customer who accepted and closed the tab before paying
    // gets the same invoice back on their next visit.
    let depositPayUrl: string | null = null;
    if (r.status === "accepted") {
      const depositInvoiceId = await makeDepositInvoice(r.quote_id);
      if (depositInvoiceId) {
        const { data: di } = await supabaseAdmin
          .from("invoices")
          .select("public_token, status")
          .eq("id", depositInvoiceId)
          .maybeSingle();
        if (di?.status === "open" && di.public_token) {
          depositPayUrl = appUrl(`/pay/i/${di.public_token}`);
        }
      }
    }

    // Tell the office, once: only when this call recorded the answer. A second
    // tap returns the first answer with changed=false and notifies nobody.
    if (r.changed) {
      const label = quoteNumberLabel(r.number);
      const who = r.recipient_name ?? "The client";
      const accepted = r.status === "accepted";
      try {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: r.organization_id,
          type: "quote_response",
          title: accepted ? `Quote ${label} accepted` : `Quote ${label} declined`,
          body: accepted
            ? `${who} accepted, signed "${r.accepted_name ?? ""}".`
            : `${who} declined${r.decline_reason ? `: ${r.decline_reason.slice(0, 120)}` : "."}`,
          link: `/quotes/${r.quote_id}`,
        });
      } catch (e) {
        console.error("quote response notification failed", (e as Error).message);
      }
      try {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(supabaseAdmin, {
          orgId: r.organization_id,
          clientId: r.client_id,
          actorLabel: accepted ? (r.accepted_name ?? "Client") : "Client",
          kind: accepted ? "quote.accepted" : "quote.declined",
          summary: accepted
            ? `${who} accepted quote ${label}`
            : `${who} declined quote ${label}${r.decline_reason ? `: ${r.decline_reason.slice(0, 200)}` : ""}`,
          meta: { quoteId: r.quote_id },
        });
      } catch (e) {
        console.error("quote response activity failed", (e as Error).message);
      }
    }

    return {
      status: r.status,
      acceptedAt: r.accepted_at,
      acceptedName: r.accepted_name,
      declinedAt: r.declined_at,
      declineReason: r.decline_reason,
      changed: r.changed,
      depositPayUrl,
    };
  });
