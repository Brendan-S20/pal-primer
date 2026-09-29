import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";

// A customer paid a $125.00 invoice and added a $15.00 tip, so Stripe charged
// $140.00 and the webhook is handed `pi.amount = 14000`. What it writes decides
// every figure downstream:
//
//   - `payments.amount_cents` must be 12500: the money applied to the invoice.
//     Revenue, AR, franchise royalties and the platform fee all sum that
//     column, so a 14000 here counts the tip as revenue in every one of them.
//   - `payments.tip_cents` must be 1500, beside it, or the tip is simply lost:
//     no receipt line, no Timesheets figure, no Tips received report.
//   - the invoice is paid by its own amount, not over-credited by the tip.
//
// Driven through the SHIPPED handler with a fake service-role client, the same
// harness as stripe-webhook-money.test.ts, so what is asserted is what the
// handler tried to write rather than what a copy of its arithmetic returns.

const WEBHOOK_SECRET = "whsec_test_tips_do_not_use_anywhere_real";
const ORG = "11111111-1111-1111-1111-111111111111";
const INVOICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TECH = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ACCOUNT = "acct_tips";

const fake = createFakeAdmin();

// The attribution lookup (tip_staff_for_invoice, 20260929030000). The SQL is
// proved against a real database by the migration's own replay; here it only
// has to answer.
let tipStaff: string | null = TECH;
fake.onRpc("tip_staff_for_invoice", () => tipStaff);
fake.onRpc("file_reversal_review_item", () => null);
fake.onRpc("record_franchise_adjustment", () => "adj_1");

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
const emails: Array<Record<string, unknown>> = [];
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (e: Record<string, unknown>) => {
    emails.push(e);
  },
}));

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

const tippedPi = (metadata: Record<string, string>, amount = 14_000) => ({
  id: "pi_tipped",
  amount,
  currency: "usd",
  metadata: { source: "public_link", invoice_id: INVOICE, ...metadata },
});

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/invoice-reconcile.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_tips_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  tipStaff = TECH;
  emails.length = 0;
  fake.reset({
    invoices: [
      {
        id: INVOICE,
        organization_id: ORG,
        client_id: CLIENT,
        total_cents: 12_500,
        currency: "usd",
        status: "open",
        paid_at: null,
        stripe_payment_intent_id: null,
      },
    ],
    payments: [],
    clients: [{ id: CLIENT }],
    review_items: [],
  });
});

const payment = () => (fake.tables.payments ?? [])[0];

describe("a tipped payment", () => {
  it("records the invoice amount and the tip as two figures", async () => {
    const res = await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "1500" }));
    expect(res.status).toBe(200);
    expect(fake.tables.payments).toHaveLength(1);
    expect(payment()).toMatchObject({
      invoice_id: INVOICE,
      amount_cents: 12_500,
      tip_cents: 1_500,
      surcharge_cents: 0,
      status: "succeeded",
    });
  });

  it("marks the invoice paid by its own amount, not over-credited by the tip", async () => {
    await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "1500" }));
    expect(fake.tables.invoices[0].status).toBe("paid");
    // The three parts add back to what Stripe charged, and nothing more.
    const p = payment();
    expect(Number(p.amount_cents) + Number(p.surcharge_cents) + Number(p.tip_cents)).toBe(14_000);
    expect(p.amount_cents).toBe(fake.tables.invoices[0].total_cents);
  });

  it("credits the tip to the tech the invoice's last completed visit names", async () => {
    await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "1500" }));
    expect(payment().tip_staff_id).toBe(TECH);
    expect(fake.rpcs.find((r) => r.fn === "tip_staff_for_invoice")?.args).toEqual({
      _invoice_id: INVOICE,
    });
  });

  it("records the tip unattributed when no visit names anybody", async () => {
    tipStaff = null;
    await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "1500" }));
    expect(payment()).toMatchObject({ tip_cents: 1_500, tip_staff_id: null });
  });

  it("does not ask who the tip is for when there is no tip", async () => {
    await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "0" }, 12_500));
    expect(payment()).toMatchObject({ amount_cents: 12_500, tip_cents: 0, tip_staff_id: null });
    expect(fake.rpcs.some((r) => r.fn === "tip_staff_for_invoice")).toBe(false);
  });

  it("keeps the surcharge and the tip apart when a charge carries both", async () => {
    await deliver(
      "payment_intent.succeeded",
      tippedPi({ tip_cents: "1500", surcharge_cents: "375" }, 14_375),
    );
    expect(payment()).toMatchObject({
      amount_cents: 12_500,
      surcharge_cents: 375,
      tip_cents: 1_500,
    });
  });

  it("treats an intent from before tipping existed as all invoice money", async () => {
    // Every in-flight intent on the day this deploys carries no tip_cents.
    await deliver("payment_intent.succeeded", tippedPi({}, 12_500));
    expect(payment()).toMatchObject({ amount_cents: 12_500, tip_cents: 0 });
  });

  it("puts the tip on the receipt", async () => {
    await deliver("payment_intent.succeeded", tippedPi({ tip_cents: "1500" }));
    const receipt = emails.find((e) => e.templateName === "payment-received");
    expect(receipt?.templateData).toMatchObject({ amountCents: 12_500, tipCents: 1_500 });
  });

  it("records the tip on a declined attempt, so the row means the same thing", async () => {
    await deliver("payment_intent.payment_failed", tippedPi({ tip_cents: "1500" }));
    expect(payment()).toMatchObject({ status: "failed", amount_cents: 12_500, tip_cents: 1_500 });
  });
});

describe("refunding a tipped payment", () => {
  beforeEach(() => {
    fake.tables.payments = [
      {
        id: "pay_tipped",
        organization_id: ORG,
        invoice_id: INVOICE,
        amount_cents: 12_500,
        surcharge_cents: 0,
        tip_cents: 1_500,
        status: "succeeded",
        stripe_payment_intent_id: "pi_tipped",
      },
    ];
  });

  const filed = () => fake.rpcs.find((r) => r.fn === "file_reversal_review_item")?.args;
  const adjusted = () => fake.rpcs.find((r) => r.fn === "record_franchise_adjustment")?.args;

  it("takes only the invoice share off revenue when the whole charge goes back", async () => {
    await deliver("charge.refunded", {
      id: "ch_tipped",
      amount: 14_000,
      amount_refunded: 14_000,
      payment_intent: "pi_tipped",
    });
    // What the customer got back is the whole charge...
    expect(filed()).toMatchObject({ _amount_cents: 14_000, _revenue_cents: 12_500 });
    // ...and the franchise deduction is on the same base the royalty was.
    expect(adjusted()).toMatchObject({ _kind: "refund", _amount_cents: 12_500 });
  });

  it("splits a partial refund in the charge's own ratio", async () => {
    await deliver("charge.refunded", {
      id: "ch_tipped",
      amount: 14_000,
      amount_refunded: 7_000,
      payment_intent: "pi_tipped",
    });
    expect(filed()).toMatchObject({ _amount_cents: 7_000, _revenue_cents: 6_250 });
  });

  it("leaves a chargeback whole, tip included, which can only understate revenue", async () => {
    await deliver("charge.dispute.created", {
      id: "dp_tipped",
      status: "needs_response",
      amount: 14_000,
      payment_intent: "pi_tipped",
    });
    expect(filed()).toMatchObject({ _amount_cents: 14_000, _revenue_cents: 14_000 });
  });
});
