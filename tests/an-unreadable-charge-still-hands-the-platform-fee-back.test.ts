import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";
import { feeReversalCents } from "@/lib/platform-fee";
import { TAP_TO_PAY_FEE_CENTS, reversibleFeeBaseCents } from "@/lib/tap-to-pay";
import { AUDIT_ACTION_LABELS } from "@/lib/humanize";

// #826 (from the #757 review): when a refunded or disputed charge's intent
// metadata could not be read, both reversal sites in hooks/stripe.ts skipped
// the WHOLE application fee reversal and wrote only a console.error saying
// "Reverse by hand". The webhook still answered 2xx, so Stripe never
// redelivered and nobody was told. Harmless while the platform fee is zero;
// the day it is not, a refunded business is short the entire platform fee.
//
// What it does now: an unreadable read reverses the pro-rata fee less at most
// TAP_TO_PAY_FEE_CENTS. The platform never hands a tap's ten cents back, and
// the business is short at most ten cents pro rata. Every unreadable case,
// and every failed reversal, files a `platform_admin_audit` row (shown on
// /platform/audit and the tenant's audit tab), not only a log line.
//
// Driven through the shipped handler. Nothing here reaches Stripe: the
// platform client's application-fee calls and the connected account's intent
// read are both stubs; only the SDK's local signature check is real.

const WEBHOOK_SECRET = "whsec_test_826_do_not_use_anywhere_real";
const ORG = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "acct_826";
const PAYMENT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PI = "pi_826";
const FEE_ID = "fee_826";

const fake = createFakeAdmin();
fake.onRpc("file_reversal_review_item", () => null);
fake.onRpc("record_franchise_adjustment", () => "adj_1");

// The platform's application fee, as Stripe would return it.
const fees = {
  amount: 0,
  amount_refunded: 0,
  retrieve: vi.fn(async (id: string) => ({
    id,
    amount: fees.amount,
    amount_refunded: fees.amount_refunded,
  })),
  list: vi.fn(async () => ({
    data: [{ id: FEE_ID, amount: fees.amount, amount_refunded: fees.amount_refunded }],
  })),
  createRefund: vi.fn(async (_id: string, _p: { amount: number }) => ({})),
};

// The connected account's PaymentIntent read. Throws by default: the
// unreadable case this file is about.
const retrieveIntent = vi.fn(async (_id: string, _p: unknown, _o: unknown) => {
  throw new Error("Stripe unavailable");
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));

vi.mock("@/lib/stripe-client.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stripe-client.server")>();
  return {
    ...real,
    makeStripe: async (secret: string) => {
      const stripe = await real.makeStripe(secret);
      // Only the signature check is the real SDK, and it runs locally. Every
      // other resource is a stub, and anything not stubbed throws rather than
      // reaching the network.
      const stubs: Record<string, unknown> = {
        webhooks: stripe.webhooks,
        applicationFees: {
          retrieve: fees.retrieve,
          list: fees.list,
          createRefund: fees.createRefund,
        },
        refunds: { list: async () => ({ data: [] }) },
      };
      return new Proxy(stubs, {
        get: (t, p) => {
          if (typeof p !== "string" || p in t) return t[p as string];
          if (p === "then") return undefined;
          throw new Error(`test reached stripe.${p}; stub it rather than call Stripe`);
        },
      });
    },
  };
});

vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
  connectStripe: async () => ({ paymentIntents: { retrieve: retrieveIntent } }),
}));

vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => {} }));

async function deliver(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    account: ACCOUNT,
    data: { object },
  });
  const mod = await import("@/routes/api/public/hooks/stripe");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  return (await POST({
    request: new Request("https://app.houndstack.com/api/public/hooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
      },
      body,
    }),
  })) as Response;
}

/** A $400.00 charge. */
const CHARGE = 40_000;

const refund = (amountRefunded: number, metadata: Record<string, string> = {}) =>
  deliver("charge.refunded", {
    id: "ch_826",
    amount: CHARGE,
    amount_refunded: amountRefunded,
    payment_intent: PI,
    application_fee: FEE_ID,
    metadata,
  });

const dispute = (amount: number) =>
  deliver("charge.dispute.created", {
    id: "dp_826",
    status: "needs_response",
    amount,
    charge: "ch_826",
    payment_intent: PI,
  });

