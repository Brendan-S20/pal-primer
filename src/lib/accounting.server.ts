import { DEFAULT_ORG_TIMEZONE, orgLocalDay } from "@/lib/org-day";
import { accountingLine } from "@/lib/invoice-lines";
import { taxLineLabel } from "@/lib/sales-tax";
import { QboApiError } from "@/lib/qbo-http.server";
import { qboQuoted, type QboClient } from "@/lib/qbo-client.server";

/**
 * What HoundStack sends to QuickBooks Online, and how it avoids sending it
 * twice. Server-only: never import from client bundles.
 *
 * IDEMPOTENT BY STORED ID. The QuickBooks Id of every customer, invoice and
 * payment HoundStack creates is written back onto the client, invoice or
 * payment row (`accounting_remote_id`). A second push of the same thing reads
 * the remote object for its SyncToken and UPDATES it; it never creates a
 * second one. Creates also carry a `requestid`, so a create that is retried
 * after a timeout is answered with the first result instead of a duplicate.
 *
 * CUSTOMERS ARE LOOKED UP BEFORE THEY ARE CREATED. Until 2026-10-09 every push
 * created a customer, and QuickBooks refuses a second customer with the same
 * DisplayName, so a client's second invoice could never sync.
 */

/** What the owner chose on Settings → Accounting, all QuickBooks Ids. */
export type QboMapping = {
  /** The product/service every service line posts through. Its income
   *  account is where the revenue lands. */
  service_item_id: string | null;
  /** The item a sales-tax line posts through (its account should be the
   *  sales-tax liability). Only needed by a business that charges tax. */
  sales_tax_item_id?: string | null;
  /** Where payments are deposited. Blank: QuickBooks' Undeposited Funds. */
  deposit_account_id?: string | null;
};

export type InvoiceForSync = {
  id: string;
  number: number | null;
  /** The organization's timezone: `issued_at` is an instant and QuickBooks
   *  wants a calendar DAY, and the day decides the tax year in their books. */
  timezone?: string | null;
  total_cents: number;
  /** Sales tax inside total_cents, and the rate/label it was made at. */
  tax_cents?: number | null;
  tax_rate_bps?: number | null;
  tax_label?: string | null;
  credit_applied_cents?: number | null;
  currency: string | null;
  issued_at: string | null;
  due_on?: string | null;
  accounting_remote_id: string | null;
  client: ClientForSync | null;
  lines: Array<{
    description: string | null;
    amount_cents: number;
    quantity?: number | string | null;
    unit_amount_cents?: number | null;
  }>;
};

export type ClientForSync = {
  id: string;
  display_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  primary_email: string | null;
  accounting_remote_id: string | null;
};

export type PaymentForSync = {
  id: string;
  amount_cents: number;
  paid_at: string | null;
  created_at: string;
  method?: string | null;
  reference?: string | null;
  accounting_remote_id: string | null;
};

/** A problem with what would be sent, found before anything is sent. Recorded
 *  like a QuickBooks validation error and never retried. */
export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncValidationError";
  }
}

function centsFormatter(currency: string | null | undefined) {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "USD").toUpperCase(),
  });
  return (c: number) => fmt.format(c / 100);
}

/**
 * The sales-tax line an invoice sends to the books, or null when it has none.
 *
 * THE CHOICE: tax goes across as a separate LINE, through the item the owner
 * names for sales tax (whose account is their sales-tax liability), not
 * through QuickBooks' own tax engine. Automated sales tax computes tax itself
 * from settings HoundStack cannot see, and a figure it recomputes can differ
 * by a cent from the one the customer was billed and paid. A line carries the
 * exact amount on the invoice, so the synced total always equals ours. What it
 * must not do is post to income, so an invoice with tax refuses to sync until
 * the item is set rather than guessing. Every invoice with no tax sends
 * exactly the lines it always sent.
 */
export function accountingTaxLine(
  mapping: Pick<QboMapping, "sales_tax_item_id">,
  invoice: Pick<InvoiceForSync, "tax_cents" | "tax_rate_bps" | "tax_label">,
): { description: string; amountCents: number; item: string } | null {
  const tax = Number(invoice.tax_cents ?? 0);
  if (!(tax > 0)) return null;
  const item = mapping.sales_tax_item_id?.trim();
  if (!item) {
    throw new SyncValidationError(
      "This invoice carries sales tax. Choose a sales tax item on the accounting settings page first, so the tax posts as a liability and not as income.",
    );
  }
  return { description: taxLineLabel(invoice.tax_label, invoice.tax_rate_bps), amountCents: tax, item };
}

