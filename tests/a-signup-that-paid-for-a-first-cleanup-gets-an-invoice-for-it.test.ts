// The online signup charges first cleanup + first visit in one PaymentIntent.
// Until 20260929120000 the webhook credited the visit share to the customer's
// balance and wrote NOTHING for the first cleanup: no invoice, no line, no
// payment row. The money was real and in the tenant's Stripe balance, and no
// report in HoundStack could see it.
//
// Driven through the shipped webhook with a fake `supabaseAdmin`, the same way
// stripe-webhook-money.test.ts drives it, so what is asserted is what
// provisionSignup actually wrote.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";

const WEBHOOK_SECRET = "whsec_test_first_cleanup_do_not_use_anywhere_real";
const ORG = "0f000000-0000-4000-8000-0000000000f1";
const ACCOUNT = "acct_first_cleanup";
const SIGNUP = "5f000000-0000-4000-8000-0000000000f1";

const fake = createFakeAdmin();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
vi.mock("@/lib/stripe-connect.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveOrgStripeAccount: async (orgId: string) => (orgId === ORG ? { accountId: ACCOUNT } : null),
  collectingOrgIdFor: async (orgId: string) => orgId,
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: async () => 0 }));
vi.mock("@/lib/portal-links.server", () => ({ buildPortalLink: async () => "https://x.test/p" }));

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

/** A signup whose owner prices by "when was your yard last cleaned?": the
 *  customer said "3+ months or never", has three dogs, and was charged
 *  $170.00 for the first cleanup and $25.00 for the first visit. */
const signupRow = (over: Record<string, unknown> = {}) => ({
  id: SIGNUP,
  organization_id: ORG,
  zone_id: null,
  status: "pending",
  name: "Marguerite Okonkwo-Castellanos",
  email: "marguerite@example.test",
  phone: null,
  street: "1 Proof Lane",
  city: "Chicago",
  region: "IL",
  postal_code: "60601",
  dog_count: 3,
  frequency: "weekly",
  recurring_price_cents: 2500,
  initial_cleanup_cents: 17000,
  first_cleanup_tier_id: "three_months_or_never",
  first_cleanup_label: "3+ months or never",
  currency: "usd",
  refunded_at: null,
  provisioned_client_id: null,
  ...over,
});

const paidIntent = (amount: number) => ({
  id: "pi_first_cleanup",
  amount,
  currency: "usd",
  metadata: { signup_request_id: SIGNUP, organization_id: ORG, source: "signup_inline" },
});

beforeAll(async () => {
  // See stripe-webhook-money.test.ts: resolve the dynamically imported
  // modules once so the mocker cannot hand one of them the real thing.
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
  await import("@/lib/first-cleanup-billing.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_first_cleanup_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  fake.reset({
    signup_requests: [signupRow()],
    organizations: [{ id: ORG, timezone: "America/Chicago" }],
    clients: [],
    properties: [],
    subscriptions: [],
    invoices: [],
    invoice_line_items: [],
    payments: [],
    credit_ledger: [],
  });
});

const invoices = () => fake.tables.invoices ?? [];
const lines = () => fake.tables.invoice_line_items ?? [];
const payments = () => fake.tables.payments ?? [];

describe("a signup that paid for a first cleanup", () => {
  it("gets a paid invoice whose one line is the first cleanup, in the owner's words", async () => {
    const res = await deliver("payment_intent.succeeded", paidIntent(19_500));
    expect(res.status).toBe(200);

    const client = fake.tables.clients[0];
    expect(client, "provisioning did not create the client").toBeDefined();
    expect(fake.tables.signup_requests[0].status).toBe("provisioned");

    expect(invoices()).toHaveLength(1);
    expect(invoices()[0]).toMatchObject({
      organization_id: ORG,
      client_id: client.id,
      status: "paid",
      kind: "postpaid",
      total_cents: 17_000,
      stripe_payment_intent_id: "pi_first_cleanup",
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      invoice_id: invoices()[0].id,
      amount_cents: 17_000,
      quantity: 1,
      unit_amount_cents: 17_000,
    });
    expect(String(lines()[0].description)).toMatch(/First cleanup/);
    expect(String(lines()[0].description)).toMatch(/3\+ months or never/);
    expect(String(lines()[0].description)).toMatch(/3 dogs/);
  });

  it("records the payment for it, and credits only the visit share as prepay", async () => {
    await deliver("payment_intent.succeeded", paidIntent(19_500));
    expect(payments()).toHaveLength(1);
    expect(payments()[0]).toMatchObject({
      organization_id: ORG,
      invoice_id: invoices()[0].id,
      amount_cents: 17_000,
      status: "succeeded",
      stripe_payment_intent_id: "pi_first_cleanup",
    });
    // $195.00 charged: $170.00 is the invoice above, $25.00 is the prepaid
    // visit. Nothing counted twice, nothing left unaccounted for.
    expect(fake.tables.credit_ledger).toHaveLength(1);
    expect(fake.tables.credit_ledger[0]).toMatchObject({ kind: "prepayment", delta_cents: 2_500 });
  });

  it("writes it once when Stripe redelivers the event", async () => {
    await deliver("payment_intent.succeeded", paidIntent(19_500));
    await deliver("payment_intent.succeeded", paidIntent(19_500));
    expect(invoices()).toHaveLength(1);
    expect(payments()).toHaveLength(1);
  });

  it("does not write a second invoice if a crash left the signup unmarked", async () => {
    // The invoice is written before the signup is marked provisioned, so a
    // process that dies between the two retries into billSignupFirstCleanup
    // again. The intent is the key that stops a second one.
    const { billSignupFirstCleanup } = await import("@/lib/first-cleanup-billing.server");
    const args = {
      orgId: ORG,
      clientId: "c0000000-0000-4000-8000-000000000001",
      amountCents: 17_000,
      currency: "usd",
      tierLabel: "3+ months or never",
      dogCount: 3,
      paymentIntentId: "pi_first_cleanup",
      stripeRef: "pi_first_cleanup",
    };
    const first = await billSignupFirstCleanup(fake.admin as any, args);
    const second = await billSignupFirstCleanup(fake.admin as any, args);
    expect(first?.created).toBe(true);
    expect(second).toEqual({ invoiceId: first!.invoiceId, created: false });
    expect(invoices()).toHaveLength(1);
  });

  it("writes no invoice at all when there was no first cleanup to pay for", async () => {
    fake.reset({
      ...fake.tables,
      signup_requests: [
        signupRow({ initial_cleanup_cents: 0, first_cleanup_tier_id: null, first_cleanup_label: null }),
      ],
    });
    await deliver("payment_intent.succeeded", paidIntent(2_500));
    expect(fake.tables.signup_requests[0].status).toBe("provisioned");
    expect(invoices()).toHaveLength(0);
    expect(payments()).toHaveLength(0);
    expect(fake.tables.credit_ledger[0]).toMatchObject({ delta_cents: 2_500 });
  });
});
