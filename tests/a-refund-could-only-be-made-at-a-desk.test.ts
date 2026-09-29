// The only way to refund a customer was Stripe's embedded Payments panel on
// /payments, and on a coarse pointer that panel is replaced by NotOnAPhone —
// on purpose, its controls are too small to hit. So an owner in a driveway with
// a phone could not give anybody their money back. Refund now lives on the
// invoice, where the money came in.
//
// Moving money is the one thing in this product where a wrong answer cannot be
// taken back, so these pin the rules rather than the happy path:
//
//   - what is refused (a cash payment, more than is left, another org's
//     payment, a payment already refunded in full) — and that a refusal
//     never reaches Stripe;
//   - the exact shape of the Stripe call: a DIRECT-charge refund on the
//     connected account, no fee flag, no transfer reversal;
//   - the idempotency key, including the double tap that lands AFTER the first
//     refund finished, which a key built from Stripe's refunded total gets
//     wrong;
//   - that nothing here writes the ledger — the webhook does, once;
//   - who is shown the button.
//
// No test here can reach Stripe: the environment is passed in, and the fake
// below is the whole of it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RefundRefused,
  issueRefund,
  quoteRefund,
  refundIdempotencyKey,
  refundedCentsByPayment,
  type RefundEnv,
} from "@/lib/refunds.server";
import {
  REFUND_PERMISSION,
  REFUND_REASONS,
  canOfferRefund,
  parseRefundAmount,
  stripeRefundReason,
} from "@/lib/refunds";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comment lines stripped, so an assertion about CODE cannot be satisfied by
 *  the prose around it — refunds.server.ts explains at length what it does not
 *  do, in exactly the words these tests look for. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

const ORG = "3f1d9a52-1c6e-4b7a-9d0e-2a4b6c8d0e11";
const OTHER_ORG = "8c2e4f60-7a1b-4c3d-8e5f-6a7b8c9d0e22";
const PAY = "5b7c9d1e-3f5a-4b7c-9d1e-3f5a7b9c1d33";
const INV = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c44";
const USER = "d4c3b2a1-6f5e-4b7a-8d9c-4e3f2a1b0c55";
const ATTEMPT = "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e66";

type PaymentRow = Record<string, unknown>;

/** A $100 invoice charged $103 with a $3 surcharge, on a card. */
function cardPayment(over: PaymentRow = {}): PaymentRow {
  return {
    id: PAY,
    organization_id: ORG,
    invoice_id: INV,
    amount_cents: 10000,
    surcharge_cents: 300,
    currency: "usd",
    status: "succeeded",
    method: null,
    stripe_payment_intent_id: "pi_1",
    ...over,
  };
}

/**
 * A database that answers reads and records every write attempt.
 *
 * `rls: true` behaves like the caller's RLS client: `.eq()` filters are
 * honoured, so a row in another org is simply not returned. `rls: false`
 * ignores filters and returns the row whatever was asked — the shape of a
 * mistake where somebody passes the service-role client in. The code must
 * refuse in both.
 */
function fakeDb(
  rows: { payments?: PaymentRow[]; invoices?: PaymentRow[]; review_items?: PaymentRow[] },
  rls = true,
) {
  const writes: string[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    const data = () =>
      ((rows as any)[table] ?? []).filter(
        (r: any) =>
          !rls ||
          (filters.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k]))),
      );
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      in: (k: string, vs: unknown[]) => (ins.push([k, vs]), b),
      maybeSingle: () => Promise.resolve({ data: data()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: data(), error: null }).then(res, rej),
      insert: () => (writes.push(`insert ${table}`), b),
      update: () => (writes.push(`update ${table}`), b),
      upsert: () => (writes.push(`upsert ${table}`), b),
      delete: () => (writes.push(`delete ${table}`), b),
    };
    return b;
  };
  return {
    client: {
      from,
      rpc: (fn: string) => (writes.push(`rpc ${fn}`), Promise.resolve({ data: null })),
    },
    writes,
  };
}

