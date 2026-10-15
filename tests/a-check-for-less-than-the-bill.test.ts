/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for UI and hook types */
// A check for less than the bill (QA batch 6, row 12; A-02).
//
// An owner handed $60 against $80 owed could not record it: Record payment
// had no amount and marked the invoice paid in full, and "Collected in the
// field" paid an invoice whole or not at all. 20261015120000 adds
// invoices.amount_paid_cents (the sum of succeeded payments, kept by a
// trigger), record_invoice_payment (an amount, refused above the balance, paid
// at zero) and an oldest-first confirm_field_collection.
//
// tests/sql/a-check-for-less-than-the-bill.proof.sql proves the database half
// against a real Postgres when one answers (CI's test job); here, the
// migration is read, the arithmetic every screen and charge uses is checked,
// and the dialog is rendered.
import React, { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  invoiceDueCents,
  invoiceOutstandingCents,
  isPartiallyPaid,
  outstandingAsOf,
  summarizeAr,
} from "@/lib/ar";
import { allocateOldestFirst, defaultInvoiceSelection } from "@/lib/field-collections";
import { parsePaymentAmount, paymentAmountProblem } from "@/lib/manual-payments";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261015120000_a-check-for-less-than-the-bill.sql",
);
const PROOF = join(ROOT, "tests/sql/a-check-for-less-than-the-bill.proof.sql");
const DB_URL =
  process.env.PARTIAL_PAYMENT_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const sql = readFileSync(MIGRATION, "utf8");

/** One function's definition, from CREATE to its closing dollar quote. */
function fnBody(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.search(/^(\$\$|\$function\$);\s*$/m);
  return rest.slice(0, end).trimEnd();
}