const reversed = () => fees.createRefund.mock.calls.map((c) => c[1].amount);
const auditRows = () => fake.tables.platform_admin_audit ?? [];

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/stripe-client.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_826_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  fees.amount = 0;
  fees.amount_refunded = 0;
  fees.retrieve.mockClear();
  fees.list.mockClear();
  fees.createRefund.mockReset();
  fees.createRefund.mockImplementation(async () => ({}));
  retrieveIntent.mockReset();
  retrieveIntent.mockImplementation(async () => {
    throw new Error("Stripe unavailable");
  });
  fake.reset({
    payments: [
      {
        id: PAYMENT,
        organization_id: ORG,
        amount_cents: CHARGE,
        surcharge_cents: 0,
        tip_cents: 0,
        tax_cents: 0,
        status: "succeeded",
        stripe_payment_intent_id: PI,
      },
    ],
    review_items: [],
    platform_admin_audit: [],
  });
});

describe("the base an unreadable read reverses from", () => {
  const unreadable = { readable: false as const, reason: "Stripe unavailable" };

  it("is the fee less at most the per-tap fee", () => {
    expect(reversibleFeeBaseCents(210, unreadable)).toBe(210 - TAP_TO_PAY_FEE_CENTS);
    expect(reversibleFeeBaseCents(200, unreadable)).toBe(190);
  });

  it("is zero when the fee is ten cents or less: nothing comes back", () => {
    expect(reversibleFeeBaseCents(10, unreadable)).toBe(0);
    expect(reversibleFeeBaseCents(7, unreadable)).toBe(0);
    expect(reversibleFeeBaseCents(0, unreadable)).toBe(0);
  });

  it("leaves a readable read exactly as it was", () => {
    const tap = { readable: true as const, metadata: { tap_to_pay_fee_cents: "10" } };
    const notTap = { readable: true as const, metadata: { source: "portal_inline" } };
    expect(reversibleFeeBaseCents(210, tap)).toBe(200);
    expect(reversibleFeeBaseCents(200, notTap)).toBe(200);
    expect(reversibleFeeBaseCents(0, notTap)).toBe(0);
  });
});

describe("charge.refunded with unreadable intent metadata", () => {
  it("full refund: reverses the fee less ten cents, and files a row a person sees", async () => {
    fees.amount = 210;
    const res = await refund(CHARGE);
    expect(res.status).toBe(200);
    expect(reversed()).toEqual([200]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_user_id: null,
      organization_id: ORG,
      action: "application_fee_reversal_unreadable",
    });
    expect(auditRows()[0].after_json).toMatchObject({
      event_type: "charge.refunded",
      fee_id: FEE_ID,
      payment_intent_id: PI,
      reason: "Stripe unavailable",
      fee_cents: 210,
      reversed_cents: 200,
    });
  });

  it("partial refund: pro rata on the reduced base", async () => {
    fees.amount = 210;
    await refund(10_000);
    expect(reversed()).toEqual([feeReversalCents(200, CHARGE, 10_000)]);
    expect(reversed()).toEqual([50]);
    expect(auditRows()).toHaveLength(1);
  });

  it("second partial refund sends only the difference from what was already returned", async () => {
    fees.amount = 210;
    fees.amount_refunded = 50;
    await refund(20_000);
    expect(reversed()).toEqual([feeReversalCents(200, CHARGE, 20_000) - 50]);
  });

  it("a fee of ten cents or less reverses nothing, and is still recorded", async () => {
    fees.amount = 10;
    await refund(CHARGE);
    expect(reversed()).toEqual([]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].after_json).toMatchObject({ reversed_cents: 0 });
  });

  it("no connected account to read from is unreadable too", async () => {
    fees.amount = 210;
    const mod = await import("@/lib/tap-to-pay");
    // Readable-or-not is decided by readChargeMetadata; the handler always
    // has an account on a Connect event, so the no-account branch is proved
    // on the reader and the handler path is the throwing read above.
    expect(await mod.readChargeMetadata(null, PI, null)).toEqual({
      readable: false,
      reason: "no connected account",
    });
  });
});