/**
 * Stripe, as far as a refund needs it — including the part that matters most
 * here: an idempotency key it has seen before returns the refund it already
 * made and moves no money.
 */
function fakeStripe(
  charge: { amount: number; amount_refunded?: number; status?: string; refunded?: boolean },
  opts: { missing?: boolean } = {},
) {
  const state = { refunded: charge.amount_refunded ?? 0 };
  const byKey = new Map<string, { id: string; amount: number; status: string }>();
  const retrieves: any[] = [];
  const creates: { params: any; opts: any }[] = [];
  const stripe = {
    paymentIntents: {
      async retrieve(id: string, params: any, o: any) {
        retrieves.push({ id, params, opts: o });
        if (opts.missing) {
          throw Object.assign(new Error(`No such payment_intent: '${id}'`), {
            code: "resource_missing",
          });
        }
        return {
          id,
          status: "succeeded",
          latest_charge: {
            id: "ch_1",
            amount: charge.amount,
            amount_refunded: state.refunded,
            refunded: charge.refunded ?? state.refunded >= charge.amount,
            status: charge.status ?? "succeeded",
            currency: "usd",
          },
        };
      },
    },
    refunds: {
      async create(params: any, o: any) {
        creates.push({ params, opts: o });
        const seen = byKey.get(o.idempotencyKey);
        if (seen) return seen;
        state.refunded += params.amount;
        const r = { id: `re_${byKey.size + 1}`, amount: params.amount, status: "succeeded" };
        byKey.set(o.idempotencyKey, r);
        return r;
      },
    },
  };
  return { stripe, state, retrieves, creates };
}

function env(
  db: ReturnType<typeof fakeDb>,
  s: ReturnType<typeof fakeStripe>,
  account: string | null = "acct_tenant",
): RefundEnv {
  return {
    supabase: db.client,
    stripe: s.stripe as any,
    accountFor: async (orgId) => (orgId === ORG ? account : null),
  };
}

const caller = { orgId: ORG, userId: USER };

async function refusal(p: Promise<unknown>): Promise<RefundRefused> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RefundRefused);
    return e as RefundRefused;
  }
  throw new Error("expected a refusal, and the refund went through");
}