describe("the migration, read", () => {
  it("adds the column, the guard and the sync, and turns touch_invoices back on", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS amount_paid_cents integer NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/CHECK \(amount_paid_cents >= 0\)/);
    expect(sql).toMatch(
      /CREATE TRIGGER payments_sync_invoice_paid\s+AFTER INSERT OR DELETE OR UPDATE OF status, amount_cents, invoice_id ON public\.payments/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER invoices_guard_amount_paid\s+BEFORE INSERT OR UPDATE OF amount_paid_cents/,
    );
    const off = sql.indexOf("DISABLE TRIGGER touch_invoices");
    const on = sql.indexOf("ENABLE TRIGGER touch_invoices");
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
    // The sum counts only money that arrived.
    expect(fnBody(sql, "invoice_paid_cents")).toContain("p.status = 'succeeded'");
  });

  it("records an amount, refuses more than the balance, and pays at zero", () => {
    const body = fnBody(sql, "record_invoice_payment");
    for (const rule of [
      "FOR UPDATE",
      "has_permission(_uid, _inv.organization_id, 'manage_client_billing')",
      "_inv.status IN ('paid', 'void')",
      "IF _amount > _balance THEN",
      "That is more than the % still owed on this invoice",
      "_settled := (_amount = _balance)",
      "SET status = 'paid', paid_at = _paid_at",
      "'partial', _amount < _balance",
      "SECURITY DEFINER",
      "SET search_path TO 'public', 'pg_temp'",
    ]) {
      expect(body, rule).toContain(rule);
    }
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_invoice_payment\([^)]*\)\s+FROM PUBLIC, anon;/,
    );
  });

  it("confirms a field collection oldest first, last one partly, refusing a ticked invoice it cannot reach", () => {
    const body = fnBody(sql, "confirm_field_collection");
    expect(body).toContain("ORDER BY i.period_end, i.issued_at, i.created_at, i.id");
    expect(body).toContain("_take := LEAST(_left, _row.balance)");
    expect(body).toContain("public.record_invoice_payment(");
    expect(body).toContain("IF _row.balance > 0 AND _left <= 0 THEN");
    expect(body).toContain("'allocations', _allocations");
    // The card lists them in the same order, so it previews what happens.
    const list = readFileSync(join(ROOT, "src/lib/field-collections.functions.ts"), "utf8");
    expect(list).toMatch(
      /\.order\("period_end"[^)]*\)\s*\.order\("issued_at"[^)]*\)\s*\.order\("created_at"[^)]*\)\s*\.order\("id"/,
    );
  });

  it.each([
    [
      "record_field_collection",
      "20261004150000_nothing-in-the-field-told-anyone.sql",
      [
        [
          "GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0)",
          "GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0)",
        ],
      ],
    ],
    [
      "my_day_stop_facts",
      "20261012120000_a-missed-stop-was-labelled-invoiced.sql",
      [
        [
          "GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0)",
          "GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0)",
        ],
      ],
    ],
    [
      "franchise_rollup",
      "20260819130000_every-location-kept-the-parents-clock-and-rolled-over-an-hour-early.sql",
      [
        [
          "GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0)",
          "GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0)",
        ],
        // A comment inside the body, reworded to the repo's no-em-dash rule.
        [
          "from the same instant \u2014 only the zone differs",
          "from the same instant; only the zone differs",
        ],
      ],
    ],
    [
      "apply_credit_to_invoice",
      "20260717120000_credit-application-qa-fixes.sql",
      [
        [
          "GREATEST(COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0), 0)",
          "GREATEST(COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0) - COALESCE(_inv.amount_paid_cents, 0), 0)",
        ],
        [
          "'Applied to invoice #' || left(_invoice_id::text, 8))",
          "'Applied to invoice ' || CASE WHEN _inv.number IS NOT NULL THEN 'INV-' || _inv.number ELSE '#' || left(_invoice_id::text, 8) END)",
        ],
      ],
    ],
  ] as const)(
    "re-issues %s as its latest definition with only the balance changed",
    (name, from, subs) => {
      let expected = fnBody(readFileSync(join(ROOT, "supabase/migrations", from), "utf8"), name);
      for (const [a, b] of subs) {
        expect(expected.split(a).length - 1, a).toBe(1);
        expected = expected.replace(a, b);
      }
      expect(fnBody(sql, name)).toBe(expected);
    },
  );

  it("asserts what it establishes, and only warns about what it measured", () => {
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).toContain(
      "RAISE EXCEPTION '% invoices disagree with their payments after the backfill'",
    );
    expect(check).toContain("RAISE WARNING 'open invoices that already had money against them");
    const code = sql
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    expect(code).not.toMatch(/pg_get_functiondef/);
  });
});

