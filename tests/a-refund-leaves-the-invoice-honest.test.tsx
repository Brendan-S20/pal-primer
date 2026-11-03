/* eslint-disable @typescript-eslint/no-explicit-any -- a fake database client */
// A refund leaves the invoice honest (#674), and the signup it paid for
// says so too (#675).
//
// E1 smoke, 2026-11-01: INV-1069 was refunded in full from the invoice. The
// payment went to 'refunded' and amount_paid_cents to 0, but the invoice still
// said Paid, and the provisioned signup it paid for kept stripe_refund_id,
// refunded_at and refunded_amount_cents null. A partial refund was worse: it
// took the WHOLE payment off what the invoice was paid.
//
// Here: the arithmetic the webhook writes, the patch it puts on the signup,
// the label every invoice screen reads, the migration's shape, and the order
// the webhook writes in.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => "2026-11-02",
  useOrgTimezone: () => "America/New_York",
}));

import {
  invoicedShareRefunded,
  invoiceRefundState,
  invoiceStatusChip,
  signupRefundPatch,
} from "@/lib/refund-outcome";
import { recordRefundOnPayment, recordRefundOnSignup } from "@/lib/refund-outcome.server";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { InvoiceCard, type InvoiceRowData } from "@/components/InvoiceRow";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/20261102130000_a-refund-leaves-the-invoice-honest.sql");
const HOOK = read("src/routes/api/public/hooks/stripe.ts");

describe("what a refund takes off the invoice", () => {
  it("is the whole amount when the whole charge went back", () => {
    expect(invoicedShareRefunded(6000, { amount_cents: 6000 })).toBe(6000);
    // Surcharge and tip went back too, but only amount_cents was ever applied.
    expect(
      invoicedShareRefunded(11800, { amount_cents: 10000, surcharge_cents: 300, tip_cents: 1500 }),
    ).toBe(10000);
  });

  it("is the invoiced share of a partial, not the payment", () => {
    expect(invoicedShareRefunded(1000, { amount_cents: 10000 })).toBe(1000);
    // $103 charged ($3 surcharge), $51.50 back: $50 of it was the invoice.
    expect(invoicedShareRefunded(5150, { amount_cents: 10000, surcharge_cents: 300 })).toBe(5000);
    // Tax sits inside amount_cents, so its share comes off the invoice too.
    expect(invoicedShareRefunded(5400, { amount_cents: 10800, tax_cents: 800 })).toBe(5400);
  });

  it("is nothing when nothing went back", () => {
    expect(invoicedShareRefunded(0, { amount_cents: 6000 })).toBe(0);
    expect(invoicedShareRefunded(500, { amount_cents: 0 })).toBe(0);
  });
});

describe("the label on a paid invoice", () => {
  const paid = { status: "paid", amount_paid_cents: 6000, amount_refunded_cents: 0 };

  it("is Paid when the money was kept", () => {
    expect(invoiceRefundState(paid)).toBeNull();
    expect(invoiceStatusChip(paid)).toEqual({ status: "paid" });
  });

  it("is Refunded when all of it went back (INV-1069)", () => {
    const inv = { ...paid, amount_paid_cents: 0, amount_refunded_cents: 6000 };
    expect(invoiceRefundState(inv)).toBe("refunded");
    expect(invoiceStatusChip(inv).label).toBe("Refunded");
  });

  it("is Partly refunded when some went back", () => {
    const inv = { ...paid, amount_paid_cents: 5000, amount_refunded_cents: 1000 };
    expect(invoiceRefundState(inv)).toBe("partly_refunded");
    expect(invoiceStatusChip(inv).label).toBe("Partly refunded");
  });

  it("is untouched on an invoice that is not paid, or on a column not loaded", () => {
    expect(invoiceRefundState({ status: "open", amount_refunded_cents: 1000 })).toBeNull();
    expect(invoiceRefundState({ status: "paid", amount_paid_cents: 0 })).toBeNull();
  });

  it("is what the badge and the list card draw", () => {
    expect(renderToStaticMarkup(<InvoiceStatusBadge status="paid" refund="refunded" />)).toContain(
      ">Refunded<",
    );
    expect(renderToStaticMarkup(<InvoiceStatusBadge status="paid" />)).toContain(">Paid<");

    const card: InvoiceRowData = {
      id: "16000000-0000-4000-8000-000000000674",
      status: "paid",
      kind: "prepaid_topup",
      currency: "usd",
      total_cents: 6000,
      credit_applied_cents: 0,
      amount_paid_cents: 0,
      amount_refunded_cents: 6000,
      period_start: null,
      period_end: null,
      due_on: null,
      clients: { display_name: "Riverbend Customer" },
    };
    const html = renderToStaticMarkup(<InvoiceCard invoice={card} onOpen={() => {}} />);
    expect(html).toContain(">Refunded<");
    expect(html).not.toContain(">Paid<");
  });
});

