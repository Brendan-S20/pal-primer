/* eslint-disable @typescript-eslint/no-explicit-any */
// A stranger cannot subscribe to a stay (#546): the server half.
//
// tests/a-night-is-not-a-weekly-visit.test.tsx pins what the form offers. A
// body is not the form, so the three public paths say the same thing on
// their own: getSignupQuote and createSignupPaymentIntent refuse a service
// priced per night before public_quote is asked (no cadence price, no card,
// no signup request), and /api/public/leads records it as a lead the office
// can act on, with no frequency, whatever the body carried. A drop-in is
// quoted and checked out as before.
//
// Sitting is switched ON here, as it will be the day it launches (#546 is
// what that flip waits on). The last block switches it back off and finds
// the Coming soon refusal unchanged: a stay is refused as not offered, not as
// a stay.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_DEFAULT,
  SITTING_COMING_SOON,
  withBookable,
} from "./support/service-line-availability";

vi.mock("@/lib/service-line-availability.server", async () => {
  const s = await import("./support/service-line-availability");
  return {
    loadServiceLineAvailability: async () =>
      h.sittingLive ? s.withBookable("pet_sitting") : s.SITTING_COMING_SOON,
  };
});

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

type Row = Record<string, any>;
const ORG = "0f000000-0000-4000-8000-0000000005e6";
const OTHER_ORG = "0f000000-0000-4000-8000-0000000006e6";
const PW_ID = "11111111-1111-4111-8111-111111111506";
const WALK_ID = "22222222-2222-4222-8222-222222222506";
const SIT_ID = "33333333-3333-4333-8333-333333333506";
const HOUSE_SIT_ID = "55555555-5555-4555-8555-555555555546";
const DROP_IN_ID = "66666666-6666-4666-8666-666666666546";
const OTHER_WALK_ID = "44444444-4444-4444-8444-444444444506";

