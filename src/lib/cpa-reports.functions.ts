import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  REPORT_DEFS,
  agingBucket,
  mayViewFranchiseSettlements,
  monthLabel,
  monthsBetween,
  monthKey,
  orgLocalDay,
  previousDay,
  reducesIncome,
  reportsFor,
  reversalLabel,
  routingAudience,
  salesTaxByMonth,
  tipsByMonth,
  settlementOverlapsPeriod,
  stripe1099kGuidance,
  type Guidance,
  type ReportColumn,
  type ReportId,
} from "@/lib/cpa-reports";
import {
  settlementDirectionLabel,
  settlementStatusLabel,
  type SettlementAudience,
} from "@/lib/franchise-settlement";
// Static rather than the dynamic import the other reversal readers use: this is
// the pure arithmetic half of that module (no service-role client behind it),
// and every sheet below needs it.
import { totalReversals, type Reversal } from "@/lib/reversals.server";
// The point-in-time receivables position and the accrual billing rule both live
// in the shared AR module. They used to live HERE, privately, while /reports
// answered the same two questions its own way — which is how the pack reported
// $2,550.00 open for July and the page reported $2,655.00. One implementation,
// two callers.
import { billedDay, invoiceDueCents, outstandingAsOf } from "@/lib/ar";
import { fetchAllPages as fetchAll } from "@/lib/supabase-paging.server";
import type { AppRole } from "@/hooks/useMyRole";
import { formatLineItemDescription, invoiceNumberLabel } from "@/lib/invoice-labels";
import { qboRows, splitForImport, type QboInvoice } from "@/lib/quickbooks-import";

// BUILD-13 — building the accountant's pack. Definitions live in
// src/lib/cpa-reports.ts; this file only assembles rows.
//
// Everything is gated on view_financials, the same boundary /reports already
// uses. These sheets are the whole financial position of the business in one
// download, so if anything they deserve a tighter gate than the dashboard —
// never a looser one.

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const reportSchema = rangeSchema.extend({
  reportId: z.string(),
});

export type ReportRow = Record<string, string | number | null>;

export type ReportResult = {
  id: ReportId;
  title: string;
  purpose: string;
  basis: string;
  note?: string;
  columns: ReportColumn[];
  range: { from: string; to: string };
  timezone: string;
  orgName: string;
  rows: ReportRow[];
  /** A totals line, when totalling means anything. A bridge or a status list
   *  has no meaningful sum and gets null rather than a misleading footer. */
  totals: ReportRow | null;
  /** Anything an accountant should know before trusting a figure. These are
   *  printed with the report and carried into the CSV — a caveat that only
   *  exists on screen is a caveat nobody reads. */
  caveats: string[];
  /** Rows only, split into importer-sized files. See ReportDef.importFile. */
  importFile?: boolean;
};

// ── Plumbing ───────────────────────────────────────────────────────────────

// Paging comes from supabase-paging.server.ts — PostgREST's silent 1000-row cap
// is a whole-app hazard, not this file's private problem (BUG-23 was /reports
// hitting it with no guard at all).
//
// Every paged query below orders by `created_at` AND `id`. created_at alone is
// not a total order here: run_billing_cycles inserts a whole billing batch in
// one transaction, so an entire month of invoices — and the payments that
// follow them — share a timestamp to the microsecond. Postgres is free to
// return tied rows in a different order for each page request, so a tie group
// straddling a page boundary can hand back the same invoice twice and drop
// another entirely. The id breaks every tie, which makes the sort total and the
// paging repeatable. A duplicated invoice inflates income; a dropped one hides
// it, and neither leaves a trace on the sheet.

type OrgContext = {
  orgId: string;
  /** Carried so a report needing a tighter gate than view_financials can be
   *  answered without resolving the caller a second time. */
  role: AppRole;
  name: string;
  timezone: string;
  parentOrganizationId: string | null;
  isFranchiseParent: boolean;
  paymentsCollectedByParent: boolean;
  collectsForAnyLocation: boolean;
};

async function loadOrgContext(supabase: any, userId: string): Promise<OrgContext> {
  const { orgId, role } = await requirePermission(supabase, userId, "view_financials");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Service-role, scoped to this one row: the franchise columns are readable
  // under RLS but the CHILD-side rollup below is not, and reading both through
  // one client keeps the two from disagreeing about what this org is.
  const { data: org, error } = await (supabaseAdmin as any)
    .from("organizations")
    .select(
      "id, name, timezone, parent_organization_id, is_franchise_parent, payments_collected_by_parent",
    )
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  let collectsForAnyLocation = false;
  if (org?.is_franchise_parent) {
    const { count } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("parent_organization_id", orgId)
      .eq("payments_collected_by_parent", true);
    collectsForAnyLocation = (count ?? 0) > 0;
  }

  return {
    orgId,
    role,
    name: org?.name ?? "Your business",
    // Falling back to UTC rather than a guess: a wrong timezone silently files
    // year-end payments in the wrong tax year, and UTC at least fails in a
    // direction the org's own settings page explains.
    timezone: org?.timezone || "UTC",
    parentOrganizationId: org?.parent_organization_id ?? null,
    isFranchiseParent: !!org?.is_franchise_parent,
    paymentsCollectedByParent: !!org?.payments_collected_by_parent,
    collectsForAnyLocation,
  };
}

/** UTC bounds wide enough to catch every row whose ORG-LOCAL day falls in the
 *  range. Two days of padding covers every real timezone offset in both
 *  directions; the exact day filter happens in JS against org-local dates. */
function utcWindow(from: string, to: string) {
  const lo = new Date(`${from}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 2);
  const hi = new Date(`${to}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 3);
  return { lo: lo.toISOString(), hi: hi.toISOString() };
}

const inRange = (day: string, from: string, to: string) => !!day && day >= from && day <= to;

// ── Row sources ────────────────────────────────────────────────────────────

type PaymentRow = {
  id: string;
  invoice_id: string;
  amount_cents: number;
  /** Recovered processing fee, beside the amount rather than inside it. Absent
   *  on every payment taken before pass-through existed. */
  surcharge_cents?: number | null;
  /** The customer's tip, beside the amount like the surcharge. Never income
   *  in the sheets that sum `amount_cents`; its own report, and part of the
   *  CHARGE on the 1099-K sheet. */
  tip_cents?: number | null;
  /** The sales-tax share INSIDE amount_cents. Owed to the state: taken out of
   *  every income sheet, reported on its own by Sales tax collected. */
  tax_cents?: number | null;
  status: string;
  paid_at: string | null;
  created_at: string;
  collected_by_organization_id: string | null;
};

/** A payment's income: what it applied to the invoice, less the tax share. */
const incomeOf = (p: { amount_cents?: number | null; tax_cents?: number | null }) =>
  (p.amount_cents ?? 0) - Math.max(0, p.tax_cents ?? 0);

/** Money that actually arrived. Includes 'refunded' on purpose — see the
 *  refunds note at the top of cpa-reports.ts. Excludes 'pending' and 'failed',
 *  which never reached the bank. */
