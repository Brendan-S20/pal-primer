import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin, stripeSignature, type Row } from "./helpers/fake-supabase";

// IMP-6, third part. The OTHER money webhook.
//
// /api/public/hooks/stripe decides whether a tenant's client paid an invoice.
// This one decides whether the TENANT has paid HoundStack — it is the only
// writer of `organizations.plan_status`, and therefore the thing that switches
// a paying customer's account off. It also cancels their bolt-on add-ons.
//
// It had no tests. Going live on Stripe means this handler starts receiving
// real subscription events on day one, and the failure modes are asymmetric:
// wrongly marking an org `active` costs revenue quietly, wrongly marking one
// `canceled` locks a paying customer out of their business.

const WEBHOOK_SECRET = "whsec_test_platform_imp6";

const ORG = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "cus_paying_org";
const SUBSCRIPTION = "sub_recorded";
const PLAN = "22222222-2222-2222-2222-222222222222";

const fake = createFakeAdmin();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));

// Deactivating add-ons is a chain of its own writes against tables this suite
// does not model; what matters here is WHETHER it is called, so it is recorded.
const deactivated: string[] = [];
vi.mock("@/lib/platform-addons.server", () => ({
  deactivateOrgPlatformAddons: async (orgId: string) => {
    deactivated.push(orgId);
  },
}));

async function deliver(
  type: string,
  object: Row,
  opts: { secret?: string; signed?: boolean } = {},
) {
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object },
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.signed !== false) {
    headers["stripe-signature"] = stripeSignature(body, opts.secret ?? WEBHOOK_SECRET);
  }
  const mod = await import("@/routes/api/public/hooks/platform-stripe");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  return (await POST({
    request: new Request("https://app.houndstack.com/api/public/hooks/platform-stripe", {
      method: "POST",
      headers,
      body,
    }),
  })) as Response;
}

const org = () => fake.tables.organizations[0];
const events = () => fake.tables.platform_stripe_events ?? [];

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.PLATFORM_STRIPE_SECRET_KEY = "sk_test_platform_placeholder";
  process.env.PLATFORM_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  deactivated.length = 0;
  fake.reset({
    organizations: [
      {
        id: ORG,
        stripe_customer_id: CUSTOMER,
        stripe_subscription_id: SUBSCRIPTION,
        plan_status: "active",
        plan_id: PLAN,
        current_period_end: "2026-09-01T00:00:00Z",
      },
    ],
    platform_plans: [{ id: PLAN }],
    platform_invoices: [],
    platform_stripe_events: [],
  });
});

describe("the platform webhook refuses what it cannot verify", () => {
  it("rejects a request with no signature", async () => {
    expect((await deliver("invoice.paid", { id: "in_1" }, { signed: false })).status).toBe(400);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    // Without this, anyone who can POST to a public URL can mark any
    // organization's subscription active — or cancel it.
    const res = await deliver("invoice.paid", { id: "in_1" }, { secret: "whsec_attacker" });
    expect(res.status).toBe(401);
  });

  it("refuses to run unconfigured rather than processing unverified events", async () => {
    delete process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
    expect((await deliver("invoice.paid", { id: "in_1" })).status).toBe(501);
  });

  it("writes nothing at all when it cannot verify", async () => {
    await deliver("invoice.paid", { id: "in_1", customer: CUSTOMER }, { secret: "whsec_attacker" });
    expect(fake.writes).toHaveLength(0);
    expect(org().plan_status).toBe("active");
  });
});

describe("an invoice outcome moves the plan", () => {
  const invoice = (o: Row) => ({
    id: "in_1",
    customer: CUSTOMER,
    amount_due: 9900,
    amount_paid: 0,
    currency: "usd",
    created: 1_785_000_000,
    ...o,
  });

  it("a failed payment marks the org past_due", async () => {
    await deliver("invoice.payment_failed", invoice({ status: "open" }));
    expect(org().plan_status).toBe("past_due");
  });

  it("a paid invoice marks the org active again", async () => {
    fake.tables.organizations[0].plan_status = "past_due";
    await deliver("invoice.paid", invoice({ status: "paid", amount_paid: 9900 }));
    expect(org().plan_status).toBe("active");
  });

  it("records the invoice against the org for the billing history", async () => {
    await deliver("invoice.paid", invoice({ status: "paid", amount_paid: 9900, number: "A-1" }));
    expect(fake.tables.platform_invoices).toHaveLength(1);
    expect(fake.tables.platform_invoices[0]).toMatchObject({
      stripe_invoice_id: "in_1",
      organization_id: ORG,
      amount_paid_cents: 9900,
      number: "A-1",
    });
  });

  it("does not touch any org when the customer belongs to none", async () => {
    // A platform-account event for a customer this system has never mapped.
    // Mirroring the tenant hook's C1 rule: no org, no write.
    await deliver("invoice.payment_failed", invoice({ customer: "cus_stranger" }));
    expect(org().plan_status, "an unmapped customer changed an org's plan").toBe("active");
    expect(fake.writes.some((w) => w.table === "organizations")).toBe(false);
  });

  it("neither activates nor suspends on an invoice that only opened", async () => {
    // invoice.created and invoice.finalized are bookkeeping. Only paid and
    // payment_failed are verdicts.
    await deliver("invoice.finalized", invoice({ status: "open" }));
    expect(fake.writes.some((w) => w.table === "organizations")).toBe(false);
  });
});