describe("the signup a refunded payment bought (#675)", () => {
  const provisioned = {
    status: "provisioned",
    refunded_at: null,
    stripe_refund_id: null,
    refunded_amount_cents: null,
  };
  const at = "2026-11-01T22:32:00.000Z";

  it("records the refund on a provisioned signup", () => {
    expect(
      signupRefundPatch(provisioned, { refundId: "re_1", amountRefundedCents: 6000, at }),
    ).toEqual({ refunded_at: at, stripe_refund_id: "re_1", refunded_amount_cents: 6000 });
  });

  it("leaves a failed or pending signup to provisionSignup", () => {
    for (const status of ["failed", "pending", "paid"]) {
      expect(
        signupRefundPatch(
          { ...provisioned, status },
          { refundId: "re_1", amountRefundedCents: 6000, at },
        ),
      ).toBeNull();
    }
    expect(signupRefundPatch(null, { refundId: "re_1", amountRefundedCents: 6000, at })).toBeNull();
  });

  it("raises the amount on a second partial and keeps the first day", () => {
    const first = {
      ...provisioned,
      refunded_at: at,
      stripe_refund_id: "re_1",
      refunded_amount_cents: 1000,
    };
    expect(
      signupRefundPatch(first, {
        refundId: "re_2",
        amountRefundedCents: 2500,
        at: "2026-11-02T10:00:00.000Z",
      }),
    ).toEqual({ refunded_at: at, stripe_refund_id: "re_2", refunded_amount_cents: 2500 });
    // An older event arriving late does not lower it.
    expect(
      signupRefundPatch(
        { ...first, refunded_amount_cents: 2500 },
        { refundId: "re_1", amountRefundedCents: 1000, at },
      ),
    ).toBeNull();
  });

  it("undoes it when Stripe says the refund failed", () => {
    const done = {
      ...provisioned,
      refunded_at: at,
      stripe_refund_id: "re_1",
      refunded_amount_cents: 6000,
    };
    expect(
      signupRefundPatch(done, { refundId: null, amountRefundedCents: 0, at, authoritative: true }),
    ).toEqual({ refunded_at: null, stripe_refund_id: null, refunded_amount_cents: null });
    // A non-authoritative zero is not news.
    expect(signupRefundPatch(done, { refundId: null, amountRefundedCents: 0, at })).toBeNull();
  });
});

/** A fake supabase client that records each chain it is asked to run. */
function fakeDb(rows: Record<string, any> = {}) {
  const calls: Array<{ table: string; op: string; args: any[] }> = [];
  const from = (table: string) => {
    const chain: any = {};
    const log =
      (op: string) =>
      (...args: any[]) => {
        calls.push({ table, op, args });
        return chain;
      };
    for (const op of ["select", "update", "eq", "lt", "limit"]) chain[op] = log(op);
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    chain.then = (res: any) => res({ data: null, error: null });
    return chain;
  };
  return { db: { from }, calls };
}