describe("what is refused, and that a refusal never reaches Stripe", () => {
  it("a cash payment: nothing went through Stripe, so there is nothing to refund", async () => {
    const db = fakeDb({
      payments: [cardPayment({ method: "cash", stripe_payment_intent_id: null })],
    });
    const s = fakeStripe({ amount: 10300 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }),
    );
    expect(e.message).toMatch(/recorded by hand/);
    expect(s.retrieves).toHaveLength(0);
    expect(s.creates).toHaveLength(0);
  });

  it("a check that somebody typed a payment-intent-looking reference against is still a check", async () => {
    // The method is what says how the money came in. A manual row carrying a
    // stray intent id must not become refundable by accident.
    const db = fakeDb({
      payments: [cardPayment({ method: "check", stripe_payment_intent_id: "pi_1" })],
    });
    const s = fakeStripe({ amount: 10300 });
    await refusal(issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }));
    expect(s.creates).toHaveLength(0);
  });

  it("a payment with no Stripe charge on record", async () => {
    const db = fakeDb({ payments: [cardPayment({ stripe_payment_intent_id: null })] });
    const s = fakeStripe({ amount: 10300 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }),
    );
    expect(e.message).toMatch(/no Stripe charge/);
    expect(s.creates).toHaveLength(0);
  });

  it("a failed or pending payment", async () => {
    for (const status of ["failed", "pending"]) {
      const db = fakeDb({ payments: [cardPayment({ status })] });
      const s = fakeStripe({ amount: 10300 });
      await refusal(issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }));
      expect(s.creates).toHaveLength(0);
    }
  });

  it("more than is left, reading the refunded total from STRIPE rather than any local column", async () => {
    // $30 already back. The local row says `refunded` (the webhook sets that on
    // the first partial) and carries no figure at all — only Stripe knows $73
    // is left.
    const db = fakeDb({ payments: [cardPayment({ status: "refunded" })] });
    const s = fakeStripe({ amount: 10300, amount_refunded: 3000 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, amountCents: 7301, attemptId: ATTEMPT }),
    );
    expect(e.message).toContain("$73.00");
    expect(e.message).toContain("$30.00");
    expect(s.creates).toHaveLength(0);
  });

  it("more than was ever charged, on a payment with no refunds yet", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, amountCents: 10301, attemptId: ATTEMPT }),
    );
    expect(e.message).toContain("$103.00");
    expect(s.creates).toHaveLength(0);
  });

  it("a payment already refunded in full", async () => {
    const db = fakeDb({ payments: [cardPayment({ status: "refunded" })] });
    const s = fakeStripe({ amount: 10300, amount_refunded: 10300 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }),
    );
    expect(e.message).toMatch(/already been refunded in full/);
    expect(s.creates).toHaveLength(0);
  });

  it("another org's payment, through the RLS client: never seen", async () => {
    const db = fakeDb({ payments: [cardPayment({ organization_id: OTHER_ORG })] });
    const s = fakeStripe({ amount: 10300 });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }),
    );
    expect(e.message).toBe("Payment not found.");
    expect(s.retrieves).toHaveLength(0);
    expect(s.creates).toHaveLength(0);
  });

  it("another org's payment, even through a client that ignores the filter", async () => {
    // The check that decides whose money moves must not depend on which
    // client somebody passed in.
    const db = fakeDb({ payments: [cardPayment({ organization_id: OTHER_ORG })] }, false);
    const s = fakeStripe({ amount: 10300 });
    await refusal(issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }));
    expect(s.retrieves).toHaveLength(0);
    expect(s.creates).toHaveLength(0);
  });

  it("an org with no connected account", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    await refusal(issueRefund(env(db, s, null), caller, { paymentId: PAY, attemptId: ATTEMPT }));
    expect(s.creates).toHaveLength(0);
  });

  it("a charge Stripe cannot find on this account says where to look instead", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 }, { missing: true });
    const e = await refusal(
      issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT }),
    );
    expect(e.message).toMatch(/previous Stripe account/);
    expect(s.creates).toHaveLength(0);
  });

  it("the dialog's opening read refuses the same things", async () => {
    const db = fakeDb({
      payments: [cardPayment({ method: "zelle", stripe_payment_intent_id: null })],
    });
    await refusal(quoteRefund(env(db, fakeStripe({ amount: 10300 })), ORG, PAY));
  });
});