async function loadReceipts(supabase: any, ctx: OrgContext, from: string, to: string) {
  const { lo, hi } = utcWindow(from, to);
  const rows = await fetchAll<PaymentRow>((a, b) =>
    supabase
      .from("payments")
      .select(
        // surcharge_cents and tip_cents: the 1099-K reconciliation sheet needs
        // what STRIPE reported, which is the charge — base + surcharge + tip —
        // not the revenue.
        "id, invoice_id, amount_cents, surcharge_cents, tip_cents, tax_cents, status, paid_at, created_at, collected_by_organization_id",
      )
      .eq("organization_id", ctx.orgId)
      .in("status", ["succeeded", "refunded"])
      .gte("created_at", lo)
      .lte("created_at", hi)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  return rows
    .map((p) => ({ ...p, day: orgLocalDay(p.paid_at ?? p.created_at, ctx.timezone) }))
    .filter((p) => inRange(p.day, from, to));
}

/** Refunds and chargebacks, from the shared reader.
 *
 *  This used to be a private copy of loadOrgReversals — byte-identical query,
 *  same padding, same org-local filter. Two implementations of one rule is
 *  exactly what produced BUG-21, and the copies here and in /reports would have
 *  been the same mistake in a place where it matters more: an owner hands the
 *  tax pack to their accountant and reads /reports over coffee, so the two must
 *  agree by construction rather than by coincidence. */
async function loadReversals(supabase: any, ctx: OrgContext, from: string, to: string) {
  const { loadOrgReversals } = await import("@/lib/reversals.server");
  return loadOrgReversals(supabase, {
    orgId: ctx.orgId,
    timezone: ctx.timezone,
    from,
    to,
  });
}

type InvoiceRow = {
  id: string;
  number: number | null;
  client_id: string;
  status: string;
  total_cents: number | null;
  /** Sales tax inside total_cents, and the rate/label it was made at. */
  tax_cents?: number | null;
  tax_rate_bps?: number | null;
  tax_label?: string | null;
  credit_applied_cents: number | null;
  amount_paid_cents: number | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  due_on: string | null;
  updated_at: string | null;
};

const INVOICE_COLS =
  "id, number, client_id, status, total_cents, tax_cents, tax_rate_bps, tax_label, credit_applied_cents, amount_paid_cents, issued_at, paid_at, voided_at, due_on, updated_at";

/** The whole invoice ledger for this org. The bridge and the aging report both
 *  need point-in-time positions, which cannot be derived from a filtered
 *  window — an invoice issued three years ago and still open is part of today's
 *  receivables. */
async function loadInvoices(supabase: any, ctx: OrgContext) {
  const rows = await fetchAll<InvoiceRow>((a, b) =>
    supabase
      .from("invoices")
      .select(INVOICE_COLS)
      .eq("organization_id", ctx.orgId)
      .neq("status", "draft")
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  // An invoice paid in parts was owed less after each part; the opening and
  // closing receivables need the day each part arrived.
  const { attachDatedPartialPayments } = await import("@/lib/partial-payments.server");
  return attachDatedPartialPayments(supabase, ctx.orgId, rows);
}

async function clientNames(supabase: any, ctx: OrgContext, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await supabase
      .from("clients")
      .select("id, display_name")
      .eq("organization_id", ctx.orgId)
      .in("id", unique.slice(i, i + 200));
    for (const c of data ?? []) map.set(c.id, c.display_name);
  }
  return map;
}

async function buildQuickbooksInvoices(supabase: any, ctx: OrgContext, from: string, to: string) {
  // The same "billed in the period" as the accrual report, so the two agree
  // on which invoices a month holds.
  const billed = (await loadInvoices(supabase, ctx))
    .map((inv) => ({ inv, day: billedDay(inv, ctx.timezone) }))
    .filter((x): x is { inv: InvoiceRow; day: string } => !!x.day && inRange(x.day, from, to))
    .sort((a, b) => a.day.localeCompare(b.day) || (a.inv.number ?? 0) - (b.inv.number ?? 0));

  const names = await clientNames(
    supabase,
    ctx,
    billed.map((x) => x.inv.client_id),
  );
  const linesByInvoice = new Map<string, Array<{ description: string; amountCents: number }>>();
  const ids = billed.map((x) => x.inv.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const lines = await fetchAll<{
      invoice_id: string;
      description: string | null;
      amount_cents: number;
    }>((a, b) =>
      supabase
        .from("invoice_line_items")
        .select("invoice_id, description, amount_cents")
        .in("invoice_id", chunk)
        .order("created_at")
        .order("id")
        .range(a, b),
    );
    for (const l of lines) {
      const list = linesByInvoice.get(l.invoice_id) ?? [];
      list.push({
        description: formatLineItemDescription(l.description),
        amountCents: l.amount_cents,
      });
      linesByInvoice.set(l.invoice_id, list);
    }
  }

  const { taxLineLabel } = await import("@/lib/sales-tax");
  const invoices: QboInvoice[] = billed.map(({ inv, day }) => ({
    invoiceNo: invoiceNumberLabel(inv),
    customer: names.get(inv.client_id) ?? "Unknown client",
    issuedDay: day,
    dueOn: inv.due_on,
    totalCents: inv.total_cents ?? 0,
    // Sales tax travels as its own line, after the service lines, so the
    // lines still add up to the total the customer was billed. Absent on
    // every invoice with no tax, which is every invoice of a business that
    // never set a rate.
    lines: [
      ...(linesByInvoice.get(inv.id) ?? []),
      ...((inv.tax_cents ?? 0) > 0
        ? [{ description: taxLineLabel(inv.tax_label, inv.tax_rate_bps), amountCents: inv.tax_cents ?? 0 }]
        : []),
    ],
  }));
  const { rows, excluded } = qboRows(invoices);
  const files = splitForImport(rows);

  const caveats: string[] = [];
  const imported = invoices.length - excluded.length;
  if (files.length > 1) {
    caveats.push(
      `${imported} invoices, downloaded as ${files.length} files of at most 100 invoices each, because that is the most QuickBooks takes in one import.`,
    );
  }
  for (const e of excluded) {
    caveats.push(
      `${e.invoiceNo} (${e.customer}) is not in the file because ${e.reason}. Enter it in QuickBooks by hand.`,
    );
  }
  caveats.push(
    "Account credit applied to an invoice is not a line, so QuickBooks will show the full invoice as owed. Record the credit as a payment there.",
  );
  if (billed.some(({ inv }) => (inv.tax_cents ?? 0) > 0)) {
    caveats.push(
      "Sales tax is a line of its own on each taxed invoice. When QuickBooks asks what product or service a line is, map that line to your sales-tax liability, not to income.",
    );
  }
  return { rows: rows as unknown as ReportRow[], totals: null, caveats };
}

// ── The reports ────────────────────────────────────────────────────────────

async function buildIncomeCash(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
  ]);

  const byMonth = new Map<string, { gross: number; reversals: Reversal[]; count: number }>();
  for (const m of monthsBetween(from, to)) byMonth.set(m, { gross: 0, reversals: [], count: 0 });
  const bucket = (m: string) => {
    let b = byMonth.get(m);
    if (!b) {
      b = { gross: 0, reversals: [], count: 0 };
      byMonth.set(m, b);
    }
    return b;
  };

  for (const p of receipts) {
    const b = bucket(monthKey(p.day));
    // Income, not tax: the sales-tax share of a payment is owed to the state.
    b.gross += incomeOf(p);
    b.count += 1;
  }
  // Every reversal, recoveries included. Skipping the won disputes here — which
  // is what this loop used to do — deducted the chargeback in the month the
  // funds were pulled and then never put the money back when the dispute was
  // won, so a $1,000 sale that was disputed and successfully defended read as
  // $0 of income forever. totalReversals is the one implementation of
  // "deducted minus recovered"; the register sheet and /reports net it the same
  // way, and three copies of that subtraction is how they would stop agreeing.
  for (const r of reversals) bucket(monthKey(r.day)).reversals.push(r);

  const rows: ReportRow[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, b]) => {
      const net = totalReversals(b.reversals).netCents;
      return {
        month: monthLabel(m),
        grossCents: b.gross,
        refundsCents: net,
        netCents: b.gross - net,
        paymentCount: b.count,
      };
    });

  const totals = rows.reduce(
    (t, r) => ({
      month: "Total",
      grossCents: (t.grossCents as number) + (r.grossCents as number),
      refundsCents: (t.refundsCents as number) + (r.refundsCents as number),
      netCents: (t.netCents as number) + (r.netCents as number),
      paymentCount: (t.paymentCount as number) + (r.paymentCount as number),
    }),
    { month: "Total", grossCents: 0, refundsCents: 0, netCents: 0, paymentCount: 0 } as ReportRow,
  );

  return {
    rows,
    totals,
    caveats: [
      "Stripe's processing fees are deducted before payout and are not recorded in HoundStack, so they do not appear here. They are a deductible expense and come from your Stripe payout statements.",
      "Cash paid directly to you and recorded manually is included, and is not part of any 1099-K.",
      "Tips clients added when paying are not in these figures: they are not payment for the service. They are in the Tips received report, and they are still income to the business (or wages, if you pass them to your team through payroll). A chargeback is deducted here whole, tip included.",
      "Refunds & chargebacks is net of disputes you won: the deduction stands in the month the funds were withdrawn and the recovery is added back in the month they returned. A month can therefore show a negative figure in that column, and a dispute opened in one period and won in the next moves income between the two rather than restating either.",
      // Only said when there is some, so a business with no tax rate gets the
      // sheet it always got.
      ...(receipts.some((p) => (p.tax_cents ?? 0) > 0)
        ? [
            "Sales tax collected with these payments is not in these figures: it is owed to the state, not earned. It is in the Sales tax collected report, and the part of a refund or chargeback that was tax is deducted there rather than here.",
          ]
        : []),
    ],
  };
}

