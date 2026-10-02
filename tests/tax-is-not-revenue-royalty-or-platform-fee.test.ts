// Sales tax collected is a LIABILITY -- the state's money passing through the
// business -- so it must never inflate revenue, the franchise royalty base, or
// the platform fee.
//
// How a payment's tax is identified: pro rata. `payments.tax_cents` is the
// payment's share of its invoice's tax (amount x invoice tax / invoice total),
// written by the database on every payment insert, INSIDE amount_cents. So
// revenue is amount_cents - tax_cents everywhere it is summed, in TypeScript
// and in SQL, and a receivable (what a customer owes) keeps the tax.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { grossReceivedCents, revenueCentsOf, taxReceivedCents, tipsReceivedCents } from "@/lib/revenue";
import { billedInPeriod } from "@/lib/ar";
import { franchiseTrendSeries } from "@/lib/franchise.functions";
import { describeSettlement } from "@/lib/franchise-settlement";
import { quoteProcessingFee } from "@/lib/processing-fee";
import { tippedCharge } from "@/lib/tips";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (p: string) => read(p).replace(/\/\/[^\n]*/g, "");

/** The body of the LAST migration that defines a function. */
function latestDefinitionOf(fn: string): string {
  const dir = join(ROOT, "supabase/migrations");
  let body = "";
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8");
    const m = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i").exec(sql);
    if (m) body = sql.slice(m.index, sql.indexOf("$function$;", m.index));
  }
  return body;
}

// A $108.25 invoice ($100 of service, $8.25 of tax) paid in full, a second
// paid in two halves, and a failed attempt that never arrived.
const PAYMENTS = [
  { amount_cents: 10_825, tax_cents: 825, status: "succeeded" },
  { amount_cents: 5_413, tax_cents: 413, status: "succeeded" },
  { amount_cents: 5_412, tax_cents: 412, tip_cents: 500, status: "refunded" },
  { amount_cents: 10_825, tax_cents: 825, status: "failed" },
];

describe("revenue", () => {
  it("is the amount applied to the invoice, less its tax share", () => {
    expect(grossReceivedCents(PAYMENTS)).toBe(10_000 + 5_000 + 5_000);
    expect(revenueCentsOf({ amount_cents: 10_825, tax_cents: 825 })).toBe(10_000);
  });

  it("puts the tax in its own figure, on the same received rule, apart from tips", () => {
    expect(taxReceivedCents(PAYMENTS)).toBe(825 + 413 + 412);
    expect(tipsReceivedCents(PAYMENTS)).toBe(500);
    // Revenue + tax is exactly the money that paid down invoices.
    expect(grossReceivedCents(PAYMENTS) + taxReceivedCents(PAYMENTS)).toBe(10_825 + 5_413 + 5_412);
  });

  it("is what /reports, the dashboard and the digest ask for, with the tax column selected", () => {
    expect(read("src/lib/revenue.server.ts")).toMatch(
      /\.select\("id, invoice_id, amount_cents, tax_cents, status, paid_at, created_at"\)/,
    );
    expect(code("src/lib/revenue.server.ts")).toMatch(/amountCents: revenueCentsOf\(p\)/);
    expect(read("src/lib/digest.server.ts").match(/amount_cents, tax_cents, status, paid_at/g)?.length).toBe(2);
    expect(read("src/lib/ai-tools.functions.ts")).toMatch(/amount_cents, tax_cents, status, paid_at/);
  });

  it("is what the accountant pack's income sheets sum", () => {
    const src = code("src/lib/cpa-reports.functions.ts");
    expect(src).toMatch(/const incomeOf = [\s\S]*?\(p\.amount_cents \?\? 0\) - Math\.max\(0, p\.tax_cents \?\? 0\)/);
    const cash = src.slice(src.indexOf("async function buildIncomeCash"), src.indexOf("async function buildTipsReceived"));
    expect(cash).toContain("b.gross += incomeOf(p);");
    const byClient = src.slice(src.indexOf("async function buildRevenueByClient"), src.indexOf("async function buildAging"));
    expect(byClient).toContain("b.gross += incomeOf(p);");
    const accrual = src.slice(src.indexOf("async function buildIncomeAccrual"), src.indexOf("async function buildBridge"));
    expect(accrual).toContain("b.invoiced += (inv.total_cents ?? 0) - Math.max(0, inv.tax_cents ?? 0);");
  });

  it("billed in a period excludes the tax on what was billed, and says how much", () => {
    const inv = {
      status: "open",
      total_cents: 10_825,
      tax_cents: 825,
      credit_applied_cents: 0,
      issued_at: "2026-07-10T15:00:00Z",
    };
    const b = billedInPeriod([inv], "2026-07-01", "2026-07-31", "America/Chicago");
    expect(b.billedCents).toBe(10_000);
    expect(b.taxBilledCents).toBe(825);
    expect(b.netBilledCents).toBe(10_000);
  });

  it("on the franchise trend chart excludes the tax", () => {
    const start = new Date("2026-07-06T00:00:00Z");
    const end = new Date("2026-07-13T00:00:00Z");
    const rows = franchiseTrendSeries(
      [{ id: "loc", name: "Location" }],
      [{ key: "07-06", start, end }],
      [{ organization_id: "loc", amount_cents: 10_825, tax_cents: 825, status: "succeeded", created_at: "2026-07-08T12:00:00Z" }],
      [],
    );
    expect(rows[0].loc).toBe(100);
  });

  it("in SQL: client lifetime value, churn at risk and the franchise rollup take the tax out", () => {
    const mig = read("supabase/migrations/20260929110000_tax-was-always-zero-and-could-not-be-anything-else.sql");
    expect(mig).toMatch(/'SELECT SUM\(p\.amount_cents - p\.tax_cents\)::bigint FROM public\.payments p'/);
    expect(mig).toMatch(/replace\(_def, 'SUM\(i\.total_cents\)', 'SUM\(i\.total_cents - i\.tax_cents\)'\)/);
    expect(mig).toMatch(/pg_get_functiondef\('public\.client_ltv\(uuid, integer\)'::regprocedure\)/);
    expect(mig).toMatch(/pg_get_functiondef\('public\.churn_drivers\(uuid\)'::regprocedure\)/);
  });
});

