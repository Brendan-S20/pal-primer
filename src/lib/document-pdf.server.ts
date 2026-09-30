// Who may have an invoice or a quote as a PDF, and the loading that turns a
// row into the model the renderers draw.
//
// There is no new access rule in this file. Each entry point is the SAME gate
// the screen showing that document already passes, so a PDF can never be had
// by anybody who could not already read the page:
//
//   staffInvoicePdf    requirePermission(manage_client_billing), then the
//                      caller's own RLS-scoped client, filtered to their org.
//                      getInvoice / getInvoiceDetail.
//   publicInvoicePdf   the unguessable invoices.public_token, looked up with
//                      the service-role client, exactly as getPublicInvoice
//                      does, including its webhook-independent reconcile.
//   portalInvoicePdf   requirePortalSession(token) and the invoice belonging
//                      to that session's client. portalPayInvoiceWithSavedCard.
//   staffQuotePdf      requirePermission(manage_client_billing), org-scoped.
//                      getQuote.
//   publicQuotePdf     public_quote_document(_token), the SECURITY DEFINER
//                      function getPublicQuote calls. It returns NULL for a
//                      draft and for an unknown token alike, so a draft is
//                      never a PDF outside the office, and this file checks
//                      again rather than trust a single line of SQL for it.
//
// The public invoice PDF carries the client's display name but NOT their
// email: getPublicInvoice deliberately returns "no other client PII" to a
// link holder, and a link can be forwarded. Every other surface is somebody
// the email already belongs to, or the office.
//
// Server-only: imported from handlers with `await import(...)`.

import { taxLineLabel } from "@/lib/sales-tax";
import { invoiceOutstandingCents } from "@/lib/ar";
import { appUrl } from "@/lib/app-origin";
import { invoiceNumberLabel } from "@/lib/invoice-labels";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_ORG_TIMEZONE, orgLocalDay, orgToday } from "@/lib/org-day";
import { isInvoiceOverdue } from "@/lib/overdue";
import { RECEIVED_PAYMENT_STATUSES } from "@/lib/revenue";
import { effectiveQuoteStatus, quoteNumberLabel, quoteRecipientName } from "@/lib/quotes";
import { renderInvoicePdf, type InvoicePdfModel } from "@/lib/pdf/invoice-pdf";
import { renderQuotePdf, type QuotePdfModel } from "@/lib/pdf/quote-pdf";
import { pdfFileName } from "@/lib/pdf/pdf-writer";

export type PdfFile = { filename: string; bytes: Uint8Array };

// Structural: the request-scoped client, the service-role client and the
// test suite's fakes have only this chain in common. See authz.server.ts.
type Db = any;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Everything an invoice PDF prints, in one read. */
export const INVOICE_PDF_SELECT =
  "id, number, organization_id, client_id, status, currency, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, credit_applied_cents, period_start, period_end, issued_at, paid_at, due_on, public_token, stripe_payment_intent_id, stripe_checkout_session_id, organizations(name, timezone, contact_email, contact_phone, contact_address), clients(display_name, primary_email)";

type InvoicePdfRow = {
  id: string;
  number: number | null;
  organization_id: string;
  client_id: string | null;
  status: string;
  currency: string | null;
  subtotal_cents: number | null;
  /** Optional: a row read before sales tax existed has none, and prints none. */
  tax_cents?: number | null;
  tax_rate_bps?: number | null;
  tax_label?: string | null;
  total_cents: number | null;
  credit_applied_cents: number | null;
  period_start: string | null;
  period_end: string | null;
  issued_at: string | null;
  paid_at: string | null;
  due_on: string | null;
  public_token: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_checkout_session_id?: string | null;
  organizations?: unknown;
  clients?: unknown;
};

/** Build and render the PDF for an invoice row the caller is already
 *  entitled to. `db` reads the lines and payments: the caller's own client
 *  for staff, the service-role client for the token and portal paths. */