/**
 * Tips received and refunded, by month.
 *
 * Received: `payments.tip_cents` on every payment that arrived in the period
 * (the same receipts, same statuses and same org-local dating as the income
 * sheet). Refunded: each refund's tip share, divided by `splitRefund` exactly
 * as the webhook divided it when it filed the revenue share, from Stripe's
 * cumulative refunded figure on the reversal row and the payment's own split.
 * Chargebacks are not deducted here: the income sheet deducts them whole.
 */
async function buildTipsReceived(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
  ]);

  const refunds = reversals.filter((r) => r.kind === "payment_refunded" && r.paymentId);
  const paymentIds = [...new Set(refunds.map((r) => r.paymentId as string))];
  const split = new Map<string, { amount: number; surcharge: number; tip: number }>();
  for (let i = 0; i < paymentIds.length; i += 200) {
    const { data } = await supabase
      .from("payments")
      .select("id, amount_cents, surcharge_cents, tip_cents")
      .eq("organization_id", ctx.orgId)
      .in("id", paymentIds.slice(i, i + 200));
    for (const p of data ?? []) {
      split.set(p.id, {
        amount: Number(p.amount_cents ?? 0),
        surcharge: Number(p.surcharge_cents ?? 0),
        tip: Number(p.tip_cents ?? 0),
      });
    }
  }
  const { splitRefund } = await import("@/lib/refund-split");
  const tipRefunds = refunds.map((r) => {
    const p = split.get(r.paymentId as string);
    if (!p || p.tip <= 0) return { day: r.day, tipCents: 0 };
    return {
      day: r.day,
      tipCents: splitRefund(r.movedCents, p.amount + p.surcharge + p.tip, p.surcharge, p.tip)
        .tipCents,
    };
  });

  const rows: ReportRow[] = tipsByMonth(
    monthsBetween(from, to),
    receipts.map((p) => ({ day: p.day, tipCents: Number(p.tip_cents ?? 0) })),
    tipRefunds,
  ).map((r) => ({ ...r, month: monthLabel(r.month) }));

  const totals = rows.reduce(
    (t, r) => ({
      month: "Total",
      tipsCents: (t.tipsCents as number) + (r.tipsCents as number),
      tipsRefundedCents: (t.tipsRefundedCents as number) + (r.tipsRefundedCents as number),
      netTipsCents: (t.netTipsCents as number) + (r.netTipsCents as number),
      tippedPaymentCount: (t.tippedPaymentCount as number) + (r.tippedPaymentCount as number),
    }),
    {
      month: "Total",
      tipsCents: 0,
      tipsRefundedCents: 0,
      netTipsCents: 0,
      tippedPaymentCount: 0,
    } as ReportRow,
  );

  return {
    rows,
    totals,
    caveats: [
      "Tips are income to the business when it keeps them. Tips paid on to technicians are wages, and go through payroll; Timesheets shows each technician's tips for the week and includes them in its CSV.",
      "A tip is credited to the technician on the most recent completed visit on its invoice. A tip on an invoice with no completed visit is counted here and credited to no one.",
      "Stripe includes tips in gross card volume, so they are part of the 1099-K reconciliation sheet's gross.",
    ],
  };
}

/**
 * Sales tax billed and collected, by month.
 *
 * Billed: `invoices.tax_cents` on every invoice billed in the period, by the
 * same `billedDay` rule as the accrual income sheet. Collected:
 * `payments.tax_cents` — each payment's pro-rata share of its invoice's tax,
 * written by the database — on the same receipts and dating as the cash income
 * sheet. Refunded: each reversal's tax share, divided by `splitRefund` exactly
 * as the webhook divided it when it took the tax back out of the revenue it
 * filed. A refund splits the charge (base, surcharge, tip, then base into
 * revenue and tax); a chargeback takes the whole charge as its base, as the
 * webhook does; a won dispute puts its share back.
 */
