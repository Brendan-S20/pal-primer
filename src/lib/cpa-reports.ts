// BUILD-13 — the accountant's pack.
//
// The owner's ask: "we should be able to generate multiple different reports
// that can be provided to a CPA or tax accountant, this way we have it all in
// one and we don't have to put a strain on them to try to find numbers that are
// needed and are not available or hard to calculate."
//
// Everything here is pure so the definitions can be unit-tested. The server
// module builds the rows; this module owns WHAT each report means, which is the
// part that has to be right and the part that has to stay stable year over
// year. A report whose definition drifts between filings is worse than no
// report — it produces two different answers to the same question and nobody
// can tell which year was wrong.
//
// ── THE THING THAT MATTERS MOST: BASIS ─────────────────────────────────────
//
// A small service business almost always files CASH basis: income when the
// money arrives, expenses when they are paid. The app's own /reports page has
// always shown something in between — invoices marked paid, dated by when they
// were ISSUED — which is neither basis and cannot be handed to anyone. That is
// fine for "how are we doing"; it is not fine for a tax return.
//
// So every report here declares its basis explicitly and the two are computed
// from different tables on purpose:
//
//   CASH     payments.paid_at        money that actually landed
//   ACCRUAL  invoices.issued_at      what was billed, paid or not
//
// and `cash_accrual_bridge` reconciles them, because the first question any
// competent accountant asks is "why doesn't this tie to the bank?"
//
// ── AND THE THING MOST LIKELY TO BE GOT WRONG: REFUNDS ─────────────────────
//
// When a refund lands, the webhook sets payments.status = 'refunded'. If cash
// income filtered on status = 'succeeded', a refund in October would silently
// erase income recorded in March — restating a period that may already have
// been filed. Nobody would see it happen.
//
// So cash income counts every payment that actually arrived ('succeeded' OR
// 'refunded'), and refunds appear as a separately dated contra line in the
// period they occurred. Gross minus refunds equals net, no closed period ever
// moves, and the return matches the 1099-K. See REVERSAL_KINDS below.

import type { AppRole } from "@/hooks/useMyRole";
import { hasEntitlement, type PlanTier } from "@/lib/entitlements";
import { hasPermission } from "@/lib/permissions";

export type ReportBasis = "cash" | "accrual" | "none";

export type ColumnType = "text" | "money" | "date" | "number";

export type ReportColumn = {
  key: string;
  label: string;
  type: ColumnType;
};

export type ReportId =
  | "income_cash"
  | "tips_received"
  | "sales_tax_collected"
  | "income_accrual"
  | "cash_accrual_bridge"
  | "revenue_by_client"
  | "ar_aging"
  | "reversals"
  | "write_offs"
  | "stripe_1099k"
  | "franchise_settlements"
  | "referral_rewards"
  | "quickbooks_invoices";

export type ReportDef = {
  id: ReportId;
  title: string;
  /** One line an accountant can read to know whether this is the sheet they
   *  wanted, written for them rather than for the business owner. */
  purpose: string;
  basis: ReportBasis;
  columns: ReportColumn[];
  /** Shown above the table and carried into the CSV, because a number handed
   *  over without its definition will be misread. */
  note?: string;
  /** Only offered when the organization is part of a franchise. */
  franchiseOnly?: boolean;
  /** A file another program imports, not a sheet a person reads. Its CSV is
   *  the rows and nothing else (the definition lines every other report
   *  carries would be read as broken invoices), split into files the
   *  importer accepts. See quickbooks-import.ts. */
  importFile?: boolean;
};

const money = (key: string, label: string): ReportColumn => ({ key, label, type: "money" });
const text = (key: string, label: string): ReportColumn => ({ key, label, type: "text" });
const date = (key: string, label: string): ReportColumn => ({ key, label, type: "date" });
const num = (key: string, label: string): ReportColumn => ({ key, label, type: "number" });

