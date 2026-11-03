// A deposit is part payment of its stay (#653 part 2, decision D3), cash and
// checks can be given back with a reason, and the office can record a cash
// tip.
//
// Round-2 audit: the December stay ($500) and its deposit ($150, part of the
// $500) were both open, both billed and both in AR, so the portal said "3 open
// invoices, $1,050" and the night card said $850 for a $200 stay. Decision
// D3: a deposit is a partial payment of its stay invoice, not a credit.
//
// The money moves in SQL, proved in a real database by
// tests/sql/a-deposit-is-part-payment-of-its-stay.proof.sql (run below when a
// database answers). This file holds the arithmetic every screen and report
// does in TypeScript, so the dashboard, /reports, the CPA pack, the portal
// and AR aging agree with it.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  arPositionAsOf,
  billedInPeriod,
  isLinkedDeposit,
  outstandingAsOf,
  summarizeAr,
  type LedgerInvoice,
} from "@/lib/ar";
import { summarizeOpenInvoices } from "@/lib/overdue";
import { revenueByService } from "@/lib/revenue-by-service";
import { grossReceivedCents, tipsReceivedCents } from "@/lib/revenue";
import { officeTipProblem } from "@/lib/office-tip";
import { canRecordManualRefund, manualRefundReasonProblem } from "@/lib/refunds";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261102160000_a-deposit-is-part-payment-of-its-stay.sql",
);
const CARD = join(ROOT, "supabase/migrations/20261102150000_tonights-card-is-tonights-stay.sql");
const FRANCHISE = join(
  ROOT,
  "supabase/migrations/20261102160500_franchise-ar-counts-a-stay-once.sql",
);
const REFUNDS = join(
  ROOT,
  "supabase/migrations/20261102161000_cash-and-checks-can-be-given-back.sql",
);
const PROOF = join(ROOT, "tests/sql/a-deposit-is-part-payment-of-its-stay.proof.sql");

const TZ = "America/Chicago";
const issued = "2026-10-01T15:00:00Z";

/** The audit's two stays, after the database has done its part: tonight's
 *  stay ($350, its $150 deposit paid, so $150 paid on it) and December's
 *  ($500, its $150 deposit not yet paid). */
function auditBook(): Array<LedgerInvoice & { id: string; client_id: string }> {
  return [
    {
      id: "stay-now",
      client_id: "c1",
      status: "open",
      total_cents: 35_000,
      amount_paid_cents: 15_000,
      issued_at: issued,
      due_on: "2026-11-01",
    },
    {
      id: "dep-now",
      client_id: "c1",
      status: "paid",
      total_cents: 15_000,
      amount_paid_cents: 15_000,
      issued_at: issued,
      paid_at: "2026-10-02T15:00:00Z",
      deposit_for_invoice_id: "stay-now",
    },
    {
      id: "stay-dec",
      client_id: "c1",
      status: "open",
      total_cents: 50_000,
      issued_at: issued,
      due_on: "2026-12-20",
    },
    {
      id: "dep-dec",
      client_id: "c1",
      status: "open",
      total_cents: 15_000,
      issued_at: issued,
      due_on: "2026-10-01",
      deposit_for_invoice_id: "stay-dec",
    },
  ];
}