async function buildSalesTaxCollected(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals, invoices] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
    loadInvoices(supabase, ctx),
  ]);

  const paymentIds = [...new Set(reversals.map((r) => r.paymentId).filter(Boolean))] as string[];
  const split = new Map<string, { amount: number; surcharge: number; tip: number; tax: number }>();
  for (let i = 0; i < paymentIds.length; i += 200) {
    const { data } = await supabase
      .from("payments")
      .select("id, amount_cents, surcharge_cents, tip_cents, tax_cents")
      .eq("organization_id", ctx.orgId)
      .in("id", paymentIds.slice(i, i + 200));
    for (const p of data ?? []) {
      split.set(p.id, {
        amount: Number(p.amount_cents ?? 0),
        surcharge: Number(p.surcharge_cents ?? 0),
        tip: Number(p.tip_cents ?? 0),
        tax: Number(p.tax_cents ?? 0),
      });
    }
  }
  const { splitRefund } = await import("@/lib/refund-split");
  const taxReversals = reversals.map((r) => {
    const p = split.get(r.paymentId ?? "");
    if (!p || p.tax <= 0) return { day: r.day, taxCents: 0 };
    const charge = p.amount + p.surcharge + p.tip;
    const share =
      r.kind === "payment_refunded"
        ? splitRefund(r.movedCents, charge, p.surcharge, p.tip, p.tax).taxCents
        : splitRefund(r.movedCents, charge, 0, 0, p.tax).taxCents;
    return { day: r.day, taxCents: r.deducts ? share : -share };
  });

  const billed = invoices
    .map((inv) => ({ day: billedDay(inv, ctx.timezone), taxCents: inv.tax_cents ?? 0 }))
    .filter((x): x is { day: string; taxCents: number } => !!x.day && inRange(x.day, from, to));

  const rows: ReportRow[] = salesTaxByMonth(
    monthsBetween(from, to),
    billed,
    receipts.map((p) => ({ day: p.day, taxCents: Number(p.tax_cents ?? 0) })),
    taxReversals,
  ).map((r) => ({ ...r, month: monthLabel(r.month) }));

  const totals = rows.reduce(
    (t, r) => ({
      month: "Total",
      taxBilledCents: (t.taxBilledCents as number) + (r.taxBilledCents as number),
      taxCollectedCents: (t.taxCollectedCents as number) + (r.taxCollectedCents as number),
      taxRefundedCents: (t.taxRefundedCents as number) + (r.taxRefundedCents as number),
      netTaxCollectedCents: (t.netTaxCollectedCents as number) + (r.netTaxCollectedCents as number),
      taxedPaymentCount: (t.taxedPaymentCount as number) + (r.taxedPaymentCount as number),
    }),
    {
      month: "Total",
      taxBilledCents: 0,
      taxCollectedCents: 0,
      taxRefundedCents: 0,
      netTaxCollectedCents: 0,
      taxedPaymentCount: 0,
    } as ReportRow,
  );

  const { data: org } = await supabase
    .from("organizations")
    .select("sales_tax_rate_bps")
    .eq("id", ctx.orgId)
    .maybeSingle();
  const rateBps = Number((org as { sales_tax_rate_bps?: number | null } | null)?.sales_tax_rate_bps ?? 0);
  const { formatTaxRate } = await import("@/lib/sales-tax");
  return {
    rows,
    totals,
    caveats: [
      rateBps > 0
        ? `New invoices are taxed at ${formatTaxRate(rateBps)} (Settings, Invoicing). Each invoice keeps the rate it was made at, and clients marked tax-exempt are charged none.`
        : "No sales tax rate is set (Settings, Invoicing), so new invoices carry no tax. Most pet-waste services are not taxable; some states do tax them. Your accountant can tell you whether yours does.",
      "Tax is charged on each invoice's whole subtotal and rounded once, to the nearest cent. Imported opening balances and DNA-match fines carry no tax.",
      "This report is what HoundStack billed and collected. It is not a return: the rate, what is taxable, and where it is owed are for you and your accountant to confirm.",
    ],
  };
}

async function buildIncomeAccrual(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const byMonth = new Map<string, { invoiced: number; credits: number; count: number }>();
  for (const m of monthsBetween(from, to)) byMonth.set(m, { invoiced: 0, credits: 0, count: 0 });
  let anyTax = false;

  for (const inv of invoices) {
    // Shared with /reports: one definition of what "billed in a period" means.
    const day = billedDay(inv, ctx.timezone);
    if (!day || !inRange(day, from, to)) continue;
    const m = monthKey(day);
    let b = byMonth.get(m);
    if (!b) {
      b = { invoiced: 0, credits: 0, count: 0 };
      byMonth.set(m, b);
    }
    // Billed revenue excludes the invoice's sales tax, which is a liability.
    b.invoiced += (inv.total_cents ?? 0) - Math.max(0, inv.tax_cents ?? 0);
    b.credits += inv.credit_applied_cents ?? 0;
    b.count += 1;
    if ((inv.tax_cents ?? 0) > 0) anyTax = true;
  }

  const rows: ReportRow[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, b]) => ({
      month: monthLabel(m),
      invoicedCents: b.invoiced,
      creditsAppliedCents: b.credits,
      netCents: b.invoiced - b.credits,
      invoiceCount: b.count,
    }));

  const totals = rows.reduce(
    (t, r) => ({
      month: "Total",
      invoicedCents: (t.invoicedCents as number) + (r.invoicedCents as number),
      creditsAppliedCents: (t.creditsAppliedCents as number) + (r.creditsAppliedCents as number),
      netCents: (t.netCents as number) + (r.netCents as number),
      invoiceCount: (t.invoiceCount as number) + (r.invoiceCount as number),
    }),
    {
      month: "Total",
      invoicedCents: 0,
      creditsAppliedCents: 0,
      netCents: 0,
      invoiceCount: 0,
    } as ReportRow,
  );

  return {
    rows,
    totals,
    caveats: [
      "Credit applied is shown against the month the invoice was issued, which is where the credit reduced what was billed.",
      "A prepaid top-up is billed when it is sold, not when the service is delivered. If you file accrual basis, unused prepaid balances are a liability and your accountant may need to defer part of this figure.",
      ...(anyTax
        ? [
            "Invoiced excludes the sales tax on those invoices, which is owed to the state; it is the Tax billed column of the Sales tax collected report. Credit applied reduces what the client owed, not the tax, so it is shown here whole.",
          ]
        : []),
    ],
  };
}

async function buildBridge(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const tz = ctx.timezone;
  const opening = previousDay(from);

  let openingAr = 0;
  let closingAr = 0;
  let invoiced = 0;
  let creditsApplied = 0;
  let writtenOff = 0;

  for (const inv of invoices) {
    openingAr += outstandingAsOf(inv, opening, tz);
    closingAr += outstandingAsOf(inv, to, tz);

    const issued = inv.issued_at ? orgLocalDay(inv.issued_at, tz) : null;
    const issuedThisPeriod = !!issued && inRange(issued, from, to);
    const billed = issuedThisPeriod && inv.status !== "void";
    if (billed) {
      invoiced += inv.total_cents ?? 0;
      creditsApplied += inv.credit_applied_cents ?? 0;
    }
    const voided = inv.voided_at ? orgLocalDay(inv.voided_at, tz) : null;
    if (voided && inRange(voided, from, to)) {
      // Only what receivables were actually CARRYING can be taken back out of
      // them, and only if it was ever put in.
      //
      // An invoice issued and voided inside the same period never reached the
      // "invoiced" line above — a void is not billed revenue — so writing it
      // off as well subtracted it a second time and printed a "Difference to
      // investigate" on a period that ties exactly. And for one issued earlier,
      // opening receivables carried it NET of any credit applied, so deducting
      // the gross total left the bridge out by exactly that credit.
      //
      // Asking outstandingAsOf for the day before the void answers both, and
      // the day the invoice was already paid off before being voided as well:
      // it is the same function that produced the opening figure, so the two
      // sides cannot drift apart.
      if (!issuedThisPeriod) writtenOff += outstandingAsOf(inv, previousDay(voided), tz);
    } else if (inv.status === "uncollectible") {
      const off = inv.updated_at ? orgLocalDay(inv.updated_at, tz) : null;
      if (off && inRange(off, from, to)) {
        // What was still owed when it was written off: net of credit and of
        // any part already paid.
        writtenOff += invoiceDueCents(inv);
      }
    }
  }

  const receipts = await loadReceipts(supabase, ctx, from, to);
  const collected = receipts.reduce((s, p) => s + (p.amount_cents ?? 0), 0);

  const expectedClosing = openingAr + invoiced - creditsApplied - collected - writtenOff;
  const unexplained = closingAr - expectedClosing;

  const rows: ReportRow[] = [
    { line: `Opening receivables at ${opening}`, amountCents: openingAr },
    { line: "Plus: invoiced during the period", amountCents: invoiced },
    { line: "Less: credits applied", amountCents: -creditsApplied },
    { line: "Less: payments collected", amountCents: -collected },
    { line: "Less: written off or voided", amountCents: -writtenOff },
    { line: "Expected closing receivables", amountCents: expectedClosing },
    { line: `Actual closing receivables at ${to}`, amountCents: closingAr },
    { line: "Difference to investigate", amountCents: unexplained },
  ];

  return {
    rows,
    totals: null,
    caveats:
      unexplained === 0
        ? [
            "The bridge ties exactly. Closing receivables are fully explained by the period's activity.",
          ]
        : [
            `The bridge is out by ${(unexplained / 100).toFixed(2)}. That normally means a payment was recorded against an invoice issued outside this period, or an invoice was edited after it was issued. Worth identifying before the return is filed rather than after.`,
          ],
  };
}