export const REPORT_DEFS: Record<ReportId, ReportDef> = {
  income_cash: {
    id: "income_cash",
    title: "Income: cash basis, by month",
    purpose:
      "Gross customer payments received, refunds and chargebacks taken out, net income. This is the figure that ties to the bank and to the 1099-K.",
    basis: "cash",
    columns: [
      text("month", "Month"),
      money("grossCents", "Gross received"),
      money("refundsCents", "Refunds & chargebacks"),
      money("netCents", "Net income"),
      num("paymentCount", "Payments"),
    ],
    note: "Dated by when each payment settled, in the organization's own timezone. A payment that was later refunded still appears as gross income in the month it arrived. The refund is deducted in the month it happened, so a prior period is never restated. A dispute that is later WON is added back in the month the money returned, so this column is net of recoveries and can be negative in a month where more came back than went out.",
  },
  tips_received: {
    id: "tips_received",
    title: "Tips received, by month",
    purpose:
      "Tips customers added when paying an invoice, kept out of income above because they are not payment for the service. Tips received plus net income is what the payments brought in.",
    basis: "cash",
    columns: [
      text("month", "Month"),
      money("tipsCents", "Tips received"),
      money("tipsRefundedCents", "Tips refunded"),
      money("netTipsCents", "Net tips"),
      num("tippedPaymentCount", "Tipped payments"),
    ],
    note: "Dated by when each payment settled, in the organization's own timezone, the same as the cash income report. A refund returns its share of the tip in proportion to the charge (a $115 payment of $100 plus a $15 tip, refunded $57.50, returns $7.50 of tip) and that share is deducted here, in the month of the refund. A chargeback is deducted whole, tip included, from income in the cash income report, so it is not deducted here a second time.",
  },
  sales_tax_collected: {
    id: "sales_tax_collected",
    title: "Sales tax collected, by month",
    purpose:
      "Sales tax billed on invoices and collected with payments, less tax given back in refunds and chargebacks. Tax collected is owed to the state: it is kept out of every income figure in this pack and belongs on the sales-tax return.",
    basis: "cash",
    columns: [
      text("month", "Month"),
      money("taxBilledCents", "Tax billed"),
      money("taxCollectedCents", "Tax collected"),
      money("taxRefundedCents", "Tax refunded"),
      money("netTaxCollectedCents", "Net tax collected"),
      num("taxedPaymentCount", "Taxed payments"),
    ],
    note: "Tax billed is dated by invoice issue date (accrual). Tax collected is each payment's share of its invoice's tax, in proportion to the payment (a $54.13 payment on a $108.25 invoice carrying $8.25 of tax collected $4.13), dated by when the payment settled, in the organization's own timezone. A refund or chargeback returns its share the same way, in the month it happened; a dispute that is later won is added back. Tax on an invoice settled from account credit is billed but not collected here, because no money arrived with it. Every invoice carries the rate it was made at; a rate changed later does not restate an earlier month.",
  },
  income_accrual: {
    id: "income_accrual",
    title: "Income: accrual basis, by month",
    purpose:
      "Revenue billed in each month whether or not it was collected, with account credits shown separately. For a business filing accrual basis, or for anyone comparing billed against collected.",
    basis: "accrual",
    columns: [
      text("month", "Month"),
      money("invoicedCents", "Invoiced"),
      money("creditsAppliedCents", "Credits applied"),
      money("netCents", "Net billed"),
      num("invoiceCount", "Invoices"),
    ],
    note: "Dated by invoice issue date. Draft and voided invoices are excluded; uncollectible ones are included here and written off separately, which is how a bad debt deduction is supported.",
  },
  cash_accrual_bridge: {
    id: "cash_accrual_bridge",
    title: "Cash-to-accrual bridge",
    purpose:
      "Explains the gap between what was billed and what was banked, so the two income reports can be tied to each other and to the accounts receivable balance.",
    basis: "none",
    columns: [text("line", "Line"), money("amountCents", "Amount")],
    note: "Reads top to bottom: opening receivables, plus what was billed, less what was collected, credited or written off, gives closing receivables. If the closing figure does not match the aging report, something was changed after the fact and is worth finding before filing.",
  },
  revenue_by_client: {
    id: "revenue_by_client",
    title: "Income by customer: cash basis",
    purpose:
      "What each customer actually paid during the period. Supports customer-level questions and any 1099 obligations running the other way.",
    basis: "cash",
    columns: [
      text("clientName", "Customer"),
      money("grossCents", "Gross received"),
      money("refundsCents", "Refunds"),
      money("netCents", "Net"),
      num("paymentCount", "Payments"),
    ],
  },
  ar_aging: {
    id: "ar_aging",
    title: "Accounts receivable aging",
    purpose:
      "Open balances as at the end of the period, bucketed by age. Supports the closing receivables figure on the balance sheet and any bad-debt position.",
    basis: "accrual",
    columns: [
      text("clientName", "Customer"),
      money("currentCents", "Current"),
      money("d30Cents", "1–30 days"),
      money("d60Cents", "31–60 days"),
      money("d90Cents", "61–90 days"),
      money("d90PlusCents", "Over 90 days"),
      money("totalCents", "Total open"),
    ],
    note: "Aged as at the period end date, not today. Running this in March for last December gives December's position, which is the one the return needs.",
  },
  reversals: {
    id: "reversals",
    title: "Refunds & chargebacks register",
    purpose:
      "Every reversal, line by line, with the date the money left. Contra-revenue supporting the deduction taken on the cash-basis income report.",
    basis: "cash",
    columns: [
      date("occurredAt", "Date"),
      text("kindLabel", "Type"),
      text("clientName", "Customer"),
      money("amountCents", "Amount"),
      text("statusLabel", "Outcome"),
    ],
    note: "A won dispute appears as a recovery and is not deducted, because the money came back. Only refunds and lost or open chargebacks reduce income.",
  },
  write_offs: {
    id: "write_offs",
    title: "Write-offs & voided invoices",
    purpose:
      "Invoices voided or marked uncollectible during the period. A cash-basis filer cannot deduct these, having never recognised the income; an accrual-basis filer generally can.",
    basis: "accrual",
    columns: [
      date("dateOn", "Date"),
      text("clientName", "Customer"),
      text("statusLabel", "Outcome"),
      money("amountCents", "Amount"),
      text("reference", "Invoice"),
    ],
    note: "Kept separate from income on purpose. Whether a write-off is deductible depends on the basis the return is filed on, which is your accountant's call and not something this report should pre-empt.",
  },
  stripe_1099k: {
    id: "stripe_1099k",
    title: "Processor volume & 1099-K reconciliation",
    purpose:
      "Card volume grouped by the Stripe account that collected it, next to income recognised in the app. Explains any difference between the 1099-K and the return.",
    basis: "cash",
    columns: [
      text("collectedBy", "Collected by"),
      money("grossCents", "Gross card volume"),
      money("refundsCents", "Refunds & chargebacks"),
      money("netCents", "Net"),
      num("paymentCount", "Transactions"),
    ],
    note: "Stripe reports GROSS volume on the 1099-K, before refunds and before its own fees. Net income on a return is almost always lower, and this is the sheet that shows why.",
  },
  franchise_settlements: {
    id: "franchise_settlements",
    title: "Franchise royalties & settlements",
    purpose:
      "Each settlement period: revenue, royalty, adjustments carried forward, and which way the balance ran. Royalty is income to the franchisor and a deductible expense to the location.",
    basis: "accrual",
    columns: [
      text("counterparty", "Location / franchise"),
      date("periodStart", "Period start"),
      date("periodEnd", "Period end"),
      money("revenueCents", "Revenue"),
      money("royaltyCents", "Royalty"),
      money("adjustmentsCents", "Adjustments"),
      text("directionLabel", "Direction"),
      money("netDueCents", "Net"),
      text("statusLabel", "Status"),
    ],
    franchiseOnly: true,
    note: "Adjustments are the location's share of refunds and chargebacks carried into the period. Draft settlements are shown so nothing is invisible, but only sent ones represent an agreed amount.",
  },
  referral_rewards: {
    id: "referral_rewards",
    title: "Referral rewards",
    purpose:
      "Rewards earned for referring other businesses, and when each was paid. Income when received; a reward still in its holding period is not income yet.",
    basis: "cash",
    columns: [
      text("referredName", "Referred business"),
      date("convertedAt", "Converted"),
      money("rewardCents", "Reward"),
      date("eligibleAt", "Eligible"),
      date("paidAt", "Paid"),
      text("statusLabel", "Status"),
    ],
    note: "Only rows with a paid date are income in this period. Earned-but-unpaid rewards are listed so the balance is visible, not because they are taxable yet.",
  },
  quickbooks_invoices: {
    id: "quickbooks_invoices",
    title: "Invoices for QuickBooks import",
    purpose:
      "Every invoice issued in the period, one row per line, in the format QuickBooks Online's own invoice import takes (Settings → Import data → Invoices). No connection needed.",
    basis: "accrual",
    columns: [
      text("invoiceNo", "Invoice No."),
      text("customer", "Customer"),
      text("invoiceDate", "Invoice Date"),
      text("dueDate", "Due Date"),
      text("description", "Item Description"),
      num("quantity", "Item Quantity"),
      money("rateCents", "Item Rate"),
      money("amountCents", "Item Amount"),
    ],
    note: "QuickBooks takes at most 100 invoices per import, so a longer period downloads as several files; import them one at a time. When asked, choose the date format MM/DD/YYYY and tick the option to add customers that do not exist yet. Payments are not part of this file: record them in QuickBooks, or connect the live sync when it is available.",
    importFile: true,
  },
};

