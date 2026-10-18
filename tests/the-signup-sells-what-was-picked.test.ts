// The signup sells the service that was picked, and a business that sells
// one thing sells it exactly as before.
//
// createSignupPaymentIntent, run for real with Stripe and both Supabase
// clients faked, as tests/the-signup-charges-the-databases-price-not-the-
// browsers.test.ts runs it. What is pinned here is the phase-5 half:
//
//   * a pet-waste-only business (no service_id in the body, because its form
//     shows no picker) makes the public_quote call it always made, with no
//     _service_id key, writes the signup row it always wrote with no
//     service_id key, writes its lead with none, and charges the same sum;
//   * with a service picked, the id goes to public_quote, the charge is what
//     public_quote said for THAT service even when the body carries prices,
//     the signup row and the lead carry the id, and the office's notice names
//     the service;
//   * a service public_quote cannot price (NULL recurring) takes no card and
//     writes nothing; one it refuses (nothing back) is told so in words.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0f000000-0000-4000-8000-0000000000e1";
const WALK = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  quoteCalls: [] as Row[],
  quoteRow: null as Row | null,
  signups: [] as Row[],
  leads: [] as Row[],
  services: [] as Row[],
  orgs: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Row }>,
  notices: [] as Row[],
  intents: [] as Row[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          fn({ data: validate(opts.data), context: {} }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Row) => {
      if (fn !== "public_quote") return { data: null, error: null };
      h.quoteCalls.push(args);
      return { data: h.quoteRow ? [h.quoteRow] : [], error: null };
    },
  }),
}));

function query(rows: () => Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    gte: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({
      data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null,
      error: null,
    }),
  };
  return b;
}
function writable(rows: () => Row[], prefix: string) {
  const b = query(rows);
  b.insert = (row: Row) => ({
    select: () => ({
      single: async () => {
        const created = { id: `${prefix}-${rows().length + 1}`, ...row };
        rows().push(created);
        return { data: { id: created.id }, error: null };
      },
    }),
  });
  b.update = (patch: Row) => ({
    eq: async (_c: string, id: string) => {
      const r = rows().find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return { error: null };
    },
  });
  return b;
}
const admin = {
  from(table: string): any {
    if (table === "signup_requests") return writable(() => h.signups, "sr");
    if (table === "leads") return writable(() => h.leads, "lead");
    if (table === "services") return query(() => h.services);
    if (table === "organizations") return query(() => h.orgs);
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    if (fn === "org_can_add_client") return { data: true, error: null };
    return { data: "ok", error: null };
  },
};
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
// This file pins how a walk is sold once dog walking is bookable. Today only
// pet waste is (#506); the refusal of a Coming soon walk is pinned in
// tests/a-coming-soon-service-is-not-offered.test.ts, so here every offered
// line is treated as launched.
vi.mock("@/lib/service-lines", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/service-lines")>();
  return { ...real, BOOKABLE_SERVICE_LINES: real.OFFERED_SERVICE_LINES };
});
vi.mock("@/lib/lead-notify.server", () => ({
  notifyOfficeOfNewLead: async (lead: Row) => {
    h.notices.push(lead);
  },
}));
vi.mock("@/lib/stripe-connect.server", () => ({
  requireOrgStripeAccount: async () => ({ accountId: "acct_signup" }),
  connectPublishableKey: () => "pk_test_signup",
  connectStripe: async () => ({
    paymentIntents: {
      create: async (params: Row) => {
        h.intents.push(params);
        return { id: `pi_${h.intents.length}`, client_secret: "secret" };
      },
    },
  }),
}));

/** The pet-waste quote, as public_quote answers it with no service. */
const yardQuote = {
  organization_id: ORG,
  zone_id: "20000000-0000-4000-8000-0000000000e1",
  zone_name: "North",
  base_price_cents: 3000,
  per_dog_addl_cents: 500,
  recurring_price_cents: 3000,
  initial_cleanup_cents: 7500,
  currency: "usd",
  first_cleanup_mode: "flat",
  first_cleanup_label: null,
  first_cleanup_options: [],
};
/** A walk, as public_quote answers it with the walk's id: its own price for
 *  the dogs, no first cleanup. */
const walkQuote = {
  ...yardQuote,
  base_price_cents: 3500,
  per_dog_addl_cents: 500,
  recurring_price_cents: 3500,
  initial_cleanup_cents: 0,
  first_cleanup_mode: "off",
};

const body = {
  slug: "whitfield",
  postal_code: "60601",
  dog_count: 3,
  frequency: "weekly",
  name: "Marguerite Okonkwo-Castellanos",
  email: "marguerite@example.test",
  street: "1 Proof Lane",
  message: "Mon, Wed and Fri please",
  website_url: "",
  elapsed_ms: 45_000,
  // Every spelling of "here is the price" a hostile client might send.
  recurring_price_cents: 1,
  amount_cents: 1,
  price_cents: 1,
  service_price_cents: 1,
  service_name: "Free walk",
};

