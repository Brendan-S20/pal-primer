import { DEFAULT_ORG_TIMEZONE, daysBetweenOrgDays, orgLocalDay, orgToday } from "@/lib/org-day";
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
  /** Sales tax inside total_cents. Part of what the customer owes, so every
   *  receivable figure keeps it; taken back out only where the question is
   *  revenue (billedInPeriod). Absent means 0. */
  tax_cents?: number | null;
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
  // The fallback is the ORG default, not the server's day. Callers that know
  // the organization should pass its today; those that do not at least land on
  // the same calendar the database uses, rather than one five hours ahead.
  const today = todayISO ?? orgToday();
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
  const today = todayISO ?? orgToday();
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

// ── Point-in-time receivables ───────────────────────────────────────────────
//
// Everything above answers "what is open RIGHT NOW", which is the right
// question for the Dashboard and the Invoices index and the wrong one for a
// report about a period that has closed. `status` only ever tells you about
// today: an invoice paid last week is 'paid' now and was a receivable all of
// the month before, and asking `isOutstanding` about July in August answers
// with August's book.
//
// That is not a rounding difference. /reports showed $2,655.00 outstanding for
// July while the CPA pack showed $2,550.00 for the same period, because three
// invoices issued on 1 August were in one figure and not the other. Two
// surfaces, one question, two answers, and the owner holding both.
//
// So the position is reconstructed from the invoice's own timestamps, and both
// surfaces call THIS function rather than each keeping a copy.

/** An invoice with the timestamps a point-in-time position needs. Everything
 *  is optional because callers select different column sets; a missing
 *  timestamp means "never happened", which is the same answer as absent. */
export type LedgerInvoice = ArInvoice & {
  issued_at?: string | null;
  paid_at?: string | null;
  voided_at?: string | null;
  updated_at?: string | null;
  /** Credit applied to this invoice ON OR BEFORE the day being reconstructed,
   *  summed from `credit_ledger`, which is dated.
   *
   *  `credit_applied_cents` is a LIVE column with no date on it. Using it in a
   *  point-in-time reconstruction made the answer depend on today: a $200
   *  invoice still open at year end, with $150 of credit applied the following
   *  February, reported $50 for 31 December when the question was asked in
   *  March. The same figure feeds buildBridge's opening and closing
   *  receivables and /reports' arPositionAsOf, so a filed balance sheet could
   *  not be reproduced later — which is the one thing a point-in-time figure
   *  exists to guarantee.
   *
   *  Optional: absent, the live column is used, which is exactly right when the
   *  day being asked about IS today. */
  creditAppliedAsOf?: number | null;
};

/** Was this invoice an open receivable at the end of `day`, and for how much?
 *
 *  Reconstructed from the timestamps rather than the current status, because
 *  the status only tells you about today. Point-in-time is the whole job here:
 *  a December balance sheet prepared in March must show December. */
export function outstandingAsOf(
  inv: LedgerInvoice,
  day: string,
  tz: string = DEFAULT_ORG_TIMEZONE,
): number {
  // A draft has not been billed to anyone, so it is never a receivable — on any
  // day, including one where it happens to carry an issue date.
  if (inv.status === "draft") return 0;
  const issued = inv.issued_at ? orgLocalDay(inv.issued_at, tz) : null;
  if (!issued || issued > day) return 0;
  const paid = inv.paid_at ? orgLocalDay(inv.paid_at, tz) : null;
  if (paid && paid <= day) return 0;
  const voided = inv.voided_at ? orgLocalDay(inv.voided_at, tz) : null;
  if (voided && voided <= day) return 0;
  // 'uncollectible' is written-off debt, not a receivable — but only from the
  // day it was written off, which is the best date available for it.
  if (inv.status === "uncollectible") {
    const off = inv.updated_at ? orgLocalDay(inv.updated_at, tz) : null;
    if (off && off <= day) return 0;
  }
  // Dated credit when the caller supplied it; the live column otherwise. See
  // `creditAppliedAsOf` on LedgerInvoice for why the difference matters.
  const credit = inv.creditAppliedAsOf ?? inv.credit_applied_cents ?? 0;
  return Math.max((inv.total_cents ?? 0) - credit, 0);
}

export type ArAging = { current: number; d30: number; d60: number; d90: number };

export type ArPosition = {
  /** Open receivables at the end of `asOf`. */
  outstandingCents: number;
  aging: ArAging;
  openCount: number;
  /** Echoed back so a caller can label the figure with the day it measured
   *  rather than the day it thinks it asked for. */
  asOf: string;
};