export const REPORT_ORDER: ReportId[] = [
  "income_cash",
  "tips_received",
  "sales_tax_collected",
  "income_accrual",
  "cash_accrual_bridge",
  "revenue_by_client",
  "ar_aging",
  "reversals",
  "write_offs",
  "stripe_1099k",
  "franchise_settlements",
  "referral_rewards",
  "quickbooks_invoices",
];

export function reportsFor(opts: { inFranchise: boolean }): ReportDef[] {
  return REPORT_ORDER.map((id) => REPORT_DEFS[id]).filter(
    (d) => !d.franchiseOnly || opts.inFranchise,
  );
}

// ── Tips ───────────────────────────────────────────────────────────────────

/** A received payment's tip, dated on the org's calendar. */
export type TipReceipt = { day: string; tipCents: number };
/** The tip share of a refund, dated when the refund happened. */
export type TipRefund = { day: string; tipCents: number };

/**
 * Tips by month: received, refunded, net, and how many payments carried one.
 *
 * Pure, so the report and its test share one implementation. Every month in
 * the range gets a row, zero or not, the same as the income sheet beside it:
 * a month missing from a tax sheet reads as a month nobody looked at.
 */
export function tipsByMonth(
  months: string[],
  receipts: readonly TipReceipt[],
  refunds: readonly TipRefund[],
): Array<{
  month: string;
  tipsCents: number;
  tipsRefundedCents: number;
  netTipsCents: number;
  tippedPaymentCount: number;
}> {
  const by = new Map<string, { tips: number; refunded: number; count: number }>();
  for (const m of months) by.set(m, { tips: 0, refunded: 0, count: 0 });
  const at = (m: string) => {
    let b = by.get(m);
    if (!b) {
      b = { tips: 0, refunded: 0, count: 0 };
      by.set(m, b);
    }
    return b;
  };
  for (const r of receipts) {
    const cents = Math.max(0, Math.round(r.tipCents));
    if (cents <= 0) continue;
    const b = at(monthKey(r.day));
    b.tips += cents;
    b.count += 1;
  }
  for (const r of refunds) {
    const cents = Math.max(0, Math.round(r.tipCents));
    if (cents <= 0) continue;
    at(monthKey(r.day)).refunded += cents;
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, b]) => ({
      month: m,
      tipsCents: b.tips,
      tipsRefundedCents: b.refunded,
      netTipsCents: b.tips - b.refunded,
      tippedPaymentCount: b.count,
    }));
}