beforeEach(() => {
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  h.quoteCalls = [];
  h.quoteRow = { ...yardQuote };
  h.signups = [];
  h.leads = [];
  h.rpcs = [];
  h.notices = [];
  h.intents = [];
  h.services = [
    { id: WALK, organization_id: ORG, name: "30-minute walk", service_line: "dog_walking" },
  ];
  h.orgs = [{ id: ORG, slug: "whitfield", portal_slug: null }];
});

async function checkout(data: Row) {
  const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
  return (createSignupPaymentIntent as any)({ data });
}

describe("a business that sells one thing", () => {
  it("makes the call it always made, writes the rows it always wrote, charges the same sum", async () => {
    const out = await checkout(body);
    expect(h.quoteCalls).toHaveLength(1);
    expect(h.quoteCalls[0]).toEqual({
      _slug: "whitfield",
      _postal_code: "60601",
      _dog_count: 3,
      _frequency: "weekly",
    });
    expect(h.quoteCalls[0]).not.toHaveProperty("_service_id");
    expect(h.intents[0].amount).toBe(10500);
    expect(out.amountCents).toBe(10500);
    expect(h.signups[0]).toMatchObject({
      recurring_price_cents: 3000,
      initial_cleanup_cents: 7500,
    });
    expect(h.signups[0]).not.toHaveProperty("service_id");
    expect(h.leads[0]).not.toHaveProperty("service_id");
    expect(h.notices[0]).toMatchObject({ serviceName: null });
    // And it never looked a service up.
    expect(h.rpcs.map((c) => c.fn)).toEqual(["org_can_add_client", "take_public_form_turn"]);
  });
});

describe("a business that sells more than one", () => {
  it("quotes the service picked, charges what the database said for it, and records the pick", async () => {
    h.quoteRow = { ...walkQuote };
    const out = await checkout({ ...body, service_id: WALK });
    expect(h.quoteCalls).toHaveLength(1);
    expect(h.quoteCalls[0]).toMatchObject({ _service_id: WALK, _dog_count: 3 });
    for (const k of Object.keys(h.quoteCalls[0])) expect(k).not.toMatch(/cents|price|amount|name/i);
    // The walk's price for three dogs, no first cleanup, whatever the body said.
    expect(h.intents).toHaveLength(1);
    expect(h.intents[0].amount).toBe(3500);
    expect(out.amountCents).toBe(3500);
    expect(h.signups[0]).toMatchObject({
      service_id: WALK,
      recurring_price_cents: 3500,
      initial_cleanup_cents: 0,
      first_cleanup_label: null,
    });
    expect(h.leads[0]).toMatchObject({ service_id: WALK, source: "online_signup" });
    expect(h.notices[0]).toMatchObject({ serviceName: "30-minute walk", source: "online_signup" });
  });

  it("the checkout schema keeps the id and drops every price and name", async () => {
    const { signupCheckoutSchema } = await import("@/lib/signup.functions");
    const parsed = signupCheckoutSchema.parse({ ...body, service_id: WALK }) as Row;
    expect(parsed.service_id).toBe(WALK);
    for (const k of Object.keys(parsed)) expect(k).not.toMatch(/cents|price|amount|service_name/i);
    expect(() => signupCheckoutSchema.parse({ ...body, service_id: "30-minute walk" })).toThrow();
  });

  it("takes no card for a service the database could not price, and writes nothing", async () => {
    h.quoteRow = { ...walkQuote, base_price_cents: null, recurring_price_cents: null };
    await expect(checkout({ ...body, service_id: WALK })).rejects.toThrow(/online price yet/);
    expect(h.intents).toHaveLength(0);
    expect(h.signups).toHaveLength(0);
    expect(h.leads).toHaveLength(0);
  });

  it("says so when the database refuses the service, rather than blaming the ZIP", async () => {
    h.quoteRow = null;
    await expect(checkout({ ...body, service_id: WALK })).rejects.toThrow(/isn't offered online/);
    await expect(checkout(body)).rejects.toThrow(/No service in that ZIP/);
    expect(h.intents).toHaveLength(0);
  });

  it("the picked service stays a stranger's pick: no price, no name, reaches the row", async () => {
    h.quoteRow = { ...walkQuote };
    await checkout({ ...body, service_id: WALK });
    for (const row of [h.signups[0], h.leads[0]]) {
      for (const k of Object.keys(row)) expect(k).not.toMatch(/service_name|service_price/);
    }
  });
});