/** The invoice's lines, each with the item it posts through: the service
 *  lines through the service item, then the tax line (if any) through the
 *  sales-tax item. One list, so every line is built through accountingLine. */
function linesWithItems(
  mapping: QboMapping,
  invoice: InvoiceForSync,
  taxLine: ReturnType<typeof accountingTaxLine>,
): Array<{ li: InvoiceForSync["lines"][number]; item: string }> {
  const service = mapping.service_item_id?.trim();
  if (!service) throw new SyncValidationError("Choose the QuickBooks product or service your invoices post to first.");
  return [
    ...(invoice.lines ?? []).map((li) => ({ li, item: service })),
    ...(taxLine ? [{ li: { description: taxLine.description, amount_cents: taxLine.amountCents }, item: taxLine.item }] : []),
  ];
}

/** The Invoice body, without Id/SyncToken. Pure, so the amounts and dates are
 *  testable without QuickBooks. */
export function qboInvoiceBody(mapping: QboMapping, invoice: InvoiceForSync, customerId: string) {
  const taxLine = accountingTaxLine(mapping, invoice);
  const money = centsFormatter(invoice.currency);
  const lines = linesWithItems(mapping, invoice, taxLine).map(({ li, item }) => {
    // Qty and UnitPrice go across when the product is exact; see accountingLine.
    const l = accountingLine(li, money);
    return {
      Amount: l.amount,
      DetailType: "SalesItemLineDetail",
      Description: l.description,
      SalesItemLineDetail: { ItemRef: { value: item }, Qty: l.quantity, UnitPrice: l.unitAmount },
    };
  });
  // The books must say what the customer was billed, to the cent. A mismatch
  // here is a HoundStack data problem; posting it would hide it in their books.
  const sentCents = Math.round(lines.reduce((s, l) => s + l.Amount * 100, 0));
  if (sentCents !== invoice.total_cents) {
    throw new SyncValidationError(
      `The invoice lines add up to ${money(sentCents)} but the invoice total is ${money(invoice.total_cents)}, so it was not sent.`,
    );
  }
  const tz = invoice.timezone || DEFAULT_ORG_TIMEZONE;
  return {
    CustomerRef: { value: customerId },
    // The org's calendar day, not the UTC one: an invoice issued 2025-12-31
    // 21:00 Chicago is a 2025 invoice in the customer's books.
    TxnDate: invoice.issued_at ? orgLocalDay(invoice.issued_at, tz) : undefined,
    DueDate: invoice.due_on ?? undefined,
    Line: lines,
    CurrencyRef: { value: (invoice.currency ?? "USD").toUpperCase() },
    PrivateNote: invoice.number != null ? `HoundStack invoice #${invoice.number}` : "HoundStack invoice",
  };
}

/** The Payment body, applied to the QuickBooks invoice. `amount_cents` is the
 *  invoice amount the payment settled; a card surcharge and a tip sit beside
 *  it in their own columns and are not part of what the invoice is owed. */
export function qboPaymentBody(
  mapping: QboMapping,
  payment: PaymentForSync,
  p: { invoiceRemoteId: string; customerId: string; timezone?: string | null; currency: string | null },
) {
  if (!(payment.amount_cents > 0)) throw new SyncValidationError("A payment of zero has nothing to record.");
  const amount = payment.amount_cents / 100;
  const deposit = mapping.deposit_account_id?.trim();
  const ref = payment.reference?.trim();
  return {
    CustomerRef: { value: p.customerId },
    TotalAmt: amount,
    TxnDate: orgLocalDay(payment.paid_at ?? payment.created_at, p.timezone || DEFAULT_ORG_TIMEZONE),
    CurrencyRef: { value: (p.currency ?? "USD").toUpperCase() },
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: p.invoiceRemoteId, TxnType: "Invoice" }] }],
    ...(deposit ? { DepositToAccountRef: { value: deposit } } : {}),
    ...(ref ? { PaymentRefNum: ref.slice(0, 21) } : {}),
    PrivateNote: `HoundStack payment${payment.method ? ` (${payment.method})` : ""}`,
  };
}

/** QuickBooks' DisplayName: unique per company, no colon, tab or newline, at
 *  most 500 characters. */