export async function invoicePdfForRow(
  db: Db,
  inv: InvoicePdfRow,
  opts: { includeEmail: boolean },
): Promise<PdfFile> {
  const org = one(inv.organizations as any) as {
    name?: string | null;
    timezone?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    contact_address?: string | null;
  } | null;
  const client = one(inv.clients as any) as {
    display_name?: string | null;
    primary_email?: string | null;
  } | null;
  const tz = org?.timezone || DEFAULT_ORG_TIMEZONE;

  const [linesRes, paysRes] = await Promise.all([
    db
      .from("invoice_line_items")
      .select("id, description, amount_cents, quantity, unit_amount_cents")
      .eq("invoice_id", inv.id)
      .order("created_at"),
    db.from("payments").select("id, amount_cents, status").eq("invoice_id", inv.id),
  ]);
  if (linesRes.error) throw new Error(linesRes.error.message);
  const pays = (
    (paysRes.data ?? []) as Array<{ id: string; amount_cents: number; status: string }>
  ).filter((p) => (RECEIVED_PAYMENT_STATUSES as readonly string[]).includes(p.status));
  let refundedCents = 0;
  if (pays.length) {
    const { refundedCentsByPayment } = await import("@/lib/refunds.server");
    const refunded = await refundedCentsByPayment(
      db,
      inv.organization_id,
      pays.map((p) => p.id),
    );
    for (const v of refunded.values()) refundedCents += v;
  }
  const totalCents = inv.total_cents ?? 0;
  const creditCents = inv.credit_applied_cents ?? 0;
  let amountPaidCents = pays.reduce((s, p) => s + (p.amount_cents ?? 0), 0);
  // A paid invoice with no payment row (settled before payments were
  // recorded, or wholly by credit) still reads as paid: what was not credit
  // was paid.
  if (inv.status === "paid" && amountPaidCents === 0)
    amountPaidCents = Math.max(totalCents - creditCents, 0);

  const businessName = org?.name?.trim() || "Your service provider";
  const label = invoiceNumberLabel({ id: inv.id, number: inv.number });
  const day = (ts: string | null) => (ts ? orgLocalDay(ts, tz) || null : null);
  const model: InvoicePdfModel = {
    business: {
      name: businessName,
      email: org?.contact_email ?? null,
      phone: org?.contact_phone ?? null,
      address: org?.contact_address ?? null,
    },
    label,
    status: inv.status,
    issuedOn: day(inv.issued_at),
    dueOn: inv.due_on,
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    paidOn: day(inv.paid_at),
    overdue: isInvoiceOverdue(inv.status, inv.due_on, orgToday(tz)),
    billedTo: {
      name: client?.display_name ?? null,
      email: opts.includeEmail ? (client?.primary_email ?? null) : null,
    },
    currency: inv.currency ?? "usd",
    lines: ((linesRes.data ?? []) as any[]).map((l) => ({
      description: l.description,
      amountCents: l.amount_cents,
      quantity: l.quantity,
      unitAmountCents: l.unit_amount_cents ?? null,
    })),
    subtotalCents: inv.subtotal_cents,
    taxCents: Math.max(0, inv.tax_cents ?? 0),
    taxLabel: taxLineLabel(inv.tax_label, inv.tax_rate_bps),
    totalCents,
    creditAppliedCents: creditCents,
    amountPaidCents,
    refundedCents,
    balanceDueCents: invoiceOutstandingCents({
      status: inv.status,
      total_cents: totalCents,
      credit_applied_cents: creditCents,
    }),
    payUrl: inv.public_token ? appUrl(`/pay/i/${inv.public_token}`) : null,
  };
  const { bytes } = await renderInvoicePdf(model);
  return { filename: pdfFileName("Invoice", label, businessName), bytes };
}

// ── Invoice: office ────────────────────────────────────────────────────────

export async function staffInvoicePdf(
  supabase: Db,
  userId: string,
  invoiceId: string,
): Promise<PdfFile> {
  const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_PDF_SELECT)
    .eq("id", invoiceId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Invoice not found");
  return invoicePdfForRow(supabase, data as InvoicePdfRow, { includeEmail: true });
}