async function buildRevenueByClient(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals, invoices] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
    loadInvoices(supabase, ctx),
  ]);
  const invoiceClient = new Map(invoices.map((i) => [i.id, i.client_id]));
  const paymentClient = new Map(receipts.map((p) => [p.id, invoiceClient.get(p.invoice_id) ?? ""]));

  const acc = new Map<string, { gross: number; reversals: Reversal[]; count: number }>();
  const at = (cid: string) => {
    let b = acc.get(cid);
    if (!b) {
      b = { gross: 0, reversals: [], count: 0 };
      acc.set(cid, b);
    }
    return b;
  };
  for (const p of receipts) {
    const b = at(paymentClient.get(p.id) ?? "");
    b.gross += incomeOf(p);
    b.count += 1;
  }
  // Recoveries as well as deductions — a customer whose disputed payment was
  // defended must not be left showing zero income for a sale they never got
  // their money back on. The reversal's subject is the payment; the payment may
  // pre-date the window, so fall back to the invoice ledger rather than
  // dropping it.
  for (const r of reversals) at(paymentClient.get(r.paymentId ?? "") ?? "").reversals.push(r);

  const names = await clientNames(supabase, ctx, [...acc.keys()]);
  const rows: ReportRow[] = [...acc.entries()]
    .map(([cid, b]) => {
      const net = totalReversals(b.reversals).netCents;
      return {
        clientName: names.get(cid) ?? "Unattributed",
        grossCents: b.gross,
        refundsCents: net,
        netCents: b.gross - net,
        paymentCount: b.count,
      };
    })
    .sort((a, b) => (b.netCents as number) - (a.netCents as number));

  const totals = rows.reduce(
    (t, r) => ({
      clientName: "Total",
      grossCents: (t.grossCents as number) + (r.grossCents as number),
      refundsCents: (t.refundsCents as number) + (r.refundsCents as number),
      netCents: (t.netCents as number) + (r.netCents as number),
      paymentCount: (t.paymentCount as number) + (r.paymentCount as number),
    }),
    {
      clientName: "Total",
      grossCents: 0,
      refundsCents: 0,
      netCents: 0,
      paymentCount: 0,
    } as ReportRow,
  );

  return {
    rows,
    totals,
    caveats: [
      '"Unattributed" covers refunds against payments taken before this period, where the original client is outside the window being reported.',
      "Refunds is net of any dispute won in this period, so a client whose chargeback you successfully defended can show a negative figure in that column.",
    ],
  };
}

async function buildAging(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const tz = ctx.timezone;
  const acc = new Map<string, Record<string, number>>();

  for (const inv of invoices) {
    const owed = outstandingAsOf(inv, to, tz);
    if (owed <= 0) continue;
    const due = inv.due_on ?? null;
    const issued = inv.issued_at ? orgLocalDay(inv.issued_at, tz) : null;
    const b = agingBucket(due, issued, to);
    const row = acc.get(inv.client_id) ?? { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    row[b] += owed;
    acc.set(inv.client_id, row);
  }

  const names = await clientNames(supabase, ctx, [...acc.keys()]);
  const rows: ReportRow[] = [...acc.entries()]
    .map(([cid, b]) => ({
      clientName: names.get(cid) ?? "-",
      currentCents: b.current,
      d30Cents: b.d30,
      d60Cents: b.d60,
      d90Cents: b.d90,
      d90PlusCents: b.d90plus,
      totalCents: b.current + b.d30 + b.d60 + b.d90 + b.d90plus,
    }))
    .sort((a, b) => (b.totalCents as number) - (a.totalCents as number));

  const totals = rows.reduce(
    (t, r) => {
      const out = { ...t } as ReportRow;
      for (const k of [
        "currentCents",
        "d30Cents",
        "d60Cents",
        "d90Cents",
        "d90PlusCents",
        "totalCents",
      ]) {
        out[k] = (t[k] as number) + (r[k] as number);
      }
      out.clientName = "Total";
      return out;
    },
    {
      clientName: "Total",
      currentCents: 0,
      d30Cents: 0,
      d60Cents: 0,
      d90Cents: 0,
      d90PlusCents: 0,
      totalCents: 0,
    } as ReportRow,
  );

  return {
    rows,
    totals,
    caveats: [
      `Aged as at ${to}, from each invoice's due date. The "from" date on this screen does not affect an aging report, because a receivables position is a point in time, not a range.`,
    ],
  };
}

async function buildReversals(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [reversals, invoices] = await Promise.all([
    loadReversals(supabase, ctx, from, to),
    loadInvoices(supabase, ctx),
  ]);
  // The reversal points at a payment; the payment may be older than the window,
  // so resolve the customer through the full payment ledger rather than the
  // period's receipts.
  const ids = reversals.map((r) => r.paymentId).filter(Boolean) as string[];
  const payMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from("payments")
      .select("id, invoice_id")
      .eq("organization_id", ctx.orgId)
      .in("id", ids.slice(i, i + 200));
    for (const p of data ?? []) payMap.set(p.id, p.invoice_id);
  }
  const invoiceClient = new Map(invoices.map((i) => [i.id, i.client_id]));
  const names = await clientNames(
    supabase,
    ctx,
    [...payMap.values()].map((iid) => invoiceClient.get(iid) ?? ""),
  );

  const rows: ReportRow[] = reversals
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => {
      const label = reversalLabel(r.kind);
      const cid = invoiceClient.get(payMap.get(r.paymentId ?? "") ?? "") ?? "";
      return {
        occurredAt: r.day,
        kindLabel: label.type,
        clientName: names.get(cid) ?? "-",
        // A recovery is shown as a positive return of money; deductions are the
        // ones that carry to the income sheet.
        amountCents: reducesIncome(r.kind) ? -r.amountCents : r.amountCents,
        statusLabel: label.outcome,
      };
    });

  const deducted = reversals
    .filter((r) => reducesIncome(r.kind))
    .reduce((s, r) => s + r.amountCents, 0);
  const recovered = reversals
    .filter((r) => !reducesIncome(r.kind))
    .reduce((s, r) => s + r.amountCents, 0);

  return {
    rows,
    totals: {
      occurredAt: "Total",
      kindLabel: "",
      clientName: "",
      amountCents: recovered - deducted,
      statusLabel: `${(deducted / 100).toFixed(2)} deducted, ${(recovered / 100).toFixed(2)} recovered`,
    } as ReportRow,
    caveats: [
      "A payment refunded in parts is listed once, at the cumulative total refunded to date, not as one line per refund. The individual refunds are in Stripe if a return needs them itemised.",
      "An open dispute is deducted from the day the funds were withdrawn. If it is later won, the recovery appears on that date rather than by amending the original month.",
    ],
  };
}

