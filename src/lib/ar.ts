// Shared accounts-receivable math — the ONE authoritative computation behind
// the Dashboard "AR open"/overdue cards, the Reports "Outstanding" + aging
// figures, the Invoices index "Outstanding" stat, and the Clients list
// "Outstanding" column (QA finding #7, re-broken as B1: the dashboard query
// stopped selecting `status`, so `isOutstanding` saw undefined and summed $0).
//
// Since credit application (B7), invoices carry `credit_applied_cents`: the
// portion of `total_cents` already covered by the client's credit balance.
// An OPEN invoice's outstanding balance is total_cents - credit_applied_cents.
// (`uncollectible` is written-off debt, not AR; `paid`/`void`/`draft` are
// never outstanding.)
//
// Overdue means: still open AND past its due date (invoices.due_on) — NOT
// "issued more than 30 days ago", which is what the dashboard used to show
// ("Nothing overdue" while the Invoices page counted 8 overdue by due_on).

export type ArInvoice = {
  status: string | null;
  total_cents: number | null;
  /** Portion of total_cents already covered by applied credit (B7). Rows
   * fetched before the column existed may omit it; treated as 0. */
  credit_applied_cents?: number | null;
  due_on?: string | null;
  client_id?: string | null;
};

const OUTSTANDING_STATUSES = new Set(["open"]);

export function isOutstanding(inv: ArInvoice): boolean {
  return OUTSTANDING_STATUSES.has(inv.status ?? "");
}

/** Outstanding balance for one invoice (0 unless it's open), net of applied credit. */
export function invoiceOutstandingCents(inv: ArInvoice): number {
  if (!isOutstanding(inv)) return 0;
  return Math.max((inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0), 0);
}

/** Whether this invoice is overdue: open and past its due date. */
export function isInvoiceOverdue(inv: ArInvoice, todayISO?: string): boolean {
  const today = todayISO ?? new Date().toISOString().slice(0, 10);
  return isOutstanding(inv) && !!inv.due_on && inv.due_on < today;
}

/** Total outstanding across a set of invoices. */
export function sumOutstandingCents(invoices: ArInvoice[]): number {
  return invoices.reduce((sum, inv) => sum + invoiceOutstandingCents(inv), 0);
}

export type ArSummary = {
  arOpenCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
};

/** The dashboard/reports rollup: open AR and overdue figures from one pass
 * over the invoice ledger, so every surface shows the same numbers. */
export function summarizeAr(invoices: ArInvoice[], todayISO?: string): ArSummary {
  const today = todayISO ?? new Date().toISOString().slice(0, 10);
  const summary: ArSummary = { arOpenCents: 0, openCount: 0, overdueCents: 0, overdueCount: 0 };
  for (const inv of invoices) {
    const owed = invoiceOutstandingCents(inv);
    if (!isOutstanding(inv)) continue;
    summary.openCount += 1;
    summary.arOpenCents += owed;
    if (isInvoiceOverdue(inv, today)) {
      summary.overdueCount += 1;
      summary.overdueCents += owed;
    }
  }
  return summary;
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

// ── Credit application math (B7) ────────────────────────────────────────────
// Pure mirror of the SQL routine public.apply_credit_to_invoice, so the money
// math is unit-testable without a database. The SQL function is the writer of
// record; this computes what it will do (and what UIs should preview).

export type CreditApplicationInput = {
  creditBalanceCents: number;
  invoice: ArInvoice & { kind?: string | null };
};

export type CreditApplicationResult = {
  /** Amount of credit that gets applied: min(available credit, open amount). */
  applyCents: number;
  /** What remains due on the invoice after application. */
  remainingDueCents: number;
  /** Invoice status after application. */
  invoiceStatus: string;
};

export function computeCreditApplication({
  creditBalanceCents,
  invoice,
}: CreditApplicationInput): CreditApplicationResult {
  const status = invoice.status ?? "";
  const open = invoiceOutstandingCents(invoice);
  // Only open, non-topup invoices can take credit (paying a prepaid top-up
  // with credit would be circular: paying a top-up GRANTS credit).
  if (status !== "open" || invoice.kind === "prepaid_topup" || open <= 0) {
    return { applyCents: 0, remainingDueCents: open, invoiceStatus: status };
  }
  const available = Math.max(creditBalanceCents, 0);
  const applyCents = Math.min(available, open);
  const remainingDueCents = open - applyCents;
  return {
    applyCents,
    remainingDueCents,
    invoiceStatus: remainingDueCents <= 0 ? "paid" : "open",
  };
}

// ── Visit → invoice line math, incl. the seasonal deep-clean surcharge ───────
// Pure mirror of the visit loop inside public.admin_generate_invoice_for_client
// (migration 20260731210000_a-deep-clean-was-billed-as-an-ordinary-visit.sql),
// same shape as computeCreditApplication above: the SQL is the writer of
// record, this makes its money math testable without a database. The bug it
// guards: deepclean_charge_cents was written on every generated deep-clean
// visit and read by nothing, so a deep clean invoiced at the ordinary visit
// price and the surcharge the tenant sells was never charged.

export type VisitBillingRow = {
  visitId: string;
  /** Canonical ISO date, as stored — descriptions are humanized at render. */
  scheduledOn: string;
  status: "completed" | "skipped";
  /** The subscription's ordinary per-visit price. */
  priceCents: number | null;
  street?: string | null;
  skipChargeCents?: number | null;
  skipReasonCode?: string | null;
  isDeepclean?: boolean | null;
  /** Snapshotted on the visit when it was generated, not read live from the
   *  org, so re-pricing the setting cannot retro-price a finished deep clean. */
  deepcleanChargeCents?: number | null;
};

export type InvoiceLineDraft = {
  /** null for the surcharge line: invoice_line_items_visit_unique allows one
   *  row per visit, and that row must stay the service line because every
   *  "not yet billed" test joins invoice_line_items on visit_id. */
  visitId: string | null;
  description: string;
  amountCents: number;
};

export function composeVisitInvoiceLines(v: VisitBillingRow): InvoiceLineDraft[] {
  const suffix = v.street ? ` - ${v.street}` : "";
  if (v.status === "skipped") {
    // A skipped deep clean did not happen: it bills its skip charge only.
    return [
      {
        visitId: v.visitId,
        description: `Skipped visit ${v.scheduledOn} (${v.skipReasonCode ?? "other"})`,
        amountCents: v.skipChargeCents ?? 0,
      },
    ];
  }
  const lines: InvoiceLineDraft[] = [
    {
      visitId: v.visitId,
      description: `${v.isDeepclean ? "Deep clean" : "Service"} on ${v.scheduledOn}${suffix}`,
      amountCents: v.priceCents ?? 0,
    },
  ];
  const surcharge = v.deepcleanChargeCents ?? 0;
  if (v.isDeepclean && surcharge > 0) {
    lines.push({
      visitId: null,
      description: `Seasonal deep-clean surcharge (${v.scheduledOn})`,
      amountCents: surcharge,
    });
  }
  return lines;
}

/** What the client is actually billed for one visit — the sum the invoice
 *  total moves by. Ordinary visit: the visit price. Deep clean: the visit
 *  price PLUS the seasonal surcharge. */
export function visitBillableCents(v: VisitBillingRow): number {
  return composeVisitInvoiceLines(v).reduce((sum, l) => sum + l.amountCents, 0);
}
