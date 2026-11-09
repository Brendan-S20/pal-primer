// A refund the first event missed still lands (#674, #675).
//
// #698 taught the Stripe webhook to write payments.refunded_cents and the
// three signup_requests refund columns. Three gaps were left, and each one
// leaves the issue's symptom in place for good:
//
//   1. `charge.refund.updated` IS the refund and knows its id, yet it passed
//      `refundId: null`, and the signup patch would not write an id once the
//      amount was already recorded. So when charge.refunded could not learn
//      the id (the charge's refund list failed or came back empty), or
//      arrived after the update had already recorded the amount,
//      stripe_refund_id stayed NULL with nothing left that could fill it.
//
//   2. `charge.refund.updated` wrote refunded_cents on a payment still
//      'succeeded' (charge.refunded not yet landed, or missed) and left the
//      status alone. invoice_paid_cents counts a succeeded payment whole and
//      invoice_refunded_cents only counts refunded ones, so the invoice read
//      Paid in full with the money back with the customer.
//
//   3. 20261102130000 backfilled payments but no signup_requests, so E1's
//      own signup (5c4ad3aa, refunded 2026-11-01) keeps three NULLs for good.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  invoiceRefundState,
  paymentStatusAfterReread,
  refundIdFromReread,
  signupRefundPatch,
} from "@/lib/refund-outcome";
import { recordRefundOnSignup } from "@/lib/refund-outcome.server";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const HOOK = read("src/routes/api/public/hooks/stripe.ts");
const BACKFILL = read(
  "supabase/migrations/20261109120000_a-signup-refunded-before-the-fix-says-so.sql",
);

const at = "2026-11-01T22:32:00.000Z";
const later = "2026-11-01T22:33:10.000Z";
/** E1's signup after charge.refunded recorded the amount but found no id. */
const amountNoId = {
  status: "provisioned",
  refunded_at: at,
  stripe_refund_id: null,
  refunded_amount_cents: 6000,
};

describe("the signup's refund id (#675)", () => {
  it("is written by charge.refund.updated when charge.refunded could not find it", () => {
    expect(
      signupRefundPatch(amountNoId, {
        refundId: "re_E1",
        amountRefundedCents: 6000,
        at: later,
        authoritative: true,
      }),
    ).toEqual({ refunded_at: at, stripe_refund_id: "re_E1", refunded_amount_cents: 6000 });
  });

  it("is written by a later charge.refunded that carries it, at the same amount", () => {
    expect(
      signupRefundPatch(amountNoId, { refundId: "re_E1", amountRefundedCents: 6000, at: later }),
    ).toEqual({ refunded_at: at, stripe_refund_id: "re_E1", refunded_amount_cents: 6000 });
  });

  it("is filled by an older event without lowering the amount it carries", () => {
    expect(
      signupRefundPatch(
        { ...amountNoId, refunded_amount_cents: 2500 },
        { refundId: "re_first", amountRefundedCents: 1000, at: later },
      ),
    ).toEqual({ refunded_at: at, stripe_refund_id: "re_first", refunded_amount_cents: 2500 });
  });

  it("is not replaced, and nothing is written, when the row already has one", () => {
    expect(
      signupRefundPatch(
        { ...amountNoId, stripe_refund_id: "re_E1" },
        { refundId: "re_E1", amountRefundedCents: 6000, at: later, authoritative: true },
      ),
    ).toBeNull();
  });

  it("is the refund a charge.refund.updated is about, unless that refund failed", () => {
    expect(refundIdFromReread({ id: "re_E1", status: "succeeded" })).toBe("re_E1");
    expect(refundIdFromReread({ id: "re_E1", status: "pending" })).toBe("re_E1");
    expect(refundIdFromReread({ id: "re_E1", status: "failed" })).toBeNull();
    expect(refundIdFromReread({ id: "re_E1", status: "canceled" })).toBeNull();
    expect(refundIdFromReread(null)).toBeNull();
    expect(refundIdFromReread({ status: "succeeded" })).toBeNull();
  });

  it("reaches the database through recordRefundOnSignup", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "update", "eq", "limit"]) {
      chain[op] = (...args: unknown[]) => {
        calls.push({ op, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: { id: "5c4ad3aa", ...amountNoId }, error: null });
    chain.then = (res: (v: unknown) => void) => res({ data: null, error: null });
    const db = { from: () => chain } as never;

    const patch = await recordRefundOnSignup(
      db,
      { organizationId: "342d4d1e", paymentIntentId: "pi_3UXBtRH7o0ny3UiP0bGFRa7z" },
      {
        refundId: refundIdFromReread({ id: "re_E1", status: "succeeded" }),
        amountRefundedCents: 6000,
        at: later,
        authoritative: true,
      },
    );
    expect(patch?.stripe_refund_id).toBe("re_E1");
    expect(calls).toContainEqual({ op: "update", args: [patch] });
  });
});