async function buildWriteOffs(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const tz = ctx.timezone;
  const hits: Array<{ inv: InvoiceRow; day: string; label: string; amount: number }> = [];

  for (const inv of invoices) {
    const voided = inv.voided_at ? orgLocalDay(inv.voided_at, tz) : null;
    if (voided && inRange(voided, from, to)) {
      hits.push({ inv, day: voided, label: "Voided", amount: inv.total_cents ?? 0 });
      continue;
    }
    if (inv.status === "uncollectible") {
      const off = inv.updated_at ? orgLocalDay(inv.updated_at, tz) : null;
      if (off && inRange(off, from, to)) {
        hits.push({
          inv,
          day: off,
          label: "Written off as uncollectible",
          amount: invoiceDueCents(inv),
        });
      }
    }
  }

  const names = await clientNames(
    supabase,
    ctx,
    hits.map((h) => h.inv.client_id),
  );
  const rows: ReportRow[] = hits
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((h) => ({
      dateOn: h.day,
      clientName: names.get(h.inv.client_id) ?? "-",
      statusLabel: h.label,
      amountCents: h.amount,
      reference: invoiceNumberLabel(h.inv),
    }));

  return {
    rows,
    totals: {
      dateOn: "Total",
      clientName: "",
      statusLabel: "",
      amountCents: rows.reduce((s, r) => s + (r.amountCents as number), 0),
      reference: "",
    } as ReportRow,
    caveats: [
      "An uncollectible invoice is dated by when its record last changed, which is the closest thing to a write-off date the app stores. If exact timing matters for a bad-debt deduction, confirm it against your own records.",
      "Voiding an invoice is not the same as writing off a debt. A void generally means it should never have been issued; only your accountant can say which treatment applies.",
    ],
  };
}

/** Card volume this organization collected on behalf of its LOCATIONS.
 *
 *  These payments belong to the location's rows — payments.organization_id is
 *  the location — but the charge landed in this org's Stripe account, so Stripe
 *  puts it on THIS org's 1099-K and on nobody else's. Reading only
 *  organization_id showed a collecting franchise its own volume beside a 1099-K
 *  several times larger, which is precisely the difference this sheet promises
 *  to explain and could not.
 *
 *  Service-role because a franchise is not a member of its locations. Scoped to
 *  collected_by_organization_id = this org, so it can select nothing but money
 *  that went through this org's own processing account. */
async function loadCollectedForLocations(ctx: OrgContext, from: string, to: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { lo, hi } = utcWindow(from, to);
  const rows = await fetchAll<PaymentRow>((a, b) =>
    (supabaseAdmin as any)
      .from("payments")
      .select(
        // surcharge_cents and tip_cents: the 1099-K reconciliation sheet needs
        // what STRIPE reported, which is the charge — base + surcharge + tip.
        "id, invoice_id, amount_cents, surcharge_cents, tip_cents, status, paid_at, created_at, collected_by_organization_id",
      )
      .eq("collected_by_organization_id", ctx.orgId)
      .neq("organization_id", ctx.orgId)
      .in("status", ["succeeded", "refunded"])
      .gte("created_at", lo)
      .lte("created_at", hi)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  // Dated in the collecting org's timezone, because it is the collecting org's
  // 1099-K the sheet is being reconciled against.
  return rows
    .map((p) => ({ ...p, day: orgLocalDay(p.paid_at ?? p.created_at, ctx.timezone) }))
    .filter((p) => inRange(p.day, from, to));
}

async function build1099k(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals, onBehalf] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
    ctx.collectsForAnyLocation
      ? loadCollectedForLocations(ctx, from, to)
      : Promise.resolve([] as Awaited<ReturnType<typeof loadCollectedForLocations>>),
  ]);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const acc = new Map<string, { gross: number; reversals: Reversal[]; count: number }>();
  const at = (key: string) => {
    let b = acc.get(key);
    if (!b) {
      b = { gross: 0, reversals: [], count: 0 };
      acc.set(key, b);
    }
    return b;
  };
  const collectorOf = new Map<string, string>();
  for (const p of receipts) {
    const key = p.collected_by_organization_id ?? ctx.orgId;
    collectorOf.set(p.id, key);
    const b = at(key);
    // Stripe reports the CHARGE on a 1099-K, and a pass-through charge is
    // base + surcharge. `payments.amount_cents` is base only — the surcharge
    // sits beside it in `surcharge_cents` precisely so it is never counted as
    // revenue. On this ONE sheet that is wrong: its entire purpose is to
    // reconcile against the form, so it has to show the number Stripe put on
    // it. 400 charges of $100 + $3 left $1,200 unexplained, in the direction
    // the sheet's own caveats said was impossible.
    //
    // A tip is inside the same charge and on the same form, for the same
    // reason: Stripe reports what was charged, not what was invoiced.
    b.gross += (p.amount_cents ?? 0) + (p.surcharge_cents ?? 0) + (p.tip_cents ?? 0);
    b.count += 1;
  }
  // One row per COLLECTING account, which is what a 1099-K is issued against —
  // so volume this org collected for its locations joins this org's own row
  // rather than becoming a separate line for a form nobody will receive.
  let onBehalfGross = 0;
  for (const p of onBehalf) {
    const b = at(ctx.orgId);
    // Same reasoning as above: what Stripe reported, not what was revenue.
    const chargedCents = (p.amount_cents ?? 0) + (p.surcharge_cents ?? 0) + (p.tip_cents ?? 0);
    b.gross += chargedCents;
    b.count += 1;
    onBehalfGross += chargedCents;
  }
  // Recoveries add back — see buildIncomeCash. A won dispute that stayed
  // deducted here would leave this sheet unable to tie to the income report it
  // exists to explain.
  for (const r of reversals) at(collectorOf.get(r.paymentId ?? "") ?? ctx.orgId).reversals.push(r);

  // Name the collecting organizations. Service-role and scoped to the exact
  // ids that appear on this org's own payments — nothing is enumerable.
  const otherIds = [...acc.keys()].filter((k) => k !== ctx.orgId);
  const orgNames = new Map<string, string>();
  if (otherIds.length) {
    const { data } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name")
      .in("id", otherIds);
    for (const o of data ?? []) orgNames.set(o.id, o.name);
  }

  const rows: ReportRow[] = [...acc.entries()]
    .map(([key, b]) => {
      const net = totalReversals(b.reversals).netCents;
      return {
        collectedBy:
          key === ctx.orgId
            ? onBehalfGross > 0
              ? `${ctx.name} (your own Stripe account, including what you collected for your locations)`
              : `${ctx.name} (your own Stripe account)`
            : `${orgNames.get(key) ?? "Another organization"} (collected on your behalf)`,
        grossCents: b.gross,
        refundsCents: net,
        netCents: b.gross - net,
        paymentCount: b.count,
      };
    })
    .sort((a, b) => (b.grossCents as number) - (a.grossCents as number));

  const guidance = stripe1099kGuidance(
    routingAudience({
      parentOrganizationId: ctx.parentOrganizationId,
      isFranchiseParent: ctx.isFranchiseParent,
      paymentsCollectedByParent: ctx.paymentsCollectedByParent,
      collectsForAnyLocation: ctx.collectsForAnyLocation,
    }),
  );

  return {
    rows,
    totals: rows.reduce(
      (t, r) => ({
        collectedBy: "Total",
        grossCents: (t.grossCents as number) + (r.grossCents as number),
        refundsCents: (t.refundsCents as number) + (r.refundsCents as number),
        netCents: (t.netCents as number) + (r.netCents as number),
        paymentCount: (t.paymentCount as number) + (r.paymentCount as number),
      }),
      {
        collectedBy: "Total",
        grossCents: 0,
        refundsCents: 0,
        netCents: 0,
        paymentCount: 0,
      } as ReportRow,
    ),
    caveats: [
      guidance.headline,
      ...guidance.points,
      ...(onBehalfGross > 0
        ? [
            `Of the gross above, ${(onBehalfGross / 100).toFixed(2)} was collected in your Stripe account on behalf of your locations. It is on your 1099-K because the charge landed in your account, but it is not your income, and what you passed on is supported by the settlement statements.`,
            "Refunds and chargebacks against that location volume are recorded on the location's own books, so they are not deducted in the row above. Take those from the location's own reversals register when reconciling the 1099-K line by line.",
          ]
        : []),
    ],
  };
}