// ── Sales tax ──────────────────────────────────────────────────────────────

/** Tax on an invoice billed on `day` (its issue day, org calendar). */
export type TaxBilled = { day: string; taxCents: number };
/** A received payment's tax share, dated when the money arrived. */
export type TaxReceipt = { day: string; taxCents: number };
/** The tax share of a reversal, dated when it happened. Positive takes tax
 *  collected down (a refund, a chargeback); negative puts it back (a won
 *  dispute). */
export type TaxReversal = { day: string; taxCents: number };

/**
 * Sales tax by month: billed, collected, refunded, net, and how many payments
 * carried some.
 *
 * Pure, so the report and its test share one implementation, and shaped like
 * `tipsByMonth` beside it: every month in the range gets a row, zero or not.
 * For a business that never set a rate every row is zero, which is the honest
 * answer rather than a missing sheet.
 */
export function salesTaxByMonth(
  months: string[],
  billed: readonly TaxBilled[],
  receipts: readonly TaxReceipt[],
  reversals: readonly TaxReversal[],
): Array<{
  month: string;
  taxBilledCents: number;
  taxCollectedCents: number;
  taxRefundedCents: number;
  netTaxCollectedCents: number;
  taxedPaymentCount: number;
}> {
  const by = new Map<string, { billed: number; collected: number; refunded: number; count: number }>();
  for (const m of months) by.set(m, { billed: 0, collected: 0, refunded: 0, count: 0 });
  const at = (m: string) => {
    let b = by.get(m);
    if (!b) {
      b = { billed: 0, collected: 0, refunded: 0, count: 0 };
      by.set(m, b);
    }
    return b;
  };
  for (const r of billed) {
    const cents = Math.max(0, Math.round(r.taxCents));
    if (cents <= 0) continue;
    at(monthKey(r.day)).billed += cents;
  }
  for (const r of receipts) {
    const cents = Math.max(0, Math.round(r.taxCents));
    if (cents <= 0) continue;
    const b = at(monthKey(r.day));
    b.collected += cents;
    b.count += 1;
  }
  for (const r of reversals) {
    const cents = Math.round(r.taxCents);
    if (cents === 0) continue;
    at(monthKey(r.day)).refunded += cents;
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, b]) => ({
      month: m,
      taxBilledCents: b.billed,
      taxCollectedCents: b.collected,
      taxRefundedCents: b.refunded,
      netTaxCollectedCents: b.collected - b.refunded,
      taxedPaymentCount: b.count,
    }));
}