export function qboDisplayName(client: Pick<ClientForSync, "display_name" | "company" | "first_name" | "last_name">): string {
  const raw =
    client.display_name?.trim() ||
    client.company?.trim() ||
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() ||
    "HoundStack client";
  return raw.replace(/[:\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

type QboCustomer = { Id: string; DisplayName?: string; PrimaryEmailAddr?: { Address?: string } };

const sameEmail = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The QuickBooks Customer for a client: the stored Id if there is one, else an
 * existing customer found by DisplayName or email, else a new one. Returns
 * the Id and whether it should be written back onto the client.
 */
export async function findOrCreateQboCustomer(
  qbo: QboClient,
  client: ClientForSync,
  requestId: string,
): Promise<{ id: string; store: boolean }> {
  if (client.accounting_remote_id) return { id: client.accounting_remote_id, store: false };
  const name = qboDisplayName(client);
  const email = client.primary_email?.trim() || null;

  const byName = await qbo.query<{ Customer?: QboCustomer[] }>(
    `select Id, DisplayName, PrimaryEmailAddr from Customer where DisplayName = ${qboQuoted(name)}`,
  );
  const named = byName.QueryResponse?.Customer?.[0];
  // Same name, and either the same email or no email on one side to say
  // otherwise: the same customer. Same name with a DIFFERENT email is a
  // different person who happens to share a name.
  if (named && (!email || !named.PrimaryEmailAddr?.Address || sameEmail(email, named.PrimaryEmailAddr.Address))) {
    return { id: named.Id, store: true };
  }
  if (email) {
    const byEmail = await qbo.query<{ Customer?: QboCustomer[] }>(
      `select Id, DisplayName, PrimaryEmailAddr from Customer where PrimaryEmailAddr = ${qboQuoted(email)}`,
    );
    const match = byEmail.QueryResponse?.Customer?.[0];
    if (match) return { id: match.Id, store: true };
  }

  // A name collision with a different person: keep their names apart.
  const displayName = named ? `${name} (${client.id.slice(0, 6)})` : name;
  const created = await qbo.request<{ Customer?: QboCustomer }>("POST", "customer", {
    query: { requestid: requestId },
    body: {
      DisplayName: displayName,
      ...(client.company?.trim() ? { CompanyName: client.company.trim().slice(0, 100) } : {}),
      ...(client.first_name?.trim() ? { GivenName: client.first_name.trim().slice(0, 100) } : {}),
      ...(client.last_name?.trim() ? { FamilyName: client.last_name.trim().slice(0, 100) } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    },
  });
  const id = created.Customer?.Id;
  if (!id) throw new Error("QuickBooks returned no customer id");
  return { id, store: true };
}

/** Read an object's SyncToken, or null when it no longer exists in QuickBooks
 *  (deleted there), in which case the caller creates it again. */
async function currentSyncToken(qbo: QboClient, entity: "invoice" | "payment", id: string): Promise<string | null> {
  try {
    const res = await qbo.request<Record<string, { SyncToken?: string } | undefined>>("GET", `${entity}/${encodeURIComponent(id)}`);
    const obj = res[entity === "invoice" ? "Invoice" : "Payment"];
    return obj?.SyncToken ?? null;
  } catch (e) {
    if (e instanceof QboApiError && e.kind === "not_found") return null;
    throw e;
  }
}

/** Create the object, or update it in place when it was pushed before. */
async function upsertEntity(
  qbo: QboClient,
  entity: "invoice" | "payment",
  existingId: string | null,
  body: Record<string, unknown>,
  requestId: string,
): Promise<{ id: string; created: boolean }> {
  const key = entity === "invoice" ? "Invoice" : "Payment";
  if (existingId) {
    const syncToken = await currentSyncToken(qbo, entity, existingId);
    if (syncToken != null) {
      const res = await qbo.request<Record<string, { Id?: string } | undefined>>("POST", entity, {
        body: { ...body, Id: existingId, SyncToken: syncToken, sparse: true },
      });
      return { id: res[key]?.Id ?? existingId, created: false };
    }
  }
  const res = await qbo.request<Record<string, { Id?: string } | undefined>>("POST", entity, {
    query: { requestid: requestId },
    body,
  });
  const id = res[key]?.Id;
  if (!id) throw new Error(`QuickBooks returned no ${entity} id`);
  return { id, created: true };
}

export function upsertQboInvoice(
  qbo: QboClient,
  mapping: QboMapping,
  invoice: InvoiceForSync,
  customerId: string,
  requestId: string,
) {
  return upsertEntity(qbo, "invoice", invoice.accounting_remote_id, qboInvoiceBody(mapping, invoice, customerId), requestId);
}

export function upsertQboPayment(
  qbo: QboClient,
  mapping: QboMapping,
  payment: PaymentForSync,
  p: { invoiceRemoteId: string; customerId: string; timezone?: string | null; currency: string | null },
  requestId: string,
) {
  return upsertEntity(qbo, "payment", payment.accounting_remote_id, qboPaymentBody(mapping, payment, p), requestId);
}