describe("the Stripe call", () => {
  it("is a direct-charge refund on the connected account, of what the office typed", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const r = await issueRefund(env(db, s), caller, {
      paymentId: PAY,
      amountCents: 4500,
      reason: "service_problem",
      note: "Gate was locked, visit missed",
      attemptId: ATTEMPT,
    });

    expect(s.retrieves).toEqual([
      { id: "pi_1", params: { expand: ["latest_charge"] }, opts: { stripeAccount: "acct_tenant" } },
    ]);
    expect(s.creates).toHaveLength(1);
    const { params, opts } = s.creates[0];
    expect(params).toEqual({
      payment_intent: "pi_1",
      amount: 4500,
      reason: "requested_by_customer",
      metadata: {
        houndstack_payment_id: PAY,
        invoice_id: INV,
        organization_id: ORG,
        refunded_by_user_id: USER,
        source: "invoice_refund",
        reason: "service_problem",
        note: "Gate was locked, visit missed",
      },
    });
    // stripeAccount is a REQUEST OPTION. In the params it would be ignored
    // and the refund would look for the intent on the platform's own account.
    expect(opts.stripeAccount).toBe("acct_tenant");
    expect(opts.idempotencyKey).toBe(refundIdempotencyKey(PAY, ATTEMPT, 4500));
    expect(r).toMatchObject({ amountCents: 4500, remainingCents: 5800, refundId: "re_1" });
  });

  it("sends neither refund_application_fee nor reverse_transfer", async () => {
    // Direct charges have no transfer to reverse, and the application fee is
    // given back by the webhook's proportional reversal — one theory, one
    // place. See the header of refunds.server.ts.
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    await issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT });
    expect(s.creates[0].params).not.toHaveProperty("refund_application_fee");
    expect(s.creates[0].params).not.toHaveProperty("reverse_transfer");
    const code = codeOnly(read("src/lib/refunds.server.ts"));
    expect(code).not.toMatch(/refund_application_fee|reverse_transfer/);
  });

  it("with no amount, refunds everything still left — surcharge included", async () => {
    // $103 charged, $30 back already: $73 is what the customer can still get,
    // and the surcharge is part of it. The amount is dollars to the customer.
    const db = fakeDb({ payments: [cardPayment({ status: "refunded" })] });
    const s = fakeStripe({ amount: 10300, amount_refunded: 3000 });
    const r = await issueRefund(env(db, s), caller, { paymentId: PAY, attemptId: ATTEMPT });
    expect(s.creates[0].params.amount).toBe(7300);
    expect(r.remainingCents).toBe(0);
  });

  it("maps the office's reason onto Stripe's three, and only sends `fraudulent` when chosen", async () => {
    expect(stripeRefundReason("requested_by_customer")).toBe("requested_by_customer");
    expect(stripeRefundReason("service_problem")).toBe("requested_by_customer");
    expect(stripeRefundReason("duplicate")).toBe("duplicate");
    expect(stripeRefundReason("fraudulent")).toBe("fraudulent");
    expect(stripeRefundReason("other")).toBeUndefined();
    expect(stripeRefundReason(undefined)).toBeUndefined();
    // Every reason the dialog offers is handled, none by accident as fraud.
    for (const r of REFUND_REASONS) {
      if (r !== "fraudulent") expect(stripeRefundReason(r)).not.toBe("fraudulent");
    }

    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    await issueRefund(env(db, s), caller, { paymentId: PAY, reason: "other", attemptId: ATTEMPT });
    expect(s.creates[0].params).not.toHaveProperty("reason");
  });

  it("writes no ledger, no payment status and no RPC — the webhook does, once", async () => {
    // charge.refunded files the reversal, the franchise adjustment, the
    // prepaid-credit reversal and the status flip. A second writer here would
    // record the same refund twice the moment the webhook landed.
    const db = fakeDb({ payments: [cardPayment()], invoices: [{ id: INV, client_id: "c1" }] });
    const logs: any[] = [];
    const e = {
      ...env(db, fakeStripe({ amount: 10300 })),
      log: async (x: any) => void logs.push(x),
    };
    await issueRefund(e, caller, { paymentId: PAY, amountCents: 1030, attemptId: ATTEMPT });
    expect(db.writes).toEqual([]);
    // It does leave a timeline entry, through the injected logger, carrying
    // the same revenue/surcharge split the webhook will file.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: "invoice.refunded",
      clientId: "c1",
      meta: { amount_cents: 1030, revenue_cents: 1000, surcharge_cents: 30 },
    });

    const code = codeOnly(read("src/lib/refunds.server.ts"));
    expect(code).not.toMatch(/file_reversal_review_item|\.rpc\(|\.insert\(|\.update\(|\.upsert\(/);
    // And the branch that DOES write it is still there.
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    const branch = hook.slice(hook.indexOf('if (event.type === "charge.refunded") {'));
    expect(branch).toContain('"file_reversal_review_item"');
  });

  it("a failed timeline write does not turn a refund that happened into an error", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const e = {
      ...env(db, s),
      log: async () => {
        throw new Error("activity_log is down");
      },
    };
    await expect(
      issueRefund(e, caller, { paymentId: PAY, attemptId: ATTEMPT }),
    ).resolves.toMatchObject({
      refundId: "re_1",
    });
  });
});

