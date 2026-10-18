/* eslint-disable @typescript-eslint/no-explicit-any */
// A stranger cannot pick, be quoted for, pay for or send a lead about a
// service on a line that is still Coming soon (#506).
//
// Only pet waste is in BOOKABLE_SERVICE_LINES. An owner may set up a walk
// before launch, and before this change the public paths offered it: the
// signup and quote form's picker (publicServiceChoices), the signup's quote
// and checkout (signup.functions.ts) and the embedded lead form
// (/api/public/leads). This was open on main.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicServiceChoices } from "@/lib/public-services";
import { BOOKABLE_SERVICE_LINES, SERVICE_LINES } from "@/lib/service-lines";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

const base = {
  active: true,
  price_unit: "visit" as const,
  extra_pet_cents: 0,
  default_duration_min: 30,
};
const PW = {
  ...base,
  id: "pw",
  name: "Pet waste removal",
  service_line: "pet_waste" as const,
  base_price_cents: null,
  default_duration_min: null,
};
const WALK = {
  ...base,
  id: "w",
  name: "30-minute walk",
  service_line: "dog_walking" as const,
  base_price_cents: 2500,
};
const SIT = {
  ...base,
  id: "s",
  name: "Overnight stay",
  service_line: "pet_sitting" as const,
  price_unit: "night" as const,
  base_price_cents: 6000,
};

// ── The public paths ─────────────────────────────────────────────────────

type Row = Record<string, any>;
const ORG = "0f000000-0000-4000-8000-0000000005e6";
const OTHER_ORG = "0f000000-0000-4000-8000-0000000006e6";
const PW_ID = "11111111-1111-4111-8111-111111111506";
const WALK_ID = "22222222-2222-4222-8222-222222222506";
const SIT_ID = "33333333-3333-4333-8333-333333333506";
const OTHER_WALK_ID = "44444444-4444-4444-8444-444444444506";