const h = vi.hoisted(() => ({
  services: [] as Record<string, any>[],
  orgs: [] as Record<string, any>[],
  leads: [] as Record<string, any>[],
  signups: [] as Record<string, any>[],
  quoteCalls: [] as Record<string, any>[],
  rpcs: [] as Array<{ fn: string; args: Record<string, any> }>,
  intents: [] as Record<string, any>[],
  sittingLive: true,
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
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "recurring",
    },
    {
      id: WALK_ID,
      organization_id: ORG,
      name: "30-minute walk",
      service_line: "dog_walking",
      active: true,
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "recurring",
    },
    {
      id: SIT_ID,
      organization_id: ORG,
      name: "Overnight stay",
      service_line: "pet_sitting",
      price_unit: "night",
      active: true,
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "request_only",
    },
    {
      id: HOUSE_SIT_ID,
      organization_id: ORG,
      name: "House sit",
      service_line: "pet_sitting",
      price_unit: "night",
      active: true,
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "request_only",
    },
    {
      id: DROP_IN_ID,
      organization_id: ORG,
      name: "Drop-in visit",
      service_line: "pet_sitting",
      price_unit: "visit",
      active: true,
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "recurring",
    },
    {
      id: OTHER_WALK_ID,
      organization_id: OTHER_ORG,
      name: "Their walk",
      service_line: "dog_walking",
      active: true,
      // How the booking link starts it (#574), as the backfill set it.
      public_booking_mode: "recurring",
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
  h.sittingLive = true;
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

const STAY =
  "A stay is booked by request. Send your dates with Request this stay and we'll confirm it.";

describe.each([
  ["Overnight stay", SIT_ID],
  ["House sit", HOUSE_SIT_ID],
])("the public signup, for %s (per night)", (_name, id) => {
  it("refuses to quote it as a cadence, before public_quote is asked", async () => {
    const { getSignupQuote } = await import("@/lib/signup.functions");
    for (const frequency of ["weekly", "twice_weekly", "biweekly", "monthly"]) {
      await expect(
        (getSignupQuote as any)({ data: { ...quoteBody, frequency, service_id: id } }),
      ).rejects.toThrow(STAY);
    }
    expect(h.quoteCalls).toEqual([]);
  });

  it("refuses to check it out: no quote, no card, no signup request, no lead", async () => {
    const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
    await expect(
      (createSignupPaymentIntent as any)({ data: { ...checkoutBody, service_id: id } }),
    ).rejects.toThrow(STAY);
    expect(h.quoteCalls).toEqual([]);
    expect(h.intents).toEqual([]);
    expect(h.signups).toEqual([]);
    expect(h.leads).toEqual([]);
    expect(h.rpcs).toEqual([]);
  });

  it("is a lead the office can act on, with no frequency, whatever the body said", async () => {
    const r = await postLead({
      ...leadBody,
      service_id: id,
      frequency: "weekly",
      pets: [{ name: "Biscuit", breed: "Beagle" }],
      access_notes: "Lockbox 4471 on the side gate",
    });
    expect(r.status).toBe(201);
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0]).toMatchObject({ organization_id: ORG, service_id: id, frequency: null });
    expect(h.leads[0].access_notes).toBe("Lockbox 4471 on the side gate");
  });
});

describe("a drop-in (per visit) still sells as a recurring visit", () => {
  it("is quoted by public_quote with its cadence", async () => {
    const { getSignupQuote } = await import("@/lib/signup.functions");
    await (getSignupQuote as any)({ data: { ...quoteBody, service_id: DROP_IN_ID } });
    expect(h.quoteCalls).toEqual([
      expect.objectContaining({ _service_id: DROP_IN_ID, _frequency: "weekly" }),
    ]);
  });

  it("reaches public_quote at checkout, so Start service can price it", async () => {
    const { createSignupPaymentIntent } = await import("@/lib/signup.functions");
    // public_quote answers nothing in this harness; the point is that it was asked.
    await (createSignupPaymentIntent as any)({
      data: { ...checkoutBody, service_id: DROP_IN_ID },
    }).catch(() => {});
    expect(h.quoteCalls).toEqual([expect.objectContaining({ _service_id: DROP_IN_ID })]);
  });

  it("keeps its frequency on a lead", async () => {
    const r = await postLead({ ...leadBody, service_id: DROP_IN_ID });
    expect(r.status).toBe(201);
    expect(h.leads[0]).toMatchObject({ service_id: DROP_IN_ID, frequency: "weekly" });
  });
});

describe("pet waste and walking are unchanged", () => {
  it("quotes both with their cadence, and records their leads with it", async () => {
    const { getSignupQuote } = await import("@/lib/signup.functions");
    await (getSignupQuote as any)({ data: { ...quoteBody, service_id: PW_ID } });
    await (getSignupQuote as any)({ data: { ...quoteBody, service_id: WALK_ID } });
    await (getSignupQuote as any)({ data: quoteBody });
    expect(h.quoteCalls).toHaveLength(3);
    await postLead({ ...leadBody, service_id: WALK_ID });
    expect(h.leads[0]).toMatchObject({ service_id: WALK_ID, frequency: "weekly" });
  });
});

describe("the refusal sits before public_quote in both handlers", () => {
  it("asks the stay question of the service the Coming soon check read", () => {
    const fns = read("src/lib/signup.functions.ts");
    for (const name of ["getSignupQuote", "createSignupPaymentIntent"]) {
      const handler = fns.slice(fns.indexOf(`export const ${name}`));
      const refusal = handler.indexOf(
        "const named = await refuseAComingSoonService(data.slug, data.service_id);\n    refuseAStay(named);",
      );
      expect(refusal, name).toBeGreaterThan(0);
      expect(refusal, name).toBeLessThan(handler.indexOf('sb.rpc("public_quote"'));
    }
  });
});

describe("with sitting Coming soon (as before #547)", () => {
  const NOT_OFFERED = "That service isn't offered online right now. Pick another.";

  it("refuses every sitting service as not offered, a drop-in included", async () => {
    h.sittingLive = false;
    const { getSignupQuote, createSignupPaymentIntent } = await import("@/lib/signup.functions");
    for (const id of [SIT_ID, HOUSE_SIT_ID, DROP_IN_ID]) {
      await expect(
        (getSignupQuote as any)({ data: { ...quoteBody, service_id: id } }),
      ).rejects.toThrow(NOT_OFFERED);
      await expect(
        (createSignupPaymentIntent as any)({ data: { ...checkoutBody, service_id: id } }),
      ).rejects.toThrow(NOT_OFFERED);
      expect((await postLead({ ...leadBody, service_id: id })).status).toBe(400);
    }
    expect(h.quoteCalls).toEqual([]);
    expect(h.leads).toEqual([]);
  });

  it("and the launch default has sitting on since #547", () => {
    expect(LAUNCH_DEFAULT.bookable).toContain("pet_sitting");
    expect(SITTING_COMING_SOON.bookable).not.toContain("pet_sitting");
    expect(withBookable("pet_sitting").bookable).toContain("pet_sitting");
  });
});