describe("a linked deposit is part of its stay, not a bill of its own", () => {
  it("is recognised by its link, and only by its link", () => {
    expect(isLinkedDeposit({ deposit_for_invoice_id: "stay-now" })).toBe(true);
    expect(isLinkedDeposit({ deposit_for_invoice_id: null })).toBe(false);
    expect(isLinkedDeposit({})).toBe(false);
  });

  it("open AR is the stay totals less the deposits paid: $350 - $150 + $500 = $700", () => {
    const ar = summarizeAr(auditBook(), "2026-11-02");
    expect(ar.arOpenCents).toBe(35_000 - 15_000 + 50_000);
    expect(ar.openCount).toBe(2);
    // The unpaid December deposit is due today and overdue, but it is not a
    // receivable of its own: the December stay already carries it.
    expect(ar.overdueCents).toBe(20_000);
  });

  it("the portal says 2 open invoices and $700, not 3 and $1,050", () => {
    const book = auditBook().map((i) => ({ ...i, status: i.status as string }));
    const s = summarizeOpenInvoices(book, "2026-11-02");
    expect(s.openCount).toBe(2);
    expect(s.openTotalCents).toBe(70_000);
  });

  it("billed revenue is the stays, once: $850, not $1,150", () => {
    const b = billedInPeriod(auditBook(), "2026-10-01", "2026-10-31", TZ);
    expect(b.billedCents).toBe(85_000);
    expect(b.invoiceCount).toBe(2);
  });

  it("billed less received is what is still owed", () => {
    // Received: the one $150 deposit payment, counted once, as cash.
    const received = grossReceivedCents([{ amount_cents: 15_000, status: "succeeded" }]);
    const billed = billedInPeriod(auditBook(), "2026-10-01", "2026-10-31", TZ).billedCents;
    expect(billed - received).toBe(summarizeAr(auditBook(), "2026-11-02").arOpenCents);
  });

  it("aging and a point-in-time balance count the deposit from the day it was paid", () => {
    const book = auditBook();
    // Dated payments, as attachDatedPartialPayments now gives a stay invoice:
    // its deposit's payment, on 2 October.
    book[0].paymentsAsOf = [{ amount_cents: 15_000, paid_at: "2026-10-02T15:00:00Z" }];
    expect(outstandingAsOf(book[0], "2026-10-01", TZ)).toBe(35_000);
    expect(outstandingAsOf(book[0], "2026-10-03", TZ)).toBe(20_000);
    expect(outstandingAsOf(book[3], "2026-10-03", TZ)).toBe(0);
    expect(arPositionAsOf(book, "2026-10-03", TZ).outstandingCents).toBe(70_000);
  });

  it("revenue by service leaves a linked deposit's line out", () => {
    const rows = revenueByService({
      lines: [
        { invoice_id: "stay-dec", amount_cents: 50_000, visit_id: null, subscription_id: null },
        { invoice_id: "dep-dec", amount_cents: 15_000, visit_id: null, subscription_id: null },
      ],
      invoices: [
        { id: "stay-dec", status: "open", issued_at: issued },
        { id: "dep-dec", status: "open", issued_at: issued, deposit_for_invoice_id: "stay-dec" },
      ],
      from: "2026-10-01",
      to: "2026-10-31",
      timezone: TZ,
      visitService: new Map(),
      subscriptionService: new Map(),
      serviceName: new Map(),
    });
    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(50_000);
  });

  it("every AR and billed reader selects the link", () => {
    for (const f of [
      "src/lib/dashboard.functions.ts",
      "src/lib/reports.functions.ts",
      "src/lib/cpa-reports.functions.ts",
      "src/lib/clients.functions.ts",
      "src/lib/digest.server.ts",
      "src/lib/portal.functions.ts",
      "src/lib/invoices.functions.ts",
      "src/lib/revenue-by-service.functions.ts",
    ]) {
      expect(read(f), f).toContain("deposit_for_invoice_id");
    }
  });
});

describe("dated deposit payments reach the stay invoice", () => {
  it("attaches a deposit's payments to the stay it is part of", async () => {
    const { attachDatedPartialPayments } = await import("@/lib/partial-payments.server");
    const payments = [
      {
        invoice_id: "dep-now",
        amount_cents: 15_000,
        paid_at: "2026-10-02T15:00:00Z",
        created_at: null,
      },
      {
        invoice_id: "stay-now",
        amount_cents: 20_000,
        paid_at: "2026-10-09T15:00:00Z",
        created_at: null,
      },
    ];
    const db = {
      from: () => {
        const q: Record<string, unknown> = {};
        let ids: string[] | null = null;
        let partialOnly = false;
        Object.assign(q, {
          select: () => q,
          eq: (col: string) => {
            if (col === "raw_event->>partial") partialOnly = true;
            return q;
          },
          in: (_c: string, v: string[]) => {
            ids = v;
            return q;
          },
          then: (resolve: (r: unknown) => void) =>
            resolve({
              data: partialOnly ? [] : payments.filter((p) => !ids || ids.includes(p.invoice_id)),
              error: null,
            }),
        });
        return q;
      },
    };
    const book = auditBook();
    await attachDatedPartialPayments(db, "org", book);
    expect(book[0].paymentsAsOf).toEqual([
      { amount_cents: 20_000, paid_at: "2026-10-09T15:00:00Z" },
      { amount_cents: 15_000, paid_at: "2026-10-02T15:00:00Z" },
    ]);
    expect(book[2].paymentsAsOf).toBeUndefined();
  });
});

describe("cash and checks given back, with a reason (F-09)", () => {
  const cash = {
    status: "succeeded",
    stripe_payment_intent_id: null,
    amount_cents: 4_000,
    refunded_cents: 0,
  };

  it("is offered on a cash or check payment, to a billing role, once", () => {
    expect(canRecordManualRefund("owner", cash)).toBe(true);
    expect(canRecordManualRefund("dispatcher", cash)).toBe(false);
    expect(canRecordManualRefund("owner", { ...cash, stripe_payment_intent_id: "pi_1" })).toBe(
      false,
    );
    expect(canRecordManualRefund("owner", { ...cash, refunded_cents: 1_000 })).toBe(false);
    expect(canRecordManualRefund("owner", { ...cash, status: "refunded" })).toBe(false);
  });

  it("needs a reason", () => {
    expect(manualRefundReasonProblem("")).toMatch(/why/);
    expect(manualRefundReasonProblem("  ")).toMatch(/why/);
    expect(manualRefundReasonProblem("Check 1042 bounced")).toBeNull();
    expect(manualRefundReasonProblem("x".repeat(301))).toMatch(/300/);
  });

  it("files a dated reversal the reports already deduct", () => {
    const sql = readFileSync(REFUNDS, "utf8");
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.refund_manual_payment"));
    expect(fn).toContain("'payment_refunded'");
    expect(fn).toContain("'revenue_cents', _amount_cents - _tax");
    expect(fn).toContain("has_permission(_uid, _p.organization_id, 'manage_client_billing')");
    expect(fn).toContain("Say why the money is going back");
    // The register module reads these rows for /reports and the CPA pack.
    expect(read("src/lib/cpa-reports.ts")).toMatch(/"payment_refunded"/);
  });

  it("is drawn on both invoice surfaces", () => {
    expect(read("src/components/InvoiceDrawer.tsx")).toContain("<ManualRefundAction");
    expect(read("src/routes/_authenticated/invoices.$invoiceId.tsx")).toContain(
      "<ManualRefundAction",
    );
  });
});