// ── Reversal classification ────────────────────────────────────────────────
//
// The review queue is the single record of every reversal (it is filed by
// file_reversal_review_item on the same webhook that records the money), so the
// register and the income deduction read from one place and cannot disagree.

export const REVERSAL_KINDS = [
  "payment_refunded",
  "payment_chargeback",
  "payment_chargeback_won",
] as const;

export type ReversalKind = (typeof REVERSAL_KINDS)[number];

export function reversalLabel(kind: string): { type: string; outcome: string } {
  switch (kind) {
    case "payment_refunded":
      return { type: "Refund", outcome: "Refunded to customer" };
    case "payment_chargeback":
      return { type: "Chargeback", outcome: "Disputed, funds withdrawn" };
    case "payment_chargeback_won":
      return { type: "Chargeback won", outcome: "Recovered" };
    default:
      return { type: kind, outcome: "" };
  }
}

/** Does this reversal reduce income? A won dispute does not — the money came
 *  back, and deducting it as well as recording the recovery would understate
 *  income by the amount twice over. */
export function reducesIncome(kind: string): boolean {
  return kind === "payment_refunded" || kind === "payment_chargeback";
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** A timestamp's calendar day in the ORGANIZATION's timezone.
 *
 *  This has been the root cause of more bugs in this codebase than anything
 *  else (BUG-9, BUG-12, and the portal's upcoming-visits list). For an org west
 *  of UTC, a payment taken at 7pm on 31 December is a UTC 1 January timestamp —
 *  so a naive slice(0,10) files it in the wrong TAX YEAR. That is not a
 *  cosmetic off-by-one.
 *
 *  en-CA formats as YYYY-MM-DD, which is the shape every date column here uses. */
export { orgLocalDay } from "@/lib/org-day";


/** "2026-03-14" → "2026-03". */
export function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** "2026-03" → "March 2026", for a human reading the sheet. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return `${MONTHS[m - 1]} ${y}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Every month between two YYYY-MM-DD days, inclusive — so a month with no
 *  activity shows as a zero row rather than vanishing. A gap in a monthly
 *  income sheet reads as missing data and invites a question that costs
 *  somebody an hour. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ey, em] = to.slice(0, 7).split("-").map(Number);
  if (!y || !m || !ey || !em) return out;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export type AgingBucket = "current" | "d30" | "d60" | "d90" | "d90plus";

/** Which aging column an open balance falls in, as at a given day.
 *
 *  Aged from the DUE date, not the issue date. The app's /reports page ages
 *  from issue, which reports an invoice on 30-day terms as a week overdue on
 *  the day it was sent. Harmless on a dashboard; wrong on a schedule an
 *  accountant uses to judge collectability. Falls back to the issue date only
 *  when no due date was ever set. */
export function agingBucket(
  dueDay: string | null,
  issuedDay: string | null,
  asOfDay: string,
): AgingBucket {
  const ref = dueDay || issuedDay;
  if (!ref) return "current";
  const days = daysBetween(ref, asOfDay);
  if (days <= 0) return "current";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "d90plus";
}

/** Whole days from one YYYY-MM-DD to another. Both are anchored at UTC noon so
 *  no daylight-saving transition can shift the result by a day. */
export function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T12:00:00Z`);
  const b = Date.parse(`${toDay}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The calendar day before `day`, as YYYY-MM-DD.
 *
 *  Anchored at UTC noon for the same reason daysBetween is: stepping a bare
 *  midnight date back one day lands on 23:00 of the previous day in a zone that
 *  just changed its clocks, and slicing that gives the wrong date. Used for the
 *  opening position of a period and for the balance an invoice was carrying the
 *  day before it was voided — both are answers to "what was true just before",
 *  and both are wrong by a whole day if the arithmetic slips. */
export function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Does a settlement period overlap the reporting period?
 *
 *  `period_end` on a settlement is EXCLUSIVE — generate_franchise_settlements
 *  sums payments with `created_at < _end`, and the app generates December as
 *  2025-12-01 → 2026-01-01. Treating that end date as a day inside the period
 *  puts the December statement in the 2025 pack AND the 2026 pack, so its
 *  royalty is counted in two tax years and neither return can be traced back to
 *  the statements that support it. A period covers [start, end), so it overlaps
 *  an inclusive [from, to] window only when it starts on or before `to` and
 *  ends strictly after `from`. */
export function settlementOverlapsPeriod(
  periodStart: string,
  periodEndExclusive: string,
  from: string,
  to: string,
): boolean {
  if (!periodStart || !periodEndExclusive) return false;
  return periodStart <= to && periodEndExclusive > from;
}

/** May this caller see the franchise settlements sheet?
 *
 *  The settlement rows are read with service-role (neither party to a
 *  settlement is a member of the other's org), so the app layer is the only
 *  boundary there is. Every other route to these same rows — listRoyaltyInvoices
 *  and the rest of /franchise — requires manage_franchise AND the Enterprise
 *  franchise_structure entitlement. view_financials alone would let an
 *  office_manager at a location, who is denied manage_franchise precisely so
 *  they cannot see the franchise's side of the relationship, pull every
 *  settlement in the org from /tax-reports instead. One report must not be a
 *  tier below every other door to the same data. */
export function mayViewFranchiseSettlements(
  role: AppRole | null | undefined,
  tier: PlanTier,
): boolean {
  return hasPermission(role, "manage_franchise") && hasEntitlement(tier, "franchise_structure");
}

/** A filename an accountant can find again in six months without opening it. */
export function reportFileName(id: ReportId, from: string, to: string, orgName: string): string {
  const slug =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "houndstack";
  return `${slug}_${id}_${from}_to_${to}.csv`;
}

// ── The 1099-K explanation ─────────────────────────────────────────────────
//
// Owner: "For Stripe's 1099-K, have that explained when settings up how the
// payments come through, because truthfully it can be both ways if it's needed
// for accountants."
//
// It genuinely IS both ways, and the choice has a tax consequence that is not
// obvious and cannot be undone after the fact. Whoever's Stripe account
// receives the charge is the one who gets the 1099-K for the FULL gross amount
// — including the part they pass straight through to someone else. Deciding
// that in a settings screen without being told is how a franchise owner ends up
// explaining to the IRS why their reported volume is five times their revenue.
//
// This text is deliberately shared between the tax reports and the payment
// routing setup, so the two can never say different things.

export type RoutingAudience = "parent_collects" | "location_collects" | "independent";

export type Guidance = { headline: string; points: string[] };

export function stripe1099kGuidance(audience: RoutingAudience): Guidance {
  switch (audience) {
    case "parent_collects":
      return {
        headline: "The franchise receives the 1099-K for every location's card volume.",
        points: [
          "Stripe issues the 1099-K to whoever owns the account that took the charge. With the franchise collecting, that is the franchise, for the full gross amount across all locations, before royalties, refunds or fees.",
          "The locations receive no 1099-K for that volume at all. Their income is the settlement the franchise pays them, which is what their own return should reflect.",
          "The franchise reports the gross and deducts what it passed on. The settlement statements are the support for that deduction, which is why they are kept per period and never rewritten once sent.",
          "Expect the 1099-K to be much larger than the franchise's own revenue. That is normal for this arrangement, and the reconciliation report is what explains the difference.",
        ],
      };
    case "location_collects":
      return {
        headline: "Each location receives its own 1099-K.",
        points: [
          "The charge lands in the location's own Stripe account, so the 1099-K goes to that location for its own gross volume.",
          "Royalty paid to the franchise is a deductible business expense for the location, supported by the settlement statements.",
          "The franchise receives no 1099-K for this volume. Royalty it collects is ordinary income on its own return.",
          "This is the arrangement most accountants find simplest, because each business's 1099-K roughly matches its own books.",
        ],
      };
    default:
      return {
        headline: "You receive a 1099-K from Stripe for your card volume.",
        points: [
          "The 1099-K reports GROSS volume for the year: before refunds, before chargebacks, and before Stripe's processing fees.",
          "Net income on your return will be lower than the 1099-K, and that is expected. The reconciliation report shows the difference line by line.",
          "Stripe's own fees are a deductible expense; they are taken out before payout, so they never appear as income in HoundStack.",
        ],
      };
  }
}

/** Which explanation applies, from what the app already knows about the org.
 *
 *  A franchise parent only gets the parent-collects warning if it ACTUALLY
 *  collects for at least one location. Routing is per-location — a franchise
 *  can collect for the two locations it opened this year and leave the older
 *  ones on their own accounts — so `is_franchise_parent` alone says nothing
 *  about whose 1099-K is about to be surprising. */
export function routingAudience(org: {
  parentOrganizationId?: string | null;
  isFranchiseParent?: boolean | null;
  paymentsCollectedByParent?: boolean | null;
  collectsForAnyLocation?: boolean | null;
}): RoutingAudience {
  if (org.isFranchiseParent) {
    return org.collectsForAnyLocation ? "parent_collects" : "location_collects";
  }
  if (org.parentOrganizationId) {
    return org.paymentsCollectedByParent ? "parent_collects" : "location_collects";
  }
  return "independent";
}