async function buildFranchiseSettlements(ctx: OrgContext, from: string, to: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Service-role: a location is not a member of its franchise and vice versa,
  // so neither side can read a shared settlement row under RLS. Scoped to rows
  // this organization is a named party to — which is the whole point of the
  // report, since a settlement always has exactly two parties.
  const asParent = ctx.isFranchiseParent;
  const { data, error } = await (supabaseAdmin as any)
    .from("franchise_royalty_invoices")
    .select(
      "id, parent_organization_id, child_organization_id, period_start, period_end, revenue_cents, royalty_cents, adjustments_applied_cents, direction, net_due_cents, status",
    )
    .or(`parent_organization_id.eq.${ctx.orgId},child_organization_id.eq.${ctx.orgId}`)
    .lte("period_start", to)
    // Strictly greater: period_end is the first day of the NEXT period, not the
    // last of this one — see settlementOverlapsPeriod. With `gte`, December
    // 2025 (2025-12-01 → 2026-01-01) landed in the 2025 pack and the 2026 pack,
    // and its royalty was income in two tax years at once.
    .gt("period_end", from)
    .order("period_start");
  if (error) throw new Error(error.message);

  // The same rule again in JS, so the sheet cannot disagree with the query it
  // was built from if either is ever edited alone.
  const settlements = (data ?? []).filter((r: any) =>
    settlementOverlapsPeriod(r.period_start, r.period_end, from, to),
  );

  const counterpartyIds = [
    ...new Set(
      settlements.map((r: any) =>
        r.parent_organization_id === ctx.orgId ? r.child_organization_id : r.parent_organization_id,
      ),
    ),
  ];
  const names = new Map<string, string>();
  if (counterpartyIds.length) {
    const { data: orgs } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name")
      .in("id", counterpartyIds);
    for (const o of orgs ?? []) names.set(o.id, o.name);
  }

  // These labels used to be defined here, and here was the only place in the
  // product that read `direction` at all — the /franchise screen with the Issue
  // button on it showed the royalty and never said which way the money went.
  // The vocabulary now lives in franchise-settlement.ts and all three surfaces
  // read it from there.
  const audience: SettlementAudience = asParent ? "franchise" : "location";

  const rows: ReportRow[] = settlements.map((r: any) => ({
    counterparty:
      names.get(
        r.parent_organization_id === ctx.orgId ? r.child_organization_id : r.parent_organization_id,
      ) ?? "-",
    periodStart: r.period_start,
    periodEnd: r.period_end,
    revenueCents: r.revenue_cents ?? 0,
    royaltyCents: r.royalty_cents ?? 0,
    adjustmentsCents: r.adjustments_applied_cents ?? 0,
    directionLabel: settlementDirectionLabel(r.direction, audience),
    netDueCents: r.net_due_cents ?? 0,
    statusLabel: settlementStatusLabel(r.status),
  }));

  return {
    rows,
    totals: {
      counterparty: "Total",
      periodStart: "",
      periodEnd: "",
      revenueCents: rows.reduce((s, r) => s + (r.revenueCents as number), 0),
      royaltyCents: rows.reduce((s, r) => s + (r.royaltyCents as number), 0),
      adjustmentsCents: rows.reduce((s, r) => s + (r.adjustmentsCents as number), 0),
      directionLabel: "",
      netDueCents: 0,
      statusLabel: "",
    } as ReportRow,
    caveats: [
      "Net amounts are not totalled, because they run in both directions and a sum of them would be meaningless.",
      asParent
        ? "Royalty you collect is ordinary income. What you pass back to a location on a settlement is not your income and should not appear as such."
        : "Royalty is a deductible business expense. These statements are the support for that deduction.",
      "Settlements overlapping the period are included, so a period boundary that cuts through a settlement still shows the whole statement rather than a slice of it.",
      'The period end shown is EXCLUSIVE: it is the first day of the next period, so a December statement reads "2026-01-01". A statement is counted in the year its period runs in, not the year its end date falls in.',
    ],
  };
}