describe("a subscription event decides whether the org keeps its account", () => {
  const sub = (o: Row) => ({
    id: SUBSCRIPTION,
    customer: CUSTOMER,
    status: "active",
    items: { data: [{ current_period_end: 1_790_000_000 }] },
    ...o,
  });

  it("an abandoned payment form never suspends the org", async () => {
    // The in-app Payment Element creates the subscription with
    // payment_behavior "default_incomplete" — BEFORE the org has paid. Acting
    // on that state (or its 24h expiry) marks a signing-up org past_due, and
    // marks an EXISTING org canceled if they merely opened a plan-change form
    // and closed it.
    await deliver("customer.subscription.created", sub({ status: "incomplete" }));
    await deliver("customer.subscription.updated", sub({ status: "incomplete_expired" }));
    expect(org().plan_status).toBe("active");
    expect(fake.writes.some((w) => w.table === "organizations")).toBe(false);
  });

  it("cancelling a stale incomplete subscription does not cancel the plan", async () => {
    // Retrying the payment form or switching plans mid-attempt emits `deleted`
    // with status "canceled" for a subscription the org never recorded. Only
    // the org's RECORDED subscription may end the plan.
    await deliver(
      "customer.subscription.deleted",
      sub({ id: "sub_abandoned_attempt", status: "canceled" }),
    );
    expect(org().plan_status, "an abandoned attempt cancelled a live plan").toBe("active");
    expect(deactivated, "and took the org's paid add-ons with it").toHaveLength(0);
  });

  it("cancelling the recorded subscription cancels the plan and its add-ons", async () => {
    await deliver("customer.subscription.deleted", sub({ status: "canceled" }));
    expect(org().plan_status).toBe("canceled");
    // Otherwise the org keeps paid features for free and cannot cleanly re-buy.
    expect(deactivated).toEqual([ORG]);
  });

  it("maps a trial to an active account", async () => {
    fake.tables.organizations[0].plan_status = "past_due";
    await deliver("customer.subscription.updated", sub({ status: "trialing" }));
    expect(org().plan_status).toBe("active");
  });

  it("maps unpaid to past_due, not to canceled", async () => {
    // past_due nags; canceled locks them out. Stripe's `unpaid` means the
    // retries are exhausted, not that the customer left.
    await deliver("customer.subscription.updated", sub({ status: "unpaid" }));
    expect(org().plan_status).toBe("past_due");
    expect(deactivated).toHaveLength(0);
  });

  it("stores the renewal date the subscription carries", async () => {
    await deliver("customer.subscription.updated", sub({ status: "active" }));
    expect(org().current_period_end).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });

  it("keeps the stored renewal date when an event carries none", async () => {
    // Omit rather than null: an event without item data is missing the field,
    // not asserting that the subscription has no renewal.
    await deliver("customer.subscription.updated", sub({ status: "active", items: { data: [] } }));
    expect(org().current_period_end).toBe("2026-09-01T00:00:00Z");
  });

  it("adopts a plan the subscription names, when the catalog has it", async () => {
    const other = "33333333-3333-3333-3333-333333333333";
    fake.tables.platform_plans.push({ id: other });
    await deliver(
      "customer.subscription.updated",
      sub({ status: "active", metadata: { plan_id: other } }),
    );
    expect(org().plan_id).toBe(other);
  });

  it("ignores a plan id that names nothing in the catalog", async () => {
    // Subscription metadata is writable from the Stripe dashboard; a typo
    // there must not point an org's entitlements at a plan that does not exist.
    await deliver(
      "customer.subscription.updated",
      sub({ status: "active", metadata: { plan_id: "not-a-real-plan" } }),
    );
    expect(org().plan_id).toBe(PLAN);
  });

  it("does not rewrite the plan on deletion", async () => {
    // A canceled org keeps its last plan for display.
    const other = "33333333-3333-3333-3333-333333333333";
    fake.tables.platform_plans.push({ id: other });
    await deliver(
      "customer.subscription.deleted",
      sub({ status: "canceled", metadata: { plan_id: other } }),
    );
    expect(org().plan_id).toBe(PLAN);
  });
});

describe("each event is applied once", () => {
  const paid = { id: "in_1", customer: CUSTOMER, status: "paid", amount_paid: 9900 };

  it("marks the event processed when it succeeds", async () => {
    await deliver("invoice.paid", paid);
    expect(events()).toHaveLength(1);
    expect(events()[0].processed_at).toBeTruthy();
  });

  it("skips an event it has already processed", async () => {
    // Stripe redelivers. Re-running a subscription event would re-cancel
    // add-ons the org has since re-bought.
    const body = JSON.stringify({
      id: "evt_fixed_for_redelivery",
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: { id: SUBSCRIPTION, customer: CUSTOMER, status: "canceled" } },
    });
    const send = async () => {
      const mod = await import("@/routes/api/public/hooks/platform-stripe");
      const POST = (
        mod.Route as unknown as {
          options: {
            server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
          };
        }
      ).options.server.handlers.POST;
      return POST({
        request: new Request("https://app.houndstack.com/api/public/hooks/platform-stripe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
          },
          body,
        }),
      });
    };
    await send();
    expect(deactivated).toEqual([ORG]);
    await send();
    expect(deactivated, "the redelivery cancelled the add-ons a second time").toEqual([ORG]);
  });
});