describe("a cash tip from the office", () => {
  it("is one invoice's cash or check, and at most $1,000", () => {
    const one = { ids: ["i1"], method: "cash", tipCents: 500 };
    expect(officeTipProblem(one)).toBeNull();
    expect(officeTipProblem({ ...one, method: "check" })).toBeNull();
    expect(officeTipProblem({ ...one, method: "venmo" })).toMatch(/cash or a check/);
    expect(officeTipProblem({ ...one, ids: ["i1", "i2"] })).toMatch(/one invoice/);
    expect(officeTipProblem({ ...one, fieldCollectionId: "fc" })).toMatch(/one invoice/);
    expect(officeTipProblem({ ...one, tipCents: 100_001 })).toMatch(/1,000/);
    expect(officeTipProblem({ ids: ["i1", "i2"], method: "zelle" })).toBeNull();
  });

  it("sits beside the payment: not revenue, in Tips received", () => {
    const row = { amount_cents: 4_000, tip_cents: 500, status: "succeeded" };
    expect(grossReceivedCents([row])).toBe(4_000);
    expect(tipsReceivedCents([row])).toBe(500);
  });

  it("is written onto the payment it came with, and only that one", async () => {
    const calls: Array<[string, unknown]> = [];
    const chain = {
      update: (v: unknown) => (calls.push(["update", v]), chain),
      eq: (c: string, v: unknown) => (calls.push([`eq:${c}`, v]), chain),
      is: (c: string, v: unknown) => (calls.push([`is:${c}`, v]), Promise.resolve({ error: null })),
    };
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: {
        rpc: async () => ({ data: "staff-1", error: null }),
        from: (t: string) => (calls.push(["from", t]), chain),
      },
    }));
    const { recordOfficeTip } = await import("@/lib/office-tip.server");
    await recordOfficeTip({ orgId: "o1", invoiceId: "i1", paymentId: "p1", tipCents: 500 });
    expect(calls).toEqual([
      ["from", "payments"],
      ["update", { tip_cents: 500, tip_staff_id: "staff-1" }],
      ["eq:id", "p1"],
      ["eq:organization_id", "o1"],
      ["eq:invoice_id", "i1"],
      ["eq:tip_cents", 0],
      ["is:stripe_payment_intent_id", null],
    ]);
    vi.doUnmock("@/integrations/supabase/client.server");
  });

  it("is asked for only with cash or a check on one invoice", () => {
    const dialog = read("src/components/RecordPaymentDialog.tsx");
    expect(dialog).toContain(
      'const takesTip = balance != null && (method === "cash" || method === "check");',
    );
    expect(read("src/lib/invoices.functions.ts")).toContain("officeTipProblem(data)");
  });
});

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("stops posting a linked deposit as account credit", () => {
    const credit = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.tg_invoice_paid_credit"),
    );
    expect(credit.slice(0, 800)).toContain("AND NEW.deposit_for_invoice_id IS NULL");
  });

  it("links only deposits still to be paid, so no paid deposit is counted twice", () => {
    const backfill = sql.slice(sql.indexOf("-- ── 5. Backfill"), sql.indexOf("DO $check$"));
    expect(backfill).toContain("AND d.deposit_for_invoice_id IS NULL");
    expect(backfill).toContain("AND d.status IN ('draft', 'open')");
  });

  it("leaves a linked deposit out of each location's open AR", () => {
    expect(readFileSync(FRANCHISE, "utf8")).toContain("AND i.deposit_for_invoice_id IS NULL");
  });

  it("voids a deposit without asking who is signed in, because a webhook is nobody", () => {
    const follows = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.tg_invoices_deposit_follows"),
    );
    expect(follows.slice(0, 2000)).not.toContain("void_invoice(");
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the deposit proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a deposit, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(CARD)).toBe(true);
    expect(existsSync(FRANCHISE)).toBe(true);
    expect(existsSync(REFUNDS)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("nets against its stay, follows it, and gives cash back with a reason", () => {
    const r = spawnSync(
      psql!,
      [
        DB_URL,
        "-X",
        "-v",
        `card=${CARD}`,
        "-v",
        `migration=${MIGRATION}`,
        "-v",
        `franchise=${FRANCHISE}`,
        "-v",
        `refunds=${REFUNDS}`,
        "-f",
        PROOF,
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(11);
    expect(out).toMatch(/ALL DEPOSIT PROOFS PASSED/);
  });
});
