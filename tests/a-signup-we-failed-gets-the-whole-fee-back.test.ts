// A signup HoundStack failed to provision gets the whole application fee back,
// Radar pass-through included (#825, owner review on #840).
//
// The signup charge carries Stripe's Radar fee in its application fee
// (radar_fee_cents "5"). When provisioning then fails, provisionSignup refunds
// the customer. The failure is HoundStack's, so the platform absorbs the five
// cents: the refund sends refund_application_fee: true rather than keeping the
// Radar part the way an ordinary refund does.
//
// Driven through the shipped webhook with a fake `supabaseAdmin`, the same way
// a-signup-that-paid-for-a-first-cleanup-gets-an-invoice-for-it.test.ts does.
// Stripe is a real SDK client whose HTTP layer throws, and whose
// refunds.create is a spy, so no request can leave this process.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, stripeSignature } from "./helpers/fake-supabase";

const WEBHOOK_SECRET = "whsec_test_failed_signup_do_not_use_anywhere_real";
const ORG = "0f000000-0000-4000-8000-0000000000a5";
const ACCOUNT = "acct_failed_signup";
const SIGNUP = "5f000000-0000-4000-8000-0000000000a5";

const fake = createFakeAdmin();
const h = vi.hoisted(() => ({
  failClientInsert: true,
  refundsCreate: vi.fn(async (params: Record<string, unknown>) => ({
    id: "re_failed_signup",
    amount: 2500,
    params,
  })),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === "from") {
          return (table: string) => {
            const real = fake.admin.from(table) as unknown as Record<string, unknown>;
            if (table !== "clients" || !h.failClientInsert) return real;
            // Provisioning fails creating the client: a constraint, an
            // outage, anything on HoundStack's side.
            return new Proxy(real, {
              get: (o, key) =>
                key === "insert"
                  ? () => {
                      throw new Error("client insert failed (fixture)");
                    }
                  : o[key as string],
            });
          };
        }
        return fake.admin[p as keyof typeof fake.admin];
      },
    },
  ),
}));
vi.mock("@/lib/stripe-client.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    makeStripe: async (secret: string) => {
      const Stripe = (await import("stripe")).default;
      const client = new Stripe(secret, {
        // Any HTTP request fails loudly: nothing here may reach Stripe.
        httpClient: Stripe.createFetchHttpClient(async () => {
          throw new Error("network is fenced off in this test");
        }),
      });
      (client.refunds as unknown as { create: unknown }).create = h.refundsCreate;
      return client;
    },
  };
});
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

const signupRow = () => ({
  id: SIGNUP,
  organization_id: ORG,
  zone_id: null,
  status: "pending",
  name: "Fixture Customer",
  email: "fixture@example.test",
  phone: null,
  street: "1 Proof Lane",
  city: "Chicago",
  region: "IL",
  postal_code: "60601",
  dog_count: 1,
  frequency: "weekly",
  recurring_price_cents: 2500,
  initial_cleanup_cents: 0,
  currency: "usd",
  refunded_at: null,
  provisioned_client_id: null,
});

/** The signup charge as #825 creates it: the Radar fee rode on the
 *  application fee, and the intent says so. */
const paidIntent = {
  id: "pi_failed_signup",
  amount: 2500,
  currency: "usd",
  metadata: {
    signup_request_id: SIGNUP,
    organization_id: ORG,
    source: "signup_inline",
    radar_fee_cents: "5",
    connect_fee_payer: "application_express",
  },
};

beforeAll(async () => {
  await import("@/integrations/supabase/client.server");
  await import("@/lib/stripe-connect.server");
});

beforeEach(() => {
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_failed_signup_placeholder";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  h.failClientInsert = true;
  h.refundsCreate.mockClear();
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

describe("a signup HoundStack failed to provision", () => {
  it("is refunded with the whole application fee, Radar part included", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await deliver("payment_intent.succeeded", paidIntent);
    expect(res.status).toBe(200);

    expect(h.refundsCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = h.refundsCreate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      payment_intent: "pi_failed_signup",
      refund_application_fee: true,
    });
    // On the business's own connected account, idempotently.
    expect(opts).toMatchObject({
      stripeAccount: ACCOUNT,
      idempotencyKey: `signup-refund-${SIGNUP}`,
    });

    const row = fake.tables.signup_requests[0];
    expect(row.status).toBe("failed");
    expect(row.stripe_refund_id).toBe("re_failed_signup");
    expect(row.refunded_at).toBeTruthy();
    err.mockRestore();
  });

  it("does not refund a signup that provisioned", async () => {
    h.failClientInsert = false;
    const res = await deliver("payment_intent.succeeded", paidIntent);
    expect(res.status).toBe(200);
    expect(h.refundsCreate).not.toHaveBeenCalled();
    expect(fake.tables.signup_requests[0].status).toBe("provisioned");
  });
});