describe("charge.refunded with readable metadata is unchanged", () => {
  it("metadata on the charge: the platform fee only, no intent read, no row", async () => {
    fees.amount = 210;
    await refund(CHARGE, { channel: "tap_to_pay", tap_to_pay_fee_cents: "10" });
    expect(retrieveIntent).not.toHaveBeenCalled();
    expect(reversed()).toEqual([200]);
    expect(auditRows()).toHaveLength(0);
  });

  it("a non-tap charge read from the intent reverses the whole fee pro rata", async () => {
    fees.amount = 200;
    retrieveIntent.mockImplementation(
      async () => ({ metadata: { source: "portal_inline" } }) as never,
    );
    await refund(10_000);
    expect(reversed()).toEqual([feeReversalCents(200, CHARGE, 10_000)]);
    expect(auditRows()).toHaveLength(0);
  });

  it("a replay after the fee is fully reversed does nothing", async () => {
    fees.amount = 200;
    fees.amount_refunded = 200;
    await refund(CHARGE, { source: "portal_inline" });
    expect(reversed()).toEqual([]);
  });
});

describe("a money-moving dispute with unreadable intent metadata", () => {
  it("full dispute: reverses the fee less ten cents, and files a row", async () => {
    fees.amount = 210;
    await dispute(CHARGE);
    expect(reversed()).toEqual([200]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_user_id: null,
      organization_id: ORG,
      action: "application_fee_reversal_unreadable",
    });
    expect(auditRows()[0].after_json).toMatchObject({
      event_type: "charge.dispute.created",
      dispute_ref: "dp_826",
      charge_id: "ch_826",
      reversed_cents: 200,
    });
  });

  it("partial dispute: pro rata on the disputed amount", async () => {
    fees.amount = 210;
    await dispute(10_000);
    expect(reversed()).toEqual([50]);
  });

  it("a fee of ten cents or less reverses nothing", async () => {
    fees.amount = 10;
    await dispute(CHARGE);
    expect(reversed()).toEqual([]);
    expect(auditRows()).toHaveLength(1);
  });

  it("readable metadata is unchanged and files nothing", async () => {
    fees.amount = 210;
    retrieveIntent.mockImplementation(
      async () => ({ metadata: { channel: "tap_to_pay", tap_to_pay_fee_cents: "10" } }) as never,
    );
    await dispute(CHARGE);
    expect(reversed()).toEqual([200]);
    expect(auditRows()).toHaveLength(0);
  });

  it("an inquiry moves no money and reverses nothing", async () => {
    fees.amount = 210;
    await deliver("charge.dispute.created", {
      id: "dp_inq",
      status: "warning_needs_response",
      amount: CHARGE,
      charge: "ch_826",
      payment_intent: PI,
    });
    expect(reversed()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });
});

describe("a reversal that fails is recorded where a person sees it", () => {
  it("refund path", async () => {
    fees.amount = 200;
    fees.createRefund.mockImplementation(async () => {
      throw new Error("fee refund refused");
    });
    const res = await refund(CHARGE, { source: "portal_inline" });
    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      organization_id: ORG,
      action: "application_fee_reversal_failed",
    });
    expect(auditRows()[0].after_json).toMatchObject({
      event_type: "charge.refunded",
      error: "fee refund refused",
    });
  });

  it("dispute path", async () => {
    fees.amount = 200;
    retrieveIntent.mockImplementation(async () => ({ metadata: {} }) as never);
    fees.createRefund.mockImplementation(async () => {
      throw new Error("fee refund refused");
    });
    await dispute(CHARGE);
    expect(auditRows().map((r) => r.action)).toEqual(["application_fee_reversal_failed"]);
  });
});

describe("the wiring", () => {
  it("both new actions have a label on the platform audit log", () => {
    expect(AUDIT_ACTION_LABELS.application_fee_reversal_unreadable).toBeTruthy();
    expect(AUDIT_ACTION_LABELS.application_fee_reversal_failed).toBeTruthy();
  });

  it("neither reversal site skips on an unreadable read any more", () => {
    const hook = readFileSync("src/routes/api/public/hooks/stripe.ts", "utf8");
    expect(hook).not.toMatch(/reversal(?: on dispute)? SKIPPED/);
    expect(hook).not.toMatch(/base === null/);
  });

  it("tap-to-pay.ts no longer claims a redelivery will fix it", () => {
    const src = readFileSync("src/lib/tap-to-pay.ts", "utf8");
    expect(src).not.toMatch(/a redelivery of the event/);
  });
});