describe("a double tap is one refund", () => {
  it("the same attempt, landing after the first refund finished, moves no more money", async () => {
    // The case a key built from Stripe's refunded total gets wrong: the second
    // tap reads the NEW total, builds a new key, and a partial refund goes out
    // twice. Keyed on the dialog's attempt, it is a replay.
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const e = env(db, s);
    const first = await issueRefund(e, caller, {
      paymentId: PAY,
      amountCents: 3000,
      attemptId: ATTEMPT,
    });
    const second = await issueRefund(e, caller, {
      paymentId: PAY,
      amountCents: 3000,
      attemptId: ATTEMPT,
    });
    expect(s.creates).toHaveLength(2);
    expect(s.creates[0].opts.idempotencyKey).toBe(s.creates[1].opts.idempotencyKey);
    expect(second.refundId).toBe(first.refundId);
    expect(s.state.refunded).toBe(3000);
  });

  it("the same attempt racing itself sends the same key", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const e = env(db, s);
    await Promise.all([
      issueRefund(e, caller, { paymentId: PAY, amountCents: 3000, attemptId: ATTEMPT }),
      issueRefund(e, caller, { paymentId: PAY, amountCents: 3000, attemptId: ATTEMPT }),
    ]);
    expect(new Set(s.creates.map((c) => c.opts.idempotencyKey)).size).toBe(1);
    expect(s.state.refunded).toBe(3000);
  });

  it("a deliberate second refund, from a new dialog, is a new refund", async () => {
    const db = fakeDb({ payments: [cardPayment()] });
    const s = fakeStripe({ amount: 10300 });
    const e = env(db, s);
    await issueRefund(e, caller, { paymentId: PAY, amountCents: 3000, attemptId: ATTEMPT });
    await issueRefund(e, caller, {
      paymentId: PAY,
      amountCents: 3000,
      attemptId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c77",
    });
    expect(s.state.refunded).toBe(6000);
  });

  it("the key names the payment, the attempt and the amount — and nothing read from Stripe", () => {
    const k = refundIdempotencyKey(PAY, ATTEMPT, 3000);
    expect(k).toContain(PAY);
    expect(k).toContain(ATTEMPT);
    expect(k).toContain("3000");
    // An edited amount after a failure is a new request, not a replay with
    // different parameters (which Stripe rejects as an idempotency_error).
    expect(refundIdempotencyKey(PAY, ATTEMPT, 2999)).not.toBe(k);
  });

  it("the server function requires an attempt id, and the dialog mints one per opening", () => {
    const fns = codeOnly(read("src/lib/refunds.functions.ts"));
    expect(fns).toMatch(/attemptId:\s*z\.string\(\)\.uuid\(\)/);
    const ui = codeOnly(read("src/components/RefundPaymentAction.tsx"));
    expect(ui).toMatch(/const \[attemptId\] = useState\(newAttemptId\)/);
    // And the button that sends it cannot be pressed again while in flight.
    expect(ui).toMatch(/disabled=\{refundM\.isPending\}\s*onClick=\{\(\) => refundM\.mutate\(\)\}/);
  });
});

