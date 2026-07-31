import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  REPORT_DEFS,
  agingBucket,
  monthLabel,
  monthsBetween,
  monthKey,
  orgLocalDay,
  reducesIncome,
  reportsFor,
  reversalLabel,
  routingAudience,
  stripe1099kGuidance,
  type Guidance,
  type ReportColumn,
  type ReportId,
} from "@/lib/cpa-reports";
import { fetchAllPages as fetchAll } from "@/lib/supabase-paging.server";

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

type OrgContext = {
  orgId: string;
  name: string;
  timezone: string;
  parentOrganizationId: string | null;
  isFranchiseParent: boolean;
  paymentsCollectedByParent: boolean;
  collectsForAnyLocation: boolean;
};

async function loadOrgContext(supabase: any, userId: string): Promise<OrgContext> {
  const { orgId } = await requirePermission(supabase, userId, "view_financials");
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
        "id, invoice_id, amount_cents, status, paid_at, created_at, collected_by_organization_id",
      )
      .eq("organization_id", ctx.orgId)
      .in("status", ["succeeded", "refunded"])
      .gte("created_at", lo)
      .lte("created_at", hi)
      .order("created_at")
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

/** Was this invoice an open receivable at the end of `day`?
 *
 *  Reconstructed from the timestamps rather than the current status, because
 *  the status only tells you about today. Point-in-time is the whole job here:
 *  a December balance sheet prepared in March must show December. */
function outstandingAsOf(inv: InvoiceRow, day: string, tz: string): number {
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
  return Math.max((inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0), 0);
}

// ── The reports ────────────────────────────────────────────────────────────

async function buildIncomeCash(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
  ]);

  const byMonth = new Map<string, { gross: number; refunds: number; count: number }>();
  for (const m of monthsBetween(from, to)) byMonth.set(m, { gross: 0, refunds: 0, count: 0 });
  const bucket = (m: string) => {
    let b = byMonth.get(m);
    if (!b) {
      b = { gross: 0, refunds: 0, count: 0 };
      byMonth.set(m, b);
    }
    return b;
  };

  for (const p of receipts) {
    const b = bucket(monthKey(p.day));
    b.gross += p.amount_cents ?? 0;
    b.count += 1;
  }
  for (const r of reversals) {
    if (!reducesIncome(r.kind)) continue;
    bucket(monthKey(r.day)).refunds += r.amountCents;
  }

  const rows: ReportRow[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, b]) => ({
      month: monthLabel(m),
      grossCents: b.gross,
      refundsCents: b.refunds,
      netCents: b.gross - b.refunds,
      paymentCount: b.count,
    }));

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
    ],
  };
}

async function buildIncomeAccrual(supabase: any, ctx: OrgContext, from: string, to: string) {
  const invoices = await loadInvoices(supabase, ctx);
  const byMonth = new Map<string, { invoiced: number; credits: number; count: number }>();
  for (const m of monthsBetween(from, to)) byMonth.set(m, { invoiced: 0, credits: 0, count: 0 });

  for (const inv of invoices) {
    if (inv.status === "void" || !inv.issued_at) continue;
    const day = orgLocalDay(inv.issued_at, ctx.timezone);
    if (!inRange(day, from, to)) continue;
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
  const dayBefore = new Date(`${from}T12:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const opening = dayBefore.toISOString().slice(0, 10);

  let openingAr = 0;
  let closingAr = 0;
  let invoiced = 0;
  let creditsApplied = 0;
  let writtenOff = 0;

  for (const inv of invoices) {
    openingAr += outstandingAsOf(inv, opening, tz);
    closingAr += outstandingAsOf(inv, to, tz);

    const issued = inv.issued_at ? orgLocalDay(inv.issued_at, tz) : null;
    if (issued && inRange(issued, from, to) && inv.status !== "void") {
      invoiced += inv.total_cents ?? 0;
      creditsApplied += inv.credit_applied_cents ?? 0;
    }
    const voided = inv.voided_at ? orgLocalDay(inv.voided_at, tz) : null;
    if (voided && inRange(voided, from, to)) writtenOff += inv.total_cents ?? 0;
    else if (inv.status === "uncollectible") {
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

  const acc = new Map<string, { gross: number; refunds: number; count: number }>();
  const at = (cid: string) => {
    let b = acc.get(cid);
    if (!b) {
      b = { gross: 0, refunds: 0, count: 0 };
      acc.set(cid, b);
    }
    return b;
  };
  for (const p of receipts) {
    const b = at(paymentClient.get(p.id) ?? "");
    b.gross += p.amount_cents ?? 0;
    b.count += 1;
  }
  for (const r of reversals) {
    if (!reducesIncome(r.kind)) continue;
    // The reversal's subject is the payment; the payment may pre-date the
    // window, so fall back to the invoice ledger rather than dropping it.
    const cid = paymentClient.get(r.paymentId ?? "") ?? "";
    at(cid).refunds += r.amountCents;
  }

  const names = await clientNames(supabase, ctx, [...acc.keys()]);
  const rows: ReportRow[] = [...acc.entries()]
    .map(([cid, b]) => ({
      clientName: names.get(cid) ?? "Unattributed",
      grossCents: b.gross,
      refundsCents: b.refunds,
      netCents: b.gross - b.refunds,
      paymentCount: b.count,
    }))
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
      "Each payment carries at most one refund entry. If a single payment was refunded in two parts, only the first is listed — check Stripe directly if a partial refund history matters for a return.",
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

async function build1099k(supabase: any, ctx: OrgContext, from: string, to: string) {
  const [receipts, reversals] = await Promise.all([
    loadReceipts(supabase, ctx, from, to),
    loadReversals(supabase, ctx, from, to),
  ]);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const acc = new Map<string, { gross: number; refunds: number; count: number }>();
  const at = (key: string) => {
    let b = acc.get(key);
    if (!b) {
      b = { gross: 0, refunds: 0, count: 0 };
      acc.set(key, b);
    }
    return b;
  };
  const collectorOf = new Map<string, string>();
  for (const p of receipts) {
    const key = p.collected_by_organization_id ?? ctx.orgId;
    collectorOf.set(p.id, key);
    const b = at(key);
    b.gross += p.amount_cents ?? 0;
    b.count += 1;
  }
  for (const r of reversals) {
    if (!reducesIncome(r.kind)) continue;
    at(collectorOf.get(r.paymentId ?? "") ?? ctx.orgId).refunds += r.amountCents;
  }

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
    .map(([key, b]) => ({
      collectedBy:
        key === ctx.orgId
          ? `${ctx.name} (your own Stripe account)`
          : `${orgNames.get(key) ?? "Another organization"} — collected on your behalf`,
      grossCents: b.gross,
      refundsCents: b.refunds,
      netCents: b.gross - b.refunds,
      paymentCount: b.count,
    }))
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
    caveats: [guidance.headline, ...guidance.points],
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
    .gte("period_end", from)
    .order("period_start");
  if (error) throw new Error(error.message);

  const counterpartyIds = [
    ...new Set(
      (data ?? []).map((r: any) =>
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

  const rows: ReportRow[] = (data ?? []).map((r: any) => ({
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
      reports: reportsFor({ inFranchise }).map((d) => ({
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
