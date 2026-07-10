// Shared accounts-receivable math so the Clients "Outstanding" card, the
// Dashboard "AR Open" card, and the Reports "Outstanding" figure can never
// drift (QA finding #7 — the Clients list queried non-existent invoice
// columns and always read $0.00, while Dashboard/Reports summed total_cents).
//
// Invoices carry a single `total_cents` and no partial-payment column, so an
// OPEN invoice's outstanding balance is its full total — exactly what Dashboard
// and Reports already sum. (`uncollectible` is written-off debt, not AR;
// `paid`/`void`/`draft` are never outstanding.)

export type ArInvoice = {
  status: string | null;
  total_cents: number | null;
  client_id?: string | null;
};

const OUTSTANDING_STATUSES = new Set(["open"]);

export function isOutstanding(inv: ArInvoice): boolean {
  return OUTSTANDING_STATUSES.has(inv.status ?? "");
}

/** Outstanding balance for one invoice (0 unless it's open/overdue). */
export function invoiceOutstandingCents(inv: ArInvoice): number {
  return isOutstanding(inv) ? inv.total_cents ?? 0 : 0;
}

/** Total outstanding across a set of invoices. */
export function sumOutstandingCents(invoices: ArInvoice[]): number {
  return invoices.reduce((sum, inv) => sum + invoiceOutstandingCents(inv), 0);
}

/** Outstanding balance grouped by client_id (only clients with a balance > 0). */
export function outstandingByClient(invoices: ArInvoice[]): Map<string, number> {
  const byClient = new Map<string, number>();
  for (const inv of invoices) {
    const owed = invoiceOutstandingCents(inv);
    if (owed <= 0 || !inv.client_id) continue;
    byClient.set(inv.client_id, (byClient.get(inv.client_id) ?? 0) + owed);
  }
  return byClient;
}