describe("who is shown the button", () => {
  const card = {
    status: "succeeded",
    stripe_payment_intent_id: "pi_1",
    amount_cents: 10000,
    surcharge_cents: 300,
  };

  it("the roles that can take a card payment, and no others", () => {
    expect(canOfferRefund("owner", card)).toBe(true);
    expect(canOfferRefund("office_manager", card)).toBe(true);
    expect(canOfferRefund("dispatcher", card)).toBe(false);
    expect(canOfferRefund("tech", card)).toBe(false);
    expect(canOfferRefund(null, card)).toBe(false);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(canOfferRefund(role as any, card), role).toBe(perms.includes(REFUND_PERMISSION));
    }
  });

  it("is the permission the other money-moving invoice actions ask", () => {
    // A role that can take money on an invoice can give it back, and one that
    // cannot, cannot. Read from the source so a change to one gate is seen by
    // the other.
    const src = read("src/lib/invoices.functions.ts");
    for (const fn of [
      "chargeAutopayForInvoice",
      "bulkMarkInvoicesPaid",
      "createInvoicePaymentIntent",
      "voidInvoice",
    ]) {
      const body = src
        .slice(src.indexOf(`export const ${fn} = createServerFn`))
        .split("\nexport ")[0];
      expect(body, fn).toContain(`"${REFUND_PERMISSION}"`);
    }
  });

  it("the server functions ask it themselves — the button is cosmetic", () => {
    const fns = codeOnly(read("src/lib/refunds.functions.ts"));
    for (const fn of ["getPaymentRefundQuote", "refundInvoicePayment"]) {
      const body = fns
        .slice(fns.indexOf(`export const ${fn} = createServerFn`))
        .split("\nexport ")[0];
      expect(body, fn).toContain("requireSupabaseAuth");
      expect(body, fn).toMatch(/requirePermission\(supabase, context\.userId, REFUND_PERMISSION\)/);
    }
  });

  it("not on a payment that never went through Stripe, or never went through at all", () => {
    expect(canOfferRefund("owner", { ...card, stripe_payment_intent_id: null })).toBe(false);
    expect(canOfferRefund("owner", { ...card, status: "failed" })).toBe(false);
    expect(canOfferRefund("owner", { ...card, status: "pending" })).toBe(false);
  });

  it("still on a PARTIALLY refunded payment, whose status already reads `refunded`", () => {
    expect(canOfferRefund("owner", { ...card, status: "refunded", refunded_cents: 3000 })).toBe(
      true,
    );
    // Unknown refunded figure: keep the button and let Stripe answer.
    expect(canOfferRefund("owner", { ...card, status: "refunded" })).toBe(true);
    // Everything back, surcharge included: nothing left to offer.
    expect(canOfferRefund("owner", { ...card, status: "refunded", refunded_cents: 10300 })).toBe(
      false,
    );
  });

  it("the component draws nothing unless the rule says so, on both invoice surfaces", () => {
    const ui = codeOnly(read("src/components/RefundPaymentAction.tsx"));
    const gate = ui.indexOf("if (!canOfferRefund(role, payment)) return null;");
    expect(gate).toBeGreaterThan(-1);
    expect(ui.indexOf("<Button", gate)).toBeGreaterThan(gate);
    expect(ui.slice(0, gate)).not.toContain("<Button");
    for (const f of [
      "src/routes/_authenticated/invoices.$invoiceId.tsx",
      "src/components/InvoiceDrawer.tsx",
    ]) {
      expect(read(f), f).toContain("<RefundPaymentAction");
    }
  });

  it("Stripe's panel, where a phone cannot reach, points at the invoice instead", () => {
    const src = read("src/routes/_authenticated/payments.tsx");
    expect(src).toContain('<NotOnAPhone what="Payments" refunds />');
    expect(src).toMatch(/open their invoice and press/);
  });
});

describe("the amount field", () => {
  it("reads dollars as typed, to whole cents", () => {
    expect(parseRefundAmount("45")).toBe(4500);
    expect(parseRefundAmount("45.5")).toBe(4550);
    expect(parseRefundAmount("45.50")).toBe(4550);
    expect(parseRefundAmount(" $1,045.07 ")).toBe(104507);
    expect(parseRefundAmount("0.01")).toBe(1);
  });

  it("refuses what is not an amount, including a third decimal nobody meant", () => {
    for (const bad of ["", "abc", "45.555", "-5", "4 5", "45.", "."]) {
      expect(parseRefundAmount(bad), bad).toBeNull();
    }
  });
});

describe("the refunded figure on a payment row", () => {
  it("comes from the reversal ledger, per payment, scoped to the org", async () => {
    const db = fakeDb({
      review_items: [
        {
          organization_id: ORG,
          kind: "payment_refunded",
          subject_id: PAY,
          detail: { amount_cents: 3000 },
        },
        {
          organization_id: ORG,
          kind: "payment_chargeback",
          subject_id: PAY,
          detail: { amount_cents: 10300 },
        },
        {
          organization_id: OTHER_ORG,
          kind: "payment_refunded",
          subject_id: PAY,
          detail: { amount_cents: 999 },
        },
      ],
    });
    const m = await refundedCentsByPayment(db.client, ORG, [PAY]);
    expect(m.get(PAY)).toBe(3000);
  });
});