// ── Invoice: the pay link ──────────────────────────────────────────────────

/** null for a token that is not a uuid or names no invoice: the caller
 *  answers 404 and cannot tell which. */
export async function publicInvoicePdf(admin: Db, token: string): Promise<PdfFile | null> {
  if (!UUID.test(token)) return null;
  const { data, error } = await admin
    .from("invoices")
    .select(INVOICE_PDF_SELECT)
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const inv = data as InvoicePdfRow;
  // getPublicInvoice's safety net, for the same reason: the customer may
  // download a receipt a minute after paying, before the webhook lands.
  if (inv.status === "open" && (inv.stripe_payment_intent_id || inv.stripe_checkout_session_id)) {
    const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
    if ((await reconcileInvoicePayment(inv.id)) === "marked_paid") {
      inv.status = "paid";
      inv.paid_at = inv.paid_at ?? new Date().toISOString();
    }
  }
  return invoicePdfForRow(admin, inv, { includeEmail: false });
}

// ── Invoice: the customer portal ───────────────────────────────────────────

export async function portalInvoicePdf(
  admin: Db,
  session: { clientId: string },
  invoiceId: string,
): Promise<PdfFile> {
  const { data, error } = await admin
    .from("invoices")
    .select(INVOICE_PDF_SELECT)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Same answer for "no such invoice" and "somebody else's invoice".
  if (!data || (data as InvoicePdfRow).client_id !== session.clientId)
    throw new Error("Invoice not found");
  return invoicePdfForRow(admin, data as InvoicePdfRow, { includeEmail: true });
}

// ── Invoice: the email attachment ──────────────────────────────────────────

/** The PDF that rides along with the invoice email, or null when it could not
 *  be made. NEVER throws: the email is the thing that has to go, and a
 *  missing attachment is a smaller failure than a missing invoice. */
export async function invoicePdfAttachment(
  admin: Db,
  invoiceId: string,
): Promise<{ filename: string; contentBase64: string } | null> {
  try {
    const { data, error } = await admin
      .from("invoices")
      .select(INVOICE_PDF_SELECT)
      .eq("id", invoiceId)
      .maybeSingle();
    if (error || !data) return null;
    const file = await invoicePdfForRow(admin, data as InvoicePdfRow, { includeEmail: true });
    const { toBase64 } = await import("@/lib/pdf/pdf-writer");
    return { filename: file.filename, contentBase64: toBase64(file.bytes) };
  } catch (e) {
    console.error("invoice PDF attachment failed", invoiceId, e);
    return null;
  }
}

// ── Quote: office ──────────────────────────────────────────────────────────