describe("the balance every screen and charge uses", () => {
  const inv = (o: Record<string, unknown> = {}) => ({
    status: "open",
    total_cents: 8000,
    credit_applied_cents: 0,
    amount_paid_cents: 0,
    ...o,
  });

  it("is total less credit less what was paid", () => {
    expect(invoiceDueCents(inv({ amount_paid_cents: 6000 }))).toBe(2000);
    expect(invoiceDueCents(inv({ credit_applied_cents: 1000, amount_paid_cents: 6000 }))).toBe(
      1000,
    );
    expect(invoiceDueCents(inv({ amount_paid_cents: 9000 }))).toBe(0);
    // A row read without the column is what every row was before it.
    expect(invoiceDueCents({ total_cents: 8000, credit_applied_cents: 500 })).toBe(7500);
  });

  it("keeps a partly paid invoice open and outstanding for the rest", () => {
    const partly = inv({ amount_paid_cents: 6000 });
    expect(isPartiallyPaid(partly)).toBe(true);
    expect(invoiceOutstandingCents(partly)).toBe(2000);
    expect(isPartiallyPaid(inv())).toBe(false);
    expect(isPartiallyPaid(inv({ status: "paid", amount_paid_cents: 8000 }))).toBe(false);
    expect(invoiceOutstandingCents(inv({ status: "paid", amount_paid_cents: 8000 }))).toBe(0);
  });

  it("puts the real figure into the AR totals", () => {
    const ar = summarizeAr(
      [inv({ amount_paid_cents: 6000 }), inv({ total_cents: 4000 }), inv({ status: "paid" })],
      "2026-10-15",
    );
    expect(ar.arOpenCents).toBe(2000 + 4000);
    expect(ar.openCount).toBe(2);
  });

  it("dates a partial payment for a point-in-time balance", () => {
    const tz = "America/Chicago";
    const partly = {
      ...inv({ amount_paid_cents: 6000 }),
      issued_at: "2026-09-01T15:00:00Z",
      paymentsAsOf: [{ amount_cents: 6000, paid_at: "2026-09-20T15:00:00Z" }],
    };
    expect(outstandingAsOf(partly, "2026-09-10", tz)).toBe(8000);
    expect(outstandingAsOf(partly, "2026-09-30", tz)).toBe(2000);
    // Paid off later in two parts: owed the rest between them, nothing after.
    const settled = {
      ...partly,
      status: "paid",
      paid_at: "2026-10-05T15:00:00Z",
      paymentsAsOf: [
        ...partly.paymentsAsOf,
        { amount_cents: 2000, paid_at: "2026-10-05T15:00:00Z" },
      ],
    };
    expect(outstandingAsOf(settled, "2026-09-30", tz)).toBe(2000);
    expect(outstandingAsOf(settled, "2026-10-06", tz)).toBe(0);
    // Without dated payments, an open invoice uses the live column.
    expect(outstandingAsOf({ ...partly, paymentsAsOf: undefined }, "2026-10-15", tz)).toBe(2000);
  });

  it("is what every Stripe and reminder path charges or asks for", () => {
    for (const f of [
      "src/lib/invoices.functions.ts",
      "src/lib/invoice-reconcile.server.ts",
      "src/routes/api/public/hooks/nightly.ts",
      "src/lib/field-collections.functions.ts",
    ]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).toContain("invoiceDueCents(");
      expect(src, f).not.toMatch(
        /total_cents \?\? 0\) - \(\w+\.credit_applied_cents \?\? 0\), 0\)/,
      );
    }
  });
});

describe("the amount an owner types", () => {
  it("reads dollars as typed", () => {
    expect(parsePaymentAmount("60")).toBe(6000);
    expect(parsePaymentAmount("$1,060.5")).toBe(106050);
    expect(parsePaymentAmount(".75")).toBe(75);
    expect(parsePaymentAmount("60.123")).toBeNull();
    expect(parsePaymentAmount("sixty")).toBeNull();
  });

  it("allows less than the balance and refuses more, in the database's words", () => {
    expect(paymentAmountProblem(6000, 8000)).toBeNull();
    expect(paymentAmountProblem(8000, 8000)).toBeNull();
    expect(paymentAmountProblem(8001, 8000)).toBe(
      "That is more than the $80.00 still owed on this invoice.",
    );
    expect(paymentAmountProblem(0, 8000)).toBe("Enter an amount greater than zero.");
    expect(paymentAmountProblem(null, 8000)).toBe("Enter an amount greater than zero.");
    expect(sql).toContain("'That is more than the % still owed on this invoice'");
  });
});

