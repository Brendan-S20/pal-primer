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
  settlementOverlapsPeriod,
  stripe1099kGuidance,
  type Guidance,
  type ReportColumn,
  type ReportId,
} from "@/lib/cpa-reports";
// Static rather than the dynamic import the other reversal readers use: this is
// the pure arithmetic half of that module (no service-role client behind it),
// and every sheet below needs it.
import { totalReversals, type Reversal } from "@/lib/reversals.server";
// The point-in-time receivables position and the accrual billing rule both live
// in the shared AR module. They used to live HERE, privately, while /reports
// answered the same two questions its own way — which is how the pack reported
// $2,550.00 open for July and the page reported $2,655.00. One implementation,
// two callers.
import { billedDay, outstandingAsOf } from "@/lib/ar";
import { fetchAllPages as fetchAll } from "@/lib/supabase-paging.server";
import type { AppRole } from "@/hooks/useMyRole";

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
  status: string;
  paid_at: string | null;
  created_at: string;
  collected_by_organization_id: string | null;
};

/** Money that actually arrived. Includes 'refunded' on purpose — see the
 *  refunds note at the top of cpa-reports.ts. Excludes 'pending' and 'failed',
 *  which never reached the bank. */
async function loadReceipts(supabase: any, ctx: OrgContext, from: string, to: string) {
  const { lo, hi } = utcWindow(from, to);
  const rows = await fetchAll<PaymentRow>((a, b) =>
    supabase
      .from("payments")
      .select(
        // surcharge_cents: the 1099-K reconciliation sheet needs what STRIPE
        // reported, which is the charge — base + surcharge — not the revenue.
        "id, invoice_id, amount_cents, surcharge_cents, status, paid_at, created_at, collected_by_organization_id",
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
  client_id: string;
  status: string;
  total_cents: number | null;
  credit_applied_cents: number | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  due_on: string | null;
  updated_at: string | null;
};

const INVOICE_COLS =
  "id, client_id, status, total_cents, credit_applied_cents, issued_at, paid_at, voided_at, due_on, updated_at";

/** The whole invoice ledger for this org. The bridge and the aging report both
 *  need point-in-time positions, which cannot be derived from a filtered
 *  window — an invoice issued three years ago and still open is part of today's
 *  receivables. */
async function loadInvoices(supabase: any, ctx: OrgContext) {
  return fetchAll<InvoiceRow>((a, b) =>
    supabase
      .from("invoices")
      .select(INVOICE_COLS)
      .eq("organization_id", ctx.orgId)
      .neq("status", "draft")
      .order("created_at")
      .order("id")
      .range(a, b),
  );
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
    b.gross += p.amount_cents ?? 0;
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
      "Refunds & chargebacks is net of disputes you won: the deduction stands in the month the funds were withdrawn and the recovery is added back in the month they returned. A month can therefore show a negative figure in that column, and a dispute opened in one period and won in the next moves income between the two rather than restating either.",
    ],
  };
}

async function buildIncomeAccrual(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const byMonth = new Map<string, { invoiced: number; credits: number; count: number }>();
  for (const m of monthsBetween(from, to)) byMonth.set(m, { invoiced: 0, credits: 0, count: 0 });

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
    b.invoiced += inv.total_cents ?? 0;
    b.credits += inv.credit_applied_cents ?? 0;
    b.count += 1;
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
        writtenOff += Math.max((inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0), 0);
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
    b.gross += p.amount_cents ?? 0;
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
      '"Unattributed" covers refunds against payments taken before this period, where the original customer is outside the window being reported.',
      "Refunds is net of any dispute won in this period, so a customer whose chargeback you successfully defended can show a negative figure in that column.",
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
      `Aged as at ${to}, from each invoice's due date. The "from" date on this screen does not affect an aging report — a receivables position is a point in time, not a range.`,
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
          amount: Math.max((inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0), 0),
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
      reference: h.inv.id.slice(0, 8),
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
        // surcharge_cents: the 1099-K reconciliation sheet needs what STRIPE
        // reported, which is the charge — base + surcharge — not the revenue.
        "id, invoice_id, amount_cents, surcharge_cents, status, paid_at, created_at, collected_by_organization_id",
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
    b.gross += (p.amount_cents ?? 0) + (p.surcharge_cents ?? 0);
    b.count += 1;
  }
  // One row per COLLECTING account, which is what a 1099-K is issued against —
  // so volume this org collected for its locations joins this org's own row
  // rather than becoming a separate line for a form nobody will receive.
  let onBehalfGross = 0;
  for (const p of onBehalf) {
    const b = at(ctx.orgId);
    // Same reasoning as above: what Stripe reported, not what was revenue.
    const chargedCents = (p.amount_cents ?? 0) + (p.surcharge_cents ?? 0);
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
            : `${orgNames.get(key) ?? "Another organization"} — collected on your behalf`,
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
            `Of the gross above, ${(onBehalfGross / 100).toFixed(2)} was collected in your Stripe account on behalf of your locations. It is on your 1099-K because the charge landed in your account, but it is not your income — what you passed on is supported by the settlement statements.`,
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

  const DIRECTION: Record<string, string> = {
    franchise_owes_location: asParent ? "You owe the location" : "The franchise owes you",
    location_owes_franchise: asParent ? "The location owes you" : "You owe the franchise",
    settled: "Settled — nothing to move",
  };

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
    directionLabel: DIRECTION[r.direction] ?? r.direction,
    netDueCents: r.net_due_cents ?? 0,
    statusLabel: r.status === "draft" ? "Draft — not yet agreed" : r.status,
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
      'The period end shown is EXCLUSIVE — it is the first day of the next period, so a December statement reads "2026-01-01". A statement is counted in the year its period runs in, not the year its end date falls in.',
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
              ? "Earned — awaiting payout"
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
        "Sales tax is not tracked. HoundStack does not hold a tax rate or a taxable flag on invoices, so no sales-tax return can be produced from this data.",
        "Expenses are not tracked. These reports cover income and receivables only — payroll, fuel, disposal fees and Stripe's processing fees all come from elsewhere.",
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
    };
  });