export async function staffQuotePdf(
  supabase: Db,
  userId: string,
  quoteId: string,
): Promise<PdfFile> {
  const { orgId } = await requirePermission(supabase, userId, "manage_client_billing");
  const { data: q, error } = await supabase
    .from("quotes")
    .select(
      "id, number, status, title, message, valid_until, public_token, sent_at, accepted_at, declined_at, accepted_name, client_id, prospect_name, prospect_email, clients!quotes_client_id_fkey(display_name, primary_email)",
    )
    .eq("id", quoteId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!q) throw new Error("Quote not found");
  const [{ data: lines, error: lErr }, { data: org }] = await Promise.all([
    supabase
      .from("quote_line_items")
      .select("description, quantity, unit_amount_cents, amount_cents, recurring, sort, created_at")
      .eq("quote_id", quoteId)
      .order("sort")
      .order("created_at"),
    supabase
      .from("organizations")
      .select("name, timezone, contact_email, contact_phone, currency")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  if (lErr) throw new Error(lErr.message);
  const tz = (org?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
  const client = one(q.clients as any) as {
    display_name?: string | null;
    primary_email?: string | null;
  } | null;
  const day = (ts: string | null) => (ts ? orgLocalDay(ts, tz) || null : null);
  const businessName = (org?.name as string | null)?.trim() || "Your service provider";
  const label = quoteNumberLabel(q.number);
  const model: QuotePdfModel = {
    business: {
      name: businessName,
      email: (org?.contact_email as string | null) ?? null,
      phone: (org?.contact_phone as string | null) ?? null,
    },
    label,
    status: effectiveQuoteStatus(q.status, q.valid_until, orgToday(tz)),
    title: q.title ?? null,
    message: q.message ?? null,
    recipient: {
      name: quoteRecipientName({
        client_display_name: client?.display_name,
        prospect_name: q.prospect_name,
      }),
      email: (client ? client.primary_email : q.prospect_email) ?? null,
    },
    sentOn: day(q.sent_at),
    validUntil: q.valid_until ?? null,
    acceptedName: q.accepted_name ?? null,
    acceptedOn: day(q.accepted_at),
    declinedOn: day(q.declined_at),
    currency: (org?.currency as string | null) || "usd",
    lines: ((lines ?? []) as any[]).map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitAmountCents: l.unit_amount_cents,
      amountCents: l.amount_cents,
      recurring: !!l.recurring,
    })),
    // A draft has no link: public_quote_document answers nothing for it.
    acceptUrl: q.status === "draft" || !q.public_token ? null : appUrl(`/q/${q.public_token}`),
  };
  const { bytes } = await renderQuotePdf(model);
  return { filename: pdfFileName("Quote", label, businessName), bytes };
}

// ── Quote: the customer's link ─────────────────────────────────────────────

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
  recipient_name: string | null;
  org_name: string | null;
  org_email: string | null;
  org_phone: string | null;
  org_timezone: string | null;
  currency: string | null;
  lines: Array<{
    description: string;
    quantity: number | string;
    unit_amount_cents: number;
    amount_cents: number;
    recurring: boolean;
  }>;
};

/** null for an unknown token AND for a draft, indistinguishably. */
export async function publicQuotePdf(admin: Db, token: string): Promise<PdfFile | null> {
  if (!UUID.test(token)) return null;
  const { data: doc, error } = await admin.rpc("public_quote_document", { _token: token });
  if (error) throw new Error("This quote could not be loaded. Please try again.");
  if (!doc) return null;
  const d = doc as PublicQuoteDoc;
  // public_quote_document already refuses a draft. Refuse it here too: this
  // is the one rule on this path whose failure would publish something the
  // office never sent.
  if (d.status === "draft") return null;
  const tz = d.org_timezone || DEFAULT_ORG_TIMEZONE;
  const day = (ts: string | null) => (ts ? orgLocalDay(ts, tz) || null : null);
  const businessName = d.org_name?.trim() || "Your service provider";
  const label = quoteNumberLabel(d.number);
  const model: QuotePdfModel = {
    business: { name: businessName, email: d.org_email, phone: d.org_phone },
    label,
    status: d.status,
    title: d.title,
    message: d.message,
    recipient: { name: d.recipient_name },
    sentOn: day(d.sent_at),
    validUntil: d.valid_until,
    acceptedName: d.accepted_name,
    acceptedOn: day(d.accepted_at),
    declinedOn: day(d.declined_at),
    currency: d.currency ?? "usd",
    lines: (d.lines ?? []).map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitAmountCents: l.unit_amount_cents,
      amountCents: l.amount_cents,
      recurring: !!l.recurring,
    })),
    acceptUrl: appUrl(`/q/${token}`),
  };
  const { bytes } = await renderQuotePdf(model);
  return { filename: pdfFileName("Quote", label, businessName), bytes };
}

/** The HTTP answer for a public PDF: the file, or a 404 that says nothing
 *  about why. `inline` so a phone opens it in its viewer, which is where the
 *  Share and Save buttons are; the filename still names the saved file. */
export function pdfResponse(file: PdfFile | null): Response {
  if (!file) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${file.filename}"`,
      // The document changes when it is paid or answered; never serve a stale
      // one, and never let a shared cache hold a customer's invoice.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