async function buildReferralRewards(supabase: any, ctx: OrgContext, from: string, to: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("tenant_referrals")
    .select(
      "id, referred_org_id, status, reward_cents, converted_at, eligible_at, paid_at, flagged",
    )
    .eq("referrer_org_id", ctx.orgId)
    .order("created_at");
  if (error) throw new Error(error.message);

  const ids = [...new Set((data ?? []).map((r: any) => r.referred_org_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: orgs } = await (supabaseAdmin as any)
      .from("organizations")
      .select("id, name")
      .in("id", ids);
    for (const o of orgs ?? []) names.set(o.id, o.name);
  }

  const tz = ctx.timezone;
  const rows: ReportRow[] = (data ?? [])
    // Everything paid in the period, plus anything still outstanding, so the
    // sheet answers both "what was income" and "what is still owed to me".
    .filter((r: any) => {
      const paidDay = r.paid_at ? orgLocalDay(r.paid_at, tz) : "";
      return paidDay ? inRange(paidDay, from, to) : true;
    })
    .map((r: any) => {
      const paidDay = r.paid_at ? orgLocalDay(r.paid_at, tz) : "";
      return {
        referredName: names.get(r.referred_org_id) ?? "-",
        convertedAt: r.converted_at ? orgLocalDay(r.converted_at, tz) : "",
        rewardCents: r.reward_cents ?? 0,
        eligibleAt: r.eligible_at ? orgLocalDay(r.eligible_at, tz) : "",
        paidAt: paidDay,
        statusLabel: r.flagged
          ? "Under review"
          : paidDay
            ? "Paid"
            : r.eligible_at
              ? "Earned, awaiting payout"
              : "Pending",
      } as ReportRow;
    });

  const paidTotal = rows
    .filter((r) => !!r.paidAt)
    .reduce((s, r) => s + (r.rewardCents as number), 0);

  return {
    rows,
    totals: {
      referredName: "Paid in this period",
      convertedAt: "",
      rewardCents: paidTotal,
      eligibleAt: "",
      paidAt: "",
      statusLabel: "",
    } as ReportRow,
    caveats: [
      "Only rewards with a paid date are income in this period. Earned-but-unpaid rows are listed so the balance is visible, not because they are taxable yet.",
      "Referral rewards are paid manually today, so a reward marked paid here should be matched against your bank before it is relied on.",
    ],
  };
}

/** Expenses by category, by month. `spent_on` is already a day on the org's
 *  calendar (a DATE, chosen on the org's today), so the window is exact and
 *  needs none of the UTC padding the timestamp reports do. Read as the caller:
 *  the expenses policy gives view_financials the whole organization, which is
 *  the same gate this pack already sits behind. */
async function buildExpensesByCategory(supabase: any, ctx: OrgContext, from: string, to: string) {
  const { expensesByCategoryByMonth, expenseReportRow, expenseReportTotals } = await import(
    "@/lib/expenses"
  );
  const rows = await fetchAll<{ id: string; spent_on: string; category: string; amount_cents: number }>(
    (a, b) =>
      supabase
        .from("expenses")
        .select("id, spent_on, category, amount_cents")
        .eq("organization_id", ctx.orgId)
        .gte("spent_on", from)
        .lte("spent_on", to)
        .order("spent_on")
        .order("id")
        .range(a, b),
  );
  const months = expensesByCategoryByMonth(rows, from, to, monthsBetween(from, to));
  const mileageMonths = months.filter((m) => m.byCategory.mileage > 0).length;
  return {
    rows: months.map((m) => expenseReportRow(m, monthLabel(m.month)) as ReportRow),
    totals: expenseReportTotals(months) as ReportRow,
    caveats: [
      "These are the expenses logged in HoundStack by the office and by the team from the field. Anything paid and never logged here is not in this sheet.",
      "Stripe's processing fees and payroll are not tracked here; take them from your Stripe payout statements and your payroll provider.",
      ...(mileageMonths > 0
        ? [
            "Mileage is priced at the rate stored on each trip when it was logged. If you claim actual vehicle costs instead of the standard rate, use the fuel and vehicle-maintenance columns and leave mileage out, or the other way round; not both for the same vehicle.",
          ]
        : []),
    ],
  };
}

// ── Public surface ─────────────────────────────────────────────────────────

export type TaxReportIndex = {
  orgName: string;
  timezone: string;
  inFranchise: boolean;
  routing: Guidance & { audience: string };
  reports: Array<{ id: ReportId; title: string; purpose: string; basis: string }>;
  /** Things this pack deliberately cannot produce. Saying so beats an
   *  accountant hunting for a sheet that was never going to exist. */
  gaps: string[];
};

export const getTaxReportIndex = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TaxReportIndex> => {
    const ctx = await loadOrgContext(context.supabase, context.userId);
    const inFranchise = ctx.isFranchiseParent || !!ctx.parentOrganizationId;
    // The settlements sheet needs what /franchise needs, so it is offered only
    // to a caller who would actually be served it. Answered from the matrices
    // rather than by calling the throwing gate, because the rest of the pack
    // must still list for an office_manager — the index says what you can have,
    // getTaxReport is what says no.
    const { planTierForOrg } = await import("@/lib/entitlements.server");
    const canSeeSettlements =
      inFranchise && mayViewFranchiseSettlements(ctx.role, await planTierForOrg(ctx.orgId));
    const audience = routingAudience({
      parentOrganizationId: ctx.parentOrganizationId,
      isFranchiseParent: ctx.isFranchiseParent,
      paymentsCollectedByParent: ctx.paymentsCollectedByParent,
      collectsForAnyLocation: ctx.collectsForAnyLocation,
    });
    return {
      orgName: ctx.name,
      timezone: ctx.timezone,
      inFranchise,
      routing: { ...stripe1099kGuidance(audience), audience },
      reports: reportsFor({ inFranchise })
        .filter((d) => d.id !== "franchise_settlements" || canSeeSettlements)
        .map((d) => ({
          id: d.id,
          title: d.title,
          purpose: d.purpose,
          basis: d.basis,
        })),
      gaps: [
        "Sales tax is billed at one rate per business (Settings, Invoicing), on the whole invoice, with tax-exempt clients charged none. It is not tracked by jurisdiction or by line, so a business that owes tax to more than one state or city, or sells some services that are taxable and some that are not, will need its accountant to split the Sales tax collected report.",
        "Expenses are tracked only as far as they are logged in HoundStack: fuel, disposal fees, supplies, equipment, vehicle maintenance, mileage and other, in the expenses report. Payroll and Stripe's processing fees are not tracked and come from elsewhere.",
        "Stripe processing fees are netted out before payout and never recorded here, so gross card volume in HoundStack will exceed what actually reached the bank.",
      ],
    };
  });

export const getTaxReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => reportSchema.parse(d))
  .handler(async ({ data, context }): Promise<ReportResult> => {
    const ctx = await loadOrgContext(context.supabase, context.userId);
    const { supabase } = context;
    const { from, to } = data;
    if (to < from) throw new Error("The end of the period must be on or after its start.");

    const def = REPORT_DEFS[data.reportId as ReportId];
    if (!def) throw new Error("That report doesn't exist.");
    const inFranchise = ctx.isFranchiseParent || !!ctx.parentOrganizationId;
    if (def.franchiseOnly && !inFranchise) {
      throw new Error("That report only applies to a business that is part of a franchise.");
    }

    // The settlements sheet is the only report here that reads rows belonging to
    // ANOTHER organization, through service-role, past RLS. view_financials is
    // the wrong height for that: it admits an office_manager, who is denied
    // manage_franchise exactly so a location's staff cannot see the franchise's
    // side of the relationship — and /tax-reports let them download all of it.
    //
    // Same two checks, same order, same errors as resolveOrgId in
    // franchise.functions.ts. Deliberately the throwing funnel rather than the
    // predicate the index uses: a caller on the wrong plan has to be told to
    // upgrade, and a caller in the wrong role has to be told it is their role.
    if (def.id === "franchise_settlements") {
      await requirePermission(supabase, context.userId, "manage_franchise");
      const { requireEntitlement } = await import("@/lib/entitlements.server");
      await requireEntitlement(ctx.orgId, "franchise_structure");
    }

    let built: { rows: ReportRow[]; totals: ReportRow | null; caveats: string[] };
    switch (def.id) {
      case "income_cash":
        built = await buildIncomeCash(supabase, ctx, from, to);
        break;
      case "tips_received":
        built = await buildTipsReceived(supabase, ctx, from, to);
        break;
      case "sales_tax_collected":
        built = await buildSalesTaxCollected(supabase, ctx, from, to);
        break;
      case "income_accrual":
        built = await buildIncomeAccrual(supabase, ctx, from, to);
        break;
      case "cash_accrual_bridge":
        built = await buildBridge(supabase, ctx, from, to);
        break;
      case "revenue_by_client":
        built = await buildRevenueByClient(supabase, ctx, from, to);
        break;
      case "ar_aging":
        built = await buildAging(supabase, ctx, from, to);
        break;
      case "reversals":
        built = await buildReversals(supabase, ctx, from, to);
        break;
      case "write_offs":
        built = await buildWriteOffs(supabase, ctx, from, to);
        break;
      case "stripe_1099k":
        built = await build1099k(supabase, ctx, from, to);
        break;
      case "franchise_settlements":
        built = await buildFranchiseSettlements(ctx, from, to);
        break;
      case "referral_rewards":
        built = await buildReferralRewards(supabase, ctx, from, to);
        break;
      case "expenses_by_category":
        built = await buildExpensesByCategory(supabase, ctx, from, to);
        break;
      case "quickbooks_invoices":
        built = await buildQuickbooksInvoices(supabase, ctx, from, to);
        break;
      default:
        throw new Error("That report isn't built yet.");
    }

    return {
      id: def.id,
      title: def.title,
      purpose: def.purpose,
      basis: def.basis,
      note: def.note,
      columns: def.columns,
      range: { from, to },
      timezone: ctx.timezone,
      orgName: ctx.name,
      rows: built.rows,
      totals: built.totals,
      caveats: built.caveats,
      importFile: def.importFile,
    };
  });
