// The public signup is the one place a member of the public names a price
// and a card is charged for it. The browser sends a ZIP, a dog count, a
// frequency and the customer's answer to "when was your yard last cleaned?"
// as a TIER ID. The database prices that. The card is charged what the
// database said, and nothing in the request body can change it.
//
// Three locks, tested separately so that losing one is visible:
//   1. signupCheckoutSchema drops every key it does not name (zod's default).
//   2. signupChargeFromQuote takes a quote row and nothing else.
//   3. createSignupPaymentIntent, run for real here with Stripe and both
//      Supabase clients faked, charges the RPC's numbers even when the body
//      carries prices of its own.
// And, when a database is reachable, the SQL proof shows public_quote has no
// price parameter and prices a made-up tier id as nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin } from "./helpers/fake-supabase";
import { proofDatabaseReachable, runFirstCleanupProof } from "./helpers/first-cleanup-proof";

const ORG = "0f000000-0000-4000-8000-0000000000e1";
const fake = createFakeAdmin();

/** What the anon client's `public_quote` answers, and every call made to it. */
const quoteCalls: Array<Record<string, unknown>> = [];
let quoteRow: Record<string, unknown> | null = null;

// Server functions without the framework: the builder's chain collapses to
// "validate the input, then run the handler", which is what TanStack Start
// does on the server once the request has been decoded.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: {} }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "public_quote") return { data: null, error: null };
      quoteCalls.push(args);
      return { data: quoteRow ? [quoteRow] : [], error: null };
    },
  }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => fake.admin[p as keyof typeof fake.admin] }),
}));
const intents: Array<Record<string, any>> = [];
vi.mock("@/lib/stripe-connect.server", () => ({
  requireOrgStripeAccount: async () => ({ accountId: "acct_signup" }),
  connectPublishableKey: () => "pk_test_signup",
  connectStripe: async () => ({
    paymentIntents: {
      create: async (params: Record<string, any>) => {
        intents.push(params);
        return { id: `pi_${intents.length}`, client_secret: "secret" };
      },
    },
  }),
}));

const tieredQuote = {
  organization_id: ORG,
  zone_id: "20000000-0000-4000-8000-0000000000e1",
  zone_name: "North",
  base_price_cents: 3000,
  per_dog_addl_cents: 500,
  recurring_price_cents: 3000,
  initial_cleanup_cents: 17000,
  currency: "usd",
  first_cleanup_mode: "by_last_cleaned",
  first_cleanup_label: "3+ months or never",
  first_cleanup_options: [],
};

/** A real checkout body, plus every spelling of "and here is the price" a
 *  hostile or buggy client might send. */
const hostileBody = {
  slug: "whitfield",
  postal_code: "60601",
  dog_count: 3,
  frequency: "weekly",
  last_cleaned: "three_months_or_never",
  name: "Marguerite Okonkwo-Castellanos",
  email: "marguerite@example.test",
  street: "1 Proof Lane",
  initial_cleanup_cents: 1,
  first_cleanup_cents: 1,
  recurring_price_cents: 1,
  amount_cents: 1,
  amountCents: 1,
  price_cents: 1,
  _price: 1,
};

beforeEach(() => {
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  quoteCalls.length = 0;
  intents.length = 0;
  quoteRow = { ...tieredQuote };
  fake.reset({ signup_requests: [] });
});

describe("lock 1: the checkout schema keeps no price", () => {
  it("drops every price-shaped key before the handler sees the body", async () => {
    const { signupCheckoutSchema } = await import("@/lib/signup.functions");
    const parsed = signupCheckoutSchema.parse(hostileBody) as Record<string, unknown>;
    for (const k of Object.keys(parsed)) expect(k).not.toMatch(/cents|price|amount/i);
    // And it keeps the answer, which is an id.
    expect(parsed.last_cleaned).toBe("three_months_or_never");
  });
});

describe("lock 2: the charge is a function of the priced quote alone", () => {
  it("adds up what the database priced", async () => {
    const { signupChargeFromQuote } = await import("@/lib/signup-charge");
    expect(signupChargeFromQuote(tieredQuote)).toEqual({
      firstCleanupCents: 17000,
      recurringCents: 3000,
      amountCents: 20000,
      firstCleanupLabel: "3+ months or never",
    });
  });

  it("refuses to charge a tiered first cleanup the database could not price", async () => {
    const { signupChargeFromQuote, NEEDS_LAST_CLEANED } = await import("@/lib/signup-charge");
    expect(() =>
      signupChargeFromQuote({ ...tieredQuote, initial_cleanup_cents: null }),
    ).toThrow(NEEDS_LAST_CLEANED);
  });
});

describe("lock 3: the shipped handler charges the RPC's numbers", () => {
  it("sends the tier id to public_quote, and charges what came back", async () => {
    const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
    const out = await (createSignupPaymentIntent as any)({ data: hostileBody });

    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]).toMatchObject({ _last_cleaned: "three_months_or_never", _dog_count: 3 });
    for (const k of Object.keys(quoteCalls[0])) expect(k).not.toMatch(/cents|price|amount/i);

    expect(intents).toHaveLength(1);
    expect(intents[0].amount).toBe(20000);
    expect(out.amountCents).toBe(20000);

    // The signup row the webhook will provision from carries the database's
    // numbers too, and the answer in the owner's words for the invoice line.
    expect(fake.tables.signup_requests[0]).toMatchObject({
      initial_cleanup_cents: 17000,
      recurring_price_cents: 3000,
      first_cleanup_tier_id: "three_months_or_never",
      first_cleanup_label: "3+ months or never",
    });
  });

  it("takes no card at all when the answer does not price", async () => {
    quoteRow = { ...tieredQuote, initial_cleanup_cents: null, first_cleanup_label: null };
    const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
    await expect(
      (createSignupPaymentIntent as any)({ data: { ...hostileBody, last_cleaned: "made_up" } }),
    ).rejects.toThrow(/last cleaned/);
    expect(intents).toHaveLength(0);
    expect(fake.tables.signup_requests).toHaveLength(0);
  });
});

describe.skipIf(!proofDatabaseReachable)("and in the database", () => {
  it("public_quote takes no price, and a made-up tier prices nothing", () => {
    const run = runFirstCleanupProof();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/ok: anon can price only through public_quote, which takes no price/);
    expect(run.out).toMatch(/ok: a tier id the owner does not have prices nothing/);
  });
});