/** The /reports receivables position: open balances as at `asOf`, bucketed by
 *  how long ago each invoice was ISSUED.
 *
 *  The TOTAL here is the same total the CPA pack's aging sheet prints, because
 *  both are built from `outstandingAsOf` at the same day. The SPLIT across
 *  buckets deliberately is not: the pack ages from the DUE date (see
 *  cpa-reports.agingBucket), which is the schedule an accountant judges
 *  collectability on, while this page ages from issue, which is the one an
 *  owner reads as "how long have I been waiting". Two answers to two different
 *  questions is fine. Two answers to the total open balance is not. */
export function arPositionAsOf(
  invoices: LedgerInvoice[],
  asOf: string,
  tz: string = DEFAULT_ORG_TIMEZONE,
): ArPosition {
  const aging: ArAging = { current: 0, d30: 0, d60: 0, d90: 0 };
  let outstandingCents = 0;
  let openCount = 0;
  for (const inv of invoices) {
    const owed = outstandingAsOf(inv, asOf, tz);
    if (owed <= 0) continue;
    outstandingCents += owed;
    openCount += 1;
    // Counted in the org's own calendar, not in elapsed hours: an invoice
    // issued at 23:00 yesterday is one day old on an accountant's schedule.
    const issued = inv.issued_at ? orgLocalDay(inv.issued_at, tz) : "";
    const days = issued ? daysBetweenOrgDays(issued, asOf) : 0;
    if (days <= 0) aging.current += owed;
    else if (days <= 30) aging.d30 += owed;
    else if (days <= 60) aging.d60 += owed;
    else aging.d90 += owed;
  }
  return { outstandingCents, aging, openCount, asOf };
}

// ── Accrual-basis billing ───────────────────────────────────────────────────
//
// What was BILLED in a period, which is a different question from what was
// COLLECTED (that one lives in revenue.ts and is the money that arrived).
// Keeping the two apart is the point: subtracting one from the other, or
// letting a figure drift between them, produces a number on no basis at all.

/** The day an invoice counts as billed revenue, or null if it never does.
 *
 *  Voids and drafts were never billed to anyone. An invoice with no issue date
 *  has not been issued yet. Everything else is dated by when it WAS issued —
 *  including one settled entirely from account credit, which is billed revenue
 *  that simply never produced a bank deposit. */
export function billedDay(
  inv: Pick<LedgerInvoice, "status" | "issued_at">,
  tz: string = DEFAULT_ORG_TIMEZONE,
): string | null {
  if (inv.status === "void" || inv.status === "draft") return null;
  if (!inv.issued_at) return null;
  return orgLocalDay(inv.issued_at, tz) || null;
}

export type BilledTotals = {
  /** Gross invoiced in the period, EXCLUDING sales tax: billed revenue. The
   *  tax on the same invoices is `taxBilledCents`, a liability. */
  billedCents: number;
  /** Sales tax on the invoices billed in the period. Zero for every org that
   *  never set a rate. */
  taxBilledCents: number;
  /** The part of it settled from the client's account credit rather than money. */
  creditsAppliedCents: number;
  /** billedCents − creditsAppliedCents. Credit reduces what was owed, not
   *  the taxable base, so a credit-covered invoice's tax stays in
   *  `taxBilledCents` and the whole credit comes off here. */
  netBilledCents: number;
  invoiceCount: number;
};

/** Accrual-basis billing for [from, to], in the org's own days. Same rule the
 *  CPA pack's "Income — accrual basis" sheet applies, via the same `billedDay`,
 *  so the monthly sheet and this page's total cannot drift apart. */
export function billedInPeriod(
  invoices: LedgerInvoice[],
  from: string,
  to: string,
  tz: string = DEFAULT_ORG_TIMEZONE,
): BilledTotals {
  const totals: BilledTotals = {
    billedCents: 0,
    taxBilledCents: 0,
    creditsAppliedCents: 0,
    netBilledCents: 0,
    invoiceCount: 0,
  };
  for (const inv of invoices) {
    const day = billedDay(inv, tz);
    if (!day || day < from || day > to) continue;
    const tax = Math.max(0, inv.tax_cents ?? 0);
    totals.billedCents += (inv.total_cents ?? 0) - tax;
    totals.taxBilledCents += tax;
    totals.creditsAppliedCents += inv.credit_applied_cents ?? 0;
    totals.invoiceCount += 1;
  }
  totals.netBilledCents = totals.billedCents - totals.creditsAppliedCents;
  return totals;
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