describe("the payment's status after Stripe is re-read (#674)", () => {
  it("becomes refunded when money went back on a payment still marked succeeded", () => {
    expect(paymentStatusAfterReread("succeeded", 6000)).toBe("refunded");
    expect(paymentStatusAfterReread("succeeded", 1)).toBe("refunded");
  });

  it("returns to succeeded when the refund failed back to nothing", () => {
    expect(paymentStatusAfterReread("refunded", 0)).toBe("succeeded");
  });

  it("is left alone when it already agrees, or was set by something else", () => {
    expect(paymentStatusAfterReread("refunded", 6000)).toBeNull();
    expect(paymentStatusAfterReread("succeeded", 0)).toBeNull();
    expect(paymentStatusAfterReread("pending", 6000)).toBeNull();
    expect(paymentStatusAfterReread("failed", 0)).toBeNull();
  });

  it("is what turns INV-1069 from Paid into Refunded when only the re-read landed", () => {
    // invoice_paid_cents / invoice_refunded_cents (20261102160000), in
    // TypeScript, for one $60 payment refunded in full.
    const invoiceFor = (status: string, refundedCents: number) => {
      const amount = 6000;
      const paid =
        status === "succeeded"
          ? amount
          : status === "refunded" && refundedCents > 0
            ? Math.max(amount - refundedCents, 0)
            : 0;
      const refunded = status === "refunded" && refundedCents > 0 ? refundedCents : 0;
      return { status: "paid", amount_paid_cents: paid, amount_refunded_cents: refunded };
    };
    // Before: refunded_cents written, status left 'succeeded'. Reads as Paid.
    expect(invoiceRefundState(invoiceFor("succeeded", 6000))).toBeNull();
    // After: the status follows the re-read.
    const next = paymentStatusAfterReread("succeeded", 6000) ?? "succeeded";
    expect(invoiceRefundState(invoiceFor(next, 6000))).toBe("refunded");
  });
});

describe("the webhook's charge.refund.updated branch", () => {
  const start = HOOK.indexOf('event.type === "charge.refund.updated"');
  const branch = HOOK.slice(start, HOOK.indexOf('if (refund?.status === "failed"', start));

  it("hands the signup the refund it is about, not null", () => {
    expect(start).toBeGreaterThan(0);
    expect(branch).toContain("refundId: refundIdFromReread(refund)");
    expect(branch).not.toMatch(/refundId:\s*null/);
  });

  it("reads the payment's status and moves it both ways, after refunded_cents", () => {
    expect(branch).toMatch(/\.select\(\s*"[^"]*\bstatus\b[^"]*"/);
    const write = branch.indexOf("recordRefundOnPayment(");
    const flip = branch.indexOf("paymentStatusAfterReread(rpay.status, trueRefunded)");
    expect(write).toBeGreaterThan(0);
    expect(flip).toBeGreaterThan(write);
    // Compare-and-set, so a concurrent charge.refunded is not overwritten.
    expect(branch.slice(flip)).toMatch(/\.eq\("status", rpay\.status\)/);
    expect(branch).not.toMatch(/if \(trueRefunded <= 0\) \{/);
  });
});

describe("the signup backfill, read", () => {
  const sql = BACKFILL.replace(/--.*$/gm, "");

  it("writes the two columns the ledger knows, and never invents a refund id", () => {
    expect(sql).toMatch(/UPDATE public\.signup_requests/);
    expect(sql).toMatch(/refunded_at\s*=\s*r\.first_refunded_at/);
    expect(sql).toMatch(/refunded_amount_cents\s*=/);
    expect(sql).not.toMatch(/stripe_refund_id\s*=/);
  });

  it("matches as the webhook does and touches only rows nobody wrote", () => {
    expect(sql).toMatch(/sr\.organization_id\s*=\s*r\.organization_id/);
    expect(sql).toMatch(/sr\.stripe_payment_intent_id\s*=\s*r\.stripe_payment_intent_id/);
    expect(sql).toMatch(/sr\.status\s*=\s*'provisioned'/);
    expect(sql).toMatch(/sr\.refunded_at IS NULL/);
    expect(sql).toMatch(/ri\.kind\s*=\s*'payment_refunded'/);
  });

  it("replays into an empty database: no assertion on rows", () => {
    expect(sql).not.toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/RAISE WARNING/);
  });
});