const h = vi.hoisted(() => ({
  services: [] as Record<string, any>[],
  orgs: [] as Record<string, any>[],
  leads: [] as Record<string, any>[],
  signups: [] as Record<string, any>[],
  quoteCalls: [] as Record<string, any>[],
  rpcs: [] as Array<{ fn: string; args: Record<string, any> }>,
  intents: [] as Record<string, any>[],
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
    rpc: async (fn: string, args: Record<string, any>) => {
      if (fn === "public_get_org_for_lead_form") return { data: [{ id: ORG }], error: null };
      if (fn !== "public_quote") return { data: null, error: null };
      h.quoteCalls.push(args);
      return { data: [], error: null };
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
  return b;
}
const admin = {
  from(table: string): any {
    if (table === "services") return query(() => h.services);
    if (table === "organizations") return query(() => h.orgs);
    if (table === "leads") return writable(() => h.leads, "lead");
    if (table === "signup_requests") return writable(() => h.signups, "sr");
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    if (fn === "org_can_add_client") return { data: true, error: null };
    return { data: "ok", error: null };
  },
};
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
vi.mock("@/lib/lead-notify.server", () => ({ notifyOfficeOfNewLead: async () => {} }));
vi.mock("@/lib/stripe-connect.server", () => ({
  requireOrgStripeAccount: async () => ({ accountId: "acct_506" }),
  connectPublishableKey: () => "pk_test_506",
  connectStripe: async () => ({
    paymentIntents: {
      create: async (params: Row) => {
        h.intents.push(params);
        return { id: `pi_${h.intents.length}`, client_secret: "secret" };
      },
    },
  }),
}));

beforeEach(() => {
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  h.services = [
    {
      id: PW_ID,
      organization_id: ORG,
      name: "Pet waste removal",
      service_line: "pet_waste",
      active: true,
    },
    {
      id: WALK_ID,
      organization_id: ORG,
      name: "30-minute walk",
      service_line: "dog_walking",
      active: true,
    },
    {
      id: SIT_ID,
      organization_id: ORG,
      name: "Overnight stay",
      service_line: "pet_sitting",
      active: true,
    },
    {
      id: OTHER_WALK_ID,
      organization_id: OTHER_ORG,
      name: "Their walk",
      service_line: "dog_walking",
      active: true,
    },
  ];
  h.orgs = [
    { id: ORG, slug: "whitfield", portal_slug: null },
    { id: OTHER_ORG, slug: "elsewhere", portal_slug: null },
  ];
  h.leads = [];
  h.signups = [];
  h.quoteCalls = [];
  h.rpcs = [];
  h.intents = [];
});

describe("the public signup and quote form's picker", () => {
  it("drops a walk and a sit that public_services handed back, keeping pet waste", () => {
    expect(publicServiceChoices([PW, WALK, SIT]).map((s) => s.id)).toEqual(["pw"]);
  });

  it("offers nothing to pick from for a business whose only services are Coming soon", () => {
    expect(publicServiceChoices([WALK, SIT])).toEqual([]);
  });

  it("offers a line once it joins the launch list", () => {
    const got = publicServiceChoices([PW, WALK, SIT], ["pet_waste", "dog_walking"]);
    expect(got.map((s) => s.id)).toEqual(["pw", "w"]);
  });
});

const quoteBody = {
  slug: "whitfield",
  postal_code: "60601",
  dog_count: 2,
  frequency: "weekly",
};
const checkoutBody = {
  ...quoteBody,
  name: "Marguerite Okonkwo",
  email: "marguerite@example.test",
  street: "1 Proof Lane",
  website_url: "",
  elapsed_ms: 45_000,
};
const REFUSED = "That service isn't offered online right now. Pick another.";

describe("the public signup", () => {
  it("refuses to quote a walk or a sit before public_quote is asked", async () => {
    const { getSignupQuote } = await import("@/lib/signup.functions");
    for (const service_id of [WALK_ID, SIT_ID]) {
      await expect((getSignupQuote as any)({ data: { ...quoteBody, service_id } })).rejects.toThrow(
        REFUSED,
      );
    }
    expect(h.quoteCalls).toEqual([]);
  });

  it("still quotes pet waste, and leaves another business's id to public_quote", async () => {
    const { getSignupQuote } = await import("@/lib/signup.functions");
    await (getSignupQuote as any)({ data: { ...quoteBody, service_id: PW_ID } });
    await (getSignupQuote as any)({ data: quoteBody });
    await (getSignupQuote as any)({ data: { ...quoteBody, service_id: OTHER_WALK_ID } });
    expect(h.quoteCalls).toHaveLength(3);
  });

  it("refuses to check out a walk: no quote, no card, no row", async () => {
    const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
    await expect(
      (createSignupPaymentIntent as any)({ data: { ...checkoutBody, service_id: WALK_ID } }),
    ).rejects.toThrow(REFUSED);
    expect(h.quoteCalls).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(h.signups).toEqual([]);
    expect(h.leads).toEqual([]);
    expect(h.rpcs).toEqual([]);
  });

  it("refuses in both handlers before their public_quote call", () => {
    const fns = read("src/lib/signup.functions.ts");
    for (const name of ["getSignupQuote", "createSignupPaymentIntent"]) {
      const handler = fns.slice(fns.indexOf(`export const ${name}`));
      const refusal = handler.indexOf(
        "await refuseAComingSoonService(data.slug, data.service_id);",
      );
      expect(refusal, name).toBeGreaterThan(0);
      expect(refusal, name).toBeLessThan(handler.indexOf('sb.rpc("public_quote"'));
    }
  });
});

async function postLead(body: Record<string, unknown>) {
  const mod = await import("@/routes/api/public/leads");
  const POST = (
    mod.Route as unknown as {
      options: {
        server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } };
      };
    }
  ).options.server.handlers.POST;
  const res = await POST({
    request: new Request("https://app.houndstack.com/api/public/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.6" },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const leadBody = {
  slug: "whitfield",
  name: "Marguerite Okonkwo",
  email: "marguerite@example.test",
  location: "612 Maple St, Southfield, MI 48037",
  dog_count: 2,
  frequency: "weekly",
  website_url: "",
  elapsed_ms: 38_000,
};

describe("the embedded lead form (/api/public/leads)", () => {
  it("refuses a walk as invalid input, before a turn is taken, and writes nothing", async () => {
    const r = await postLead({ ...leadBody, service_id: WALK_ID });
    expect(r).toEqual({ status: 400, body: { error: "Invalid input" } });
    expect(h.rpcs).toEqual([]);
    expect(h.leads).toEqual([]);
  });

  it("still records a lead for pet waste", async () => {
    const r = await postLead({ ...leadBody, service_id: PW_ID });
    expect(r.status).toBe(201);
    expect(h.leads[0]).toMatchObject({ organization_id: ORG, service_id: PW_ID });
  });
});