describe("cash collected in the field", () => {
  it("goes oldest first and pays the last one in part (A-02's $60 against $40 + $40)", () => {
    const invs = [
      { id: "older", open_cents: 4000 },
      { id: "newer", open_cents: 4000 },
    ];
    expect(defaultInvoiceSelection(invs, 6000)).toEqual(["older", "newer"]);
    const r = allocateOldestFirst(invs, ["newer", "older"], 6000);
    expect(r.allocations).toEqual([
      { id: "older", cents: 4000, partial: false },
      { id: "newer", cents: 2000, partial: true },
    ]);
    expect(r.appliedCents).toBe(6000);
    expect(r.unappliedCents).toBe(0);
    expect(r.starved).toEqual([]);
  });

  it("no longer skips the older invoice for newer ones that happen to fit", () => {
    // The fixture QA saw: $40 against $25, $30, $15 settled $25 + $15 and left
    // the older $30 alone. Oldest first, the $30 takes the $15 left.
    const invs = [
      { id: "a", open_cents: 2500 },
      { id: "b", open_cents: 3000 },
      { id: "c", open_cents: 1500 },
    ];
    expect(defaultInvoiceSelection(invs, 4000)).toEqual(["a", "b"]);
    const r = allocateOldestFirst(invs, ["a", "b"], 4000);
    expect(r.allocations[1]).toEqual({ id: "b", cents: 1500, partial: true });
    expect(r.unappliedCents).toBe(0);
  });

  it("flags a ticked invoice the money never reaches, and leaves extra cash unapplied", () => {
    const invs = [
      { id: "a", open_cents: 2000 },
      { id: "b", open_cents: 3000 },
    ];
    expect(allocateOldestFirst(invs, ["a", "b"], 1000).starved).toEqual(["b"]);
    const over = allocateOldestFirst(invs, ["a"], 5000);
    expect(over.appliedCents).toBe(2000);
    expect(over.unappliedCents).toBe(3000);
  });
});

describe("the Record payment dialog", () => {
  vi.mock("@/components/ui/dialog", () => {
    const pass = ({ children }: any) => createElement("div", null, children);
    return {
      Dialog: ({ open, children }: any) => (open ? createElement("div", null, children) : null),
      DialogContent: pass,
      DialogDescription: ({ children }: any) => createElement("div", null, children),
      DialogFooter: pass,
      DialogHeader: pass,
      DialogTitle: pass,
    };
  });
  vi.mock("@/hooks/useOrgToday", () => ({
    useOrgToday: () => "2026-10-15",
    useOrgTimezone: () => "America/Chicago",
  }));

  async function render(opts: Record<string, unknown>) {
    vi.stubGlobal("React", React);
    const { useRecordPaymentDialog } = await import("@/components/RecordPaymentDialog");
    // Asked during render: a render-phase update re-renders this component
    // with the dialog open, which is the frame worth looking at.
    function Harness() {
      const { ask, dialog } = useRecordPaymentDialog();
      const asked = useRef(false);
      if (!asked.current) {
        asked.current = true;
        void ask({ amountLine: "x", ...opts } as any);
      }
      return dialog;
    }
    return renderToStaticMarkup(createElement(Harness));
  }

  it("has an amount field that starts at the open balance", async () => {
    const html = await render({ balanceCents: 8000 });
    expect(html).toMatch(/id="record-payment-amount"[^>]*value="80.00"/);
    expect(html).toContain("The full balance is $80.00. Enter less for a partial payment.");
  });

  it("has no amount for several invoices at once", async () => {
    const html = await render({ title: "Record 3 payments" });
    expect(html).not.toContain("record-payment-amount");
  });

  it("sends the amount to the server, which takes it for one invoice only", () => {
    const fn = readFileSync(join(ROOT, "src/lib/invoices.functions.ts"), "utf8");
    expect(fn).toContain('supabase.rpc("record_invoice_payment"');
    expect(fn).toContain("_amount_cents: data.amountCents ?? undefined");
    expect(fn).toContain("An amount can only be recorded against one invoice at a time");
    for (const f of [
      "src/components/InvoiceDrawer.tsx",
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      "src/routes/_authenticated/invoices.index.tsx",
    ]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/balanceCents: (dueCents|due|owed)/);
    }
  });
});

// ── The database half ────────────────────────────────────────────────────────

function findPsql(): string | null {
  for (const p of [process.env.PSQL, "psql", "/usr/bin/psql", "/usr/local/bin/psql"]) {
    if (!p) continue;
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
    timeout: 30_000,
  }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(
    `\n  SKIPPED: the partial-payment proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set PARTIAL_PAYMENT_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the partial-payment rules hold in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const args = [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF];
    let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
    for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
      r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
    }
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL PARTIAL PAYMENT PROOFS PASSED/);
    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Partial Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  }, 600_000);
});
