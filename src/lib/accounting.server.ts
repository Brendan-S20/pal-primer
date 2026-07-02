/**
 * Provider-specific accounting drivers.
 * Server-only: never import from client bundles.
 *
 * Both drivers hit the provider's REST API using the stored access token.
 * OAuth refresh is intentionally out of scope for this file — the caller
 * checks token_expires_at and re-runs the OAuth callback route to refresh.
 */

type Conn = {
  provider: "quickbooks" | "xero";
  realm_id: string | null;
  tenant_id: string | null;
  access_token: string;
  default_income_account: string | null;
  default_ar_account: string | null;
};

type InvoicePayload = {
  id: string;
  total_cents: number;
  currency: string;
  issued_at: string | null;
  period_start: string | null;
  period_end: string | null;
  clients: {
    display_name: string | null;
    primary_email: string | null;
    accounting_remote_id: string | null;
  } | null;
  invoice_line_items: Array<{ description: string | null; amount_cents: number }>;
};

const QBO_ENV = process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
const QBO_BASE =
  QBO_ENV === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

export async function pushInvoice(conn: Conn, invoice: InvoicePayload): Promise<string> {
  if (conn.provider === "quickbooks") return pushInvoiceQBO(conn, invoice);
  return pushInvoiceXero(conn, invoice);
}

async function pushInvoiceQBO(conn: Conn, invoice: InvoicePayload): Promise<string> {
  if (!conn.realm_id) throw new Error("QuickBooks realm_id missing");
  if (!conn.default_income_account) throw new Error("Set a default income account first");

  const customerRef = invoice.clients?.accounting_remote_id
    ?? (await ensureQBOCustomer(conn, invoice.clients?.display_name ?? "Client", invoice.clients?.primary_email));

  const lines = (invoice.invoice_line_items ?? []).map((li) => ({
    Amount: li.amount_cents / 100,
    DetailType: "SalesItemLineDetail",
    Description: li.description ?? "Service",
    SalesItemLineDetail: {
      ItemAccountRef: { value: conn.default_income_account },
    },
  }));

  const res = await fetch(`${QBO_BASE}/v3/company/${conn.realm_id}/invoice?minorversion=73`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      CustomerRef: { value: customerRef },
      TxnDate: invoice.issued_at?.slice(0, 10),
      Line: lines,
      CurrencyRef: { value: (invoice.currency ?? "USD").toUpperCase() },
    }),
  });
  if (!res.ok) throw new Error(`QBO invoice failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { Invoice?: { Id?: string } };
  const id = body.Invoice?.Id;
  if (!id) throw new Error("QBO returned no invoice id");
  return id;
}

async function ensureQBOCustomer(conn: Conn, name: string, email: string | null | undefined): Promise<string> {
  const res = await fetch(`${QBO_BASE}/v3/company/${conn.realm_id}/customer?minorversion=73`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      DisplayName: name,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`QBO customer failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { Customer?: { Id?: string } };
  if (!body.Customer?.Id) throw new Error("QBO returned no customer id");
  return body.Customer.Id;
}

async function pushInvoiceXero(conn: Conn, invoice: InvoicePayload): Promise<string> {
  if (!conn.tenant_id) throw new Error("Xero tenant_id missing");
  if (!conn.default_income_account) throw new Error("Set a default income account code first");

  const contact = invoice.clients?.accounting_remote_id
    ? { ContactID: invoice.clients.accounting_remote_id }
    : { Name: invoice.clients?.display_name ?? "Client", EmailAddress: invoice.clients?.primary_email ?? undefined };

  const lineItems = (invoice.invoice_line_items ?? []).map((li) => ({
    Description: li.description ?? "Service",
    Quantity: 1,
    UnitAmount: li.amount_cents / 100,
    AccountCode: conn.default_income_account,
  }));

  const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      "Xero-Tenant-Id": conn.tenant_id,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      Type: "ACCREC",
      Contact: contact,
      Date: invoice.issued_at?.slice(0, 10),
      LineItems: lineItems,
      Status: "AUTHORISED",
      CurrencyCode: (invoice.currency ?? "USD").toUpperCase(),
    }),
  });
  if (!res.ok) throw new Error(`Xero invoice failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { Invoices?: Array<{ InvoiceID?: string }> };
  const id = body.Invoices?.[0]?.InvoiceID;
  if (!id) throw new Error("Xero returned no invoice id");
  return id;
}