describe("the webhook's writes", () => {
  it("only raises refunded_cents on a charge.refunded, and replaces it on a re-read", async () => {
    const a = fakeDb();
    expect(await recordRefundOnPayment(a.db, { id: "p1", amount_cents: 6000 }, 6000)).toBe(6000);
    expect(a.calls).toContainEqual({
      table: "payments",
      op: "update",
      args: [{ refunded_cents: 6000 }],
    });
    expect(a.calls).toContainEqual({ table: "payments", op: "lt", args: ["refunded_cents", 6000] });

    const b = fakeDb();
    await recordRefundOnPayment(b.db, { id: "p1", amount_cents: 6000 }, 0, { authoritative: true });
    expect(b.calls).toContainEqual({
      table: "payments",
      op: "update",
      args: [{ refunded_cents: 0 }],
    });
    expect(b.calls.some((c) => c.op === "lt")).toBe(false);
  });

  it("writes the three signup columns for the provisioned signup with that payment intent", async () => {
    const { db, calls } = fakeDb({
      signup_requests: {
        id: "5c4ad3aa-8785-4184-a570-93305c72ad8f",
        status: "provisioned",
        refunded_at: null,
        stripe_refund_id: null,
        refunded_amount_cents: null,
      },
    });
    const patch = await recordRefundOnSignup(
      db,
      { organizationId: "org", paymentIntentId: "pi_3UXBtRH7o0ny3UiP0bGFRa7z" },
      { refundId: "re_1", amountRefundedCents: 6000, at: "2026-11-01T22:32:00.000Z" },
    );
    expect(patch).toEqual({
      refunded_at: "2026-11-01T22:32:00.000Z",
      stripe_refund_id: "re_1",
      refunded_amount_cents: 6000,
    });
    expect(calls).toContainEqual({
      table: "signup_requests",
      op: "eq",
      args: ["stripe_payment_intent_id", "pi_3UXBtRH7o0ny3UiP0bGFRa7z"],
    });
    expect(calls).toContainEqual({
      table: "signup_requests",
      op: "eq",
      args: ["organization_id", "org"],
    });
    expect(calls).toContainEqual({ table: "signup_requests", op: "update", args: [patch] });
  });

  it("writes refunded_cents before the status flips, in both refund branches", () => {
    const refunded = HOOK.indexOf(
      'if (event.type === "charge.refunded") {\n                // How much',
    );
    expect(refunded).toBeGreaterThan(0);
    const branch = HOOK.slice(refunded, refunded + 3000);
    expect(branch.indexOf("recordRefundOnPayment(")).toBeGreaterThan(0);
    expect(branch.indexOf("recordRefundOnPayment(")).toBeLessThan(
      branch.indexOf('.update({ status: "refunded" })'),
    );
    expect(branch).toContain("recordRefundOnSignup(");

    const updated = HOOK.indexOf('event.type === "charge.refund.updated"');
    const reread = HOOK.slice(updated, HOOK.indexOf('if (refund?.status === "failed"', updated));
    expect(reread).toMatch(
      /recordRefundOnPayment\(supabaseAdmin, rpay, trueRefunded, \{\s*authoritative: true/,
    );
    expect(reread).toContain("recordRefundOnSignup(");
  });
});

describe("the migration, read", () => {
  it("adds both columns, non-negative", () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.payments\s+ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0/,
    );
    expect(MIGRATION).toMatch(/CHECK \(refunded_cents >= 0\)/);
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.invoices\s+ADD COLUMN IF NOT EXISTS amount_refunded_cents integer NOT NULL DEFAULT 0/,
    );
    expect(MIGRATION).toMatch(/CHECK \(amount_refunded_cents >= 0\)/);
  });

  it("keeps the unrefunded part of a refunded payment, and none of an unknown one", () => {
    expect(MIGRATION).toContain("WHEN p.status = 'succeeded' THEN p.amount_cents");
    expect(MIGRATION).toMatch(
      /WHEN p\.status = 'refunded' AND p\.refunded_cents > 0\s+THEN GREATEST\(p\.amount_cents - p\.refunded_cents, 0\)/,
    );
  });

  it("re-syncs on refunded_cents and guards the new invoice column", () => {
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER payments_sync_invoice_paid\s+AFTER INSERT OR DELETE OR UPDATE OF status, amount_cents, invoice_id, refunded_cents ON public\.payments/,
    );
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER invoices_guard_amount_paid\s+BEFORE INSERT OR UPDATE OF amount_paid_cents, amount_refunded_cents ON public\.invoices/,
    );
    expect(MIGRATION).toContain("NEW.amount_refunded_cents := OLD.amount_refunded_cents;");
  });

  it("does not change an invoice's status: a refund is a contra line, not a void", () => {
    const code = MIGRATION.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/SET\s+status\s*=/i);
    expect(code).not.toMatch(/'void'/);
  });

  it("replays into an empty database", () => {
    const code = MIGRATION.replace(/--[^\n]*/g, "");
    // Nothing that needs a cron job, and no row-count assertion that a fresh
    // build could not satisfy: the disagreement count only warns.
    expect(code).not.toMatch(/cron\./);
    expect(code).not.toMatch(/pg_get_functiondef/);
    expect(code).toMatch(/RAISE WARNING '% invoice\(s\) disagree/);
    const off = code.indexOf("DISABLE TRIGGER touch_invoices");
    const on = code.indexOf("ENABLE TRIGGER touch_invoices");
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
  });
});