describe("the franchise royalty", () => {
  const body = latestDefinitionOf("generate_franchise_settlements");

  it("is taken on revenue excluding tax", () => {
    expect(body).toMatch(/coalesce\(sum\(p\.amount_cents - p\.tax_cents\), 0\)::bigint AS total/);
    expect(body).toMatch(/round\(r\.total \* r\.pct \/ 100\.0\)/);
    // Every revenue sum in the statement, not just the total.
    expect(body).not.toMatch(/sum\(p\.amount_cents\)/);
  });

  it("passes the tax the franchise collected to the location, whole", () => {
    expect(body).toMatch(/coalesce\(sum\(p\.tax_cents\) FILTER \(WHERE p\.collected_by_organization_id = _parent\), 0\)::bigint AS tax_by_parent/);
    expect(body).toMatch(/\(r\.by_parent \+ r\.tax_by_parent\s+- round\(r\.total \* r\.pct \/ 100\.0\)/);
    expect(body).toMatch(/sales_tax_collected_by_parent_cents = EXCLUDED\.sales_tax_collected_by_parent_cents/);
  });

  it("prints that tax on the statement, so its arithmetic still closes", () => {
    const line = describeSettlement(
      {
        id: "s",
        period_start: "2026-07-01",
        period_end: "2026-08-01",
        revenue_cents: 10_006,
        royalty_percent: 10,
        royalty_cents: 1_001,
        adjustments_applied_cents: 0,
        revenue_collected_by_parent_cents: 10_006,
        sales_tax_collected_by_parent_cents: 825,
        direction: "franchise_owes_location",
        net_due_cents: 9_830,
        status: "draft",
      },
      "location",
    );
    expect(line.taxHeldByFranchiseCents).toBe(825);
    expect(line.collectedByFranchiseCents! + line.taxHeldByFranchiseCents - line.royaltyCents - line.adjustmentsCents).toBe(
      line.netDueCents,
    );
  });

  it("deducts a refund's revenue share, not its tax, from the location", () => {
    // The webhook hands record_franchise_adjustment `revenueAmount`, which
    // splitRefund now computes net of the payment's tax share.
    const hook = code("src/routes/api/public/hooks/stripe.ts");
    expect(hook).toMatch(/_amount_cents: revenueAmount/);
    expect(hook).toMatch(/Number\(pay\.tax_cents \?\? 0\),\s*\)\.revenueCents;/);
  });
});

describe("the platform fee", () => {
  it("is taken on the pre-tax share of what is paid", () => {
    const src = code("src/lib/platform-fee.ts");
    expect(src).toMatch(/const amount = preTaxShareCents\(Math\.floor\(amountCents\), invoice\);/);
  });

  it("is given the invoice at every charge site that pays one", () => {
    const sites = [
      "src/lib/invoices.functions.ts",
      "src/lib/portal.functions.ts",
      "src/lib/invoice-reconcile.server.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ];
    for (const f of sites) {
      const src = code(f);
      const calls = [...src.matchAll(/platformFeeCents\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length, f).toBeGreaterThan(0);
      for (const args of calls) {
        // Either (due, invoice) or the tipped charge's base, which is computed
        // pre-tax by tippedCharge itself.
        expect(
          /^\w+, (invoice|inv)$/.test(args) || args === "charge.platformFeeBaseCents",
          `${f}: platformFeeCents(${args})`,
        ).toBe(true);
      }
    }
  });

  it("on a tipped charge is based on the invoice's pre-tax share, never the tip or the tax", () => {
    const c = tippedCharge({
      dueCents: 10_825,
      choice: { kind: "percent", percent: 10 },
      tipsEnabled: true,
      invoice: { tax_cents: 825, total_cents: 10_825 },
    });
    expect(c.platformFeeBaseCents).toBe(10_000);
    // The card is still charged the whole invoice plus the tip.
    expect(c.amountCents).toBe(10_825 + c.tipCents);
  });
});

describe("the card surcharge", () => {
  const cfg = { rail: "card" as const, funding: "credit" as const, merchantRegion: "TX", passThroughEnabled: true, attested: true };

  it("is computed on the pre-tax base, and the charge is still the whole invoice plus it", () => {
    const withTax = quoteProcessingFee({ ...cfg, baseCents: 10_825, taxCents: 825 });
    const onService = quoteProcessingFee({ ...cfg, baseCents: 10_000 });
    expect(withTax.surchargeCents).toBe(onService.surchargeCents);
    expect(withTax.totalCents).toBe(10_825 + withTax.surchargeCents);
    // And is never larger than it would have been on the whole amount.
    const onWhole = quoteProcessingFee({ ...cfg, baseCents: 10_825 });
    expect(withTax.surchargeCents).toBeLessThanOrEqual(onWhole.surchargeCents);
  });

  it("is given the invoice's tax at each of the three surcharging paths", () => {
    for (const f of [
      "src/lib/invoices.functions.ts",
      "src/lib/portal.functions.ts",
      "src/routes/api/public/hooks/nightly.ts",
    ]) {
      expect(code(f), f).toMatch(/taxCents: taxShareCents\(dueCents, (invoice|inv)\.tax_cents, (invoice|inv)\.total_cents\)/);
    }
  });
});
