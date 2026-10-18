/* eslint-disable @typescript-eslint/no-explicit-any */
// A Coming soon service is never offered to a client (#506).
//
// Only pet waste is in BOOKABLE_SERVICE_LINES. A business that runs dog
// walking or pet sitting may still add services on those lines in Settings →
// Services (an owner prepares prices ahead of launch), so the form says those
// lines are Coming soon, and every path a client books through leaves them
// out: the portal's extra-visit picker, the portal's request handler, and the
// AI receptionist's list_services / get_open_slots / book_visit.
//
// And the public paths, which were open on main before this change: the
// signup and quote form's picker (publicServiceChoices), the signup's quote
// and checkout (signup.functions.ts), the embedded lead form
// (/api/public/leads), and, in the database, public_services, public_quote
// and portal_request_one_off (20261018150000).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneOffServiceOptions } from "@/lib/one-off-booking";
import { publicServiceChoices } from "@/lib/public-services";
import { BOOKABLE_SERVICE_LINES, SERVICE_LINES } from "@/lib/service-lines";
import { isBookableServiceLine, serviceNamePlaceholder } from "@/lib/services";
import { bookVisit, getOpenSlots, listServices } from "../src/lib/receptionist-booking";
import { twoBusinesses } from "./support/fake-receptionist-store";

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

describe("the portal's extra-visit picker", () => {
  it("does not offer an active, priced walk or sit while their lines are Coming soon", () => {
    const opts = oneOffServiceOptions([PW, WALK, SIT], 4500);
    expect(opts.map((o) => o.id)).toEqual(["pw"]);
  });

  it("still offers the pet-waste extra cleanup, at the one-off price", () => {
    const [pw] = oneOffServiceOptions([WALK, PW], 4500);
    expect(pw).toMatchObject({ id: "pw", priceCents: 4500, petWaste: true });
  });

  it("offers nothing to a business whose only services are Coming soon", () => {
    expect(oneOffServiceOptions([WALK, SIT], 4500)).toEqual([]);
  });

  it("offers a line once it joins the launch list", () => {
    const opts = oneOffServiceOptions([PW, WALK, SIT], 4500, ["pet_waste", "dog_walking"]);
    expect(opts.map((o) => o.id)).toEqual(["pw", "w"]);
  });

  it("the request handler refuses a Coming soon service before anything is saved", () => {
    const fns = read("src/lib/portal.functions.ts");
    const request = fns.slice(fns.indexOf("export const portalRequestOneOff"));
    const refusal = request.indexOf('oneOffRefusalMessage("service_not_offered")');
    expect(request).toMatch(
      /!\(BOOKABLE_SERVICE_LINES as readonly string\[\]\)\.includes\(service\.service_line\)/,
    );
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(request.indexOf('rpc("portal_request_one_off"'));
  });
});

describe("the AI receptionist", () => {
  it("does not list a walk", async () => {
    const { store, clientA } = twoBusinesses();
    const r: any = await listServices(store, clientA);
    expect(r.services.map((s: any) => s.service_id)).toEqual(["pw-a"]);
  });

  it("refuses to offer days for, or book, a walk", async () => {
    const { db, store, clientA } = twoBusinesses();
    const open: any = await getOpenSlots(store, clientA, { now: db.now, service_id: "walk-a" });
    expect(open).toMatchObject({ available: false, reason: "service_not_offered" });
    const r: any = await bookVisit(store, clientA, {
      date: "2026-10-13",
      service_id: "walk-a",
      now: db.now,
    });
    expect(r).toMatchObject({ booked: false, reason: "service_not_offered" });
    expect(db.tickets).toHaveLength(0);
    expect(db.visits).toHaveLength(0);
  });
});

describe("Settings → Services", () => {
  it("knows which lines are bookable from the launch list", () => {
    for (const line of SERVICE_LINES) {
      expect(isBookableServiceLine(line)).toBe(BOOKABLE_SERVICE_LINES.includes(line));
    }
    expect(isBookableServiceLine("pet_waste")).toBe(true);
    expect(isBookableServiceLine("dog_walking")).toBe(false);
    expect(isBookableServiceLine("pet_sitting")).toBe(false);
  });

  it("marks every non-bookable line Coming soon in the Kind of service picker, with the house badge", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/import \{ ComingSoonBadge \} from "@\/components\/ComingSoonBadge";/);
    const items = page.slice(page.indexOf("serviceLineChoices(lines, form.service_line).map"));
    const item = items.slice(0, items.indexOf("</SelectItem>"));
    expect(item).toMatch(/<SelectItem key=\{l\} value=\{l\}>/);
    expect(item).toMatch(/\{!isBookableServiceLine\(l\) && <ComingSoonBadge \/>\}/);
  });

  it("says under the picker that a Coming soon line can be set up but not booked", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/\{!isBookableServiceLine\(form\.service_line\) && \(/);
    expect(page).toMatch(/Coming soon: you can set this up now, but clients can't book it yet\./);
  });

  it("does not refuse to save one: createService has no bookable check", () => {
    const fns = read("src/lib/services.functions.ts");
    expect(fns).not.toMatch(/BOOKABLE_SERVICE_LINES|isBookableServiceLine/);
  });

  it("suggests a name for the kind of service chosen", () => {
    expect(serviceNamePlaceholder("pet_waste")).toBe("Weekly yard cleanup");
    expect(serviceNamePlaceholder("dog_walking")).toBe("30-minute walk");
    expect(serviceNamePlaceholder("pet_sitting")).toBe("Overnight stay");
    for (const line of SERVICE_LINES) expect(serviceNamePlaceholder(line)).toMatch(/\S/);
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/placeholder=\{serviceNamePlaceholder\(form\.service_line\)\}/);
  });
});

describe("Settings → Client portal", () => {
  it("no longer promises a walk, a sit or a groom; it says Coming soon is not offered", () => {
    const card = read("src/components/settings/PortalBookingCard.tsx");
    expect(card).not.toMatch(/a walk, a sit, a groom/);
    expect(card).toMatch(/once their kind of service is bookable; one marked Coming soon/);
  });
});

describe("Settings → Services, the list", () => {
  it("a row on a Coming soon line wears the same badge, beside the line label", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    const list = page.slice(page.indexOf('data-testid="services-list"'));
    const row = list.slice(0, list.indexOf("</li>"));
    const label = row.indexOf("{serviceLineLabel(s.service_line)}");
    const badge = row.indexOf("{!isBookableServiceLine(s.service_line) && <ComingSoonBadge />}");
    expect(label).toBeGreaterThan(0);
    expect(badge).toBeGreaterThan(label);
    // Next to the label: nothing but the label's own closing tag between them.
    expect(row.slice(label, badge)).toMatch(
      /^\{serviceLineLabel\(s\.service_line\)\}\s*<\/Badge>\s*$/,
    );
  });
});

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

// ── The database: 20261018150000 ─────────────────────────────────────────

describe("20261018150000, the same rule in the database", () => {
  const FILE = "supabase/migrations/20261018150000_a-coming-soon-service-is-not-for-sale.sql";
  const FILTER = "s.service_line = ANY (public.bookable_service_lines())";
  const codeOnly = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
  const body = (sql: string, fn: string, end: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    expect(start, fn).toBeGreaterThanOrEqual(0);
    return sql.slice(start, sql.indexOf(end, start) + end.length);
  };
  const norm = (s: string) => codeOnly(s).replace(/\s+/g, " ").trim();
  const FNS = [
    {
      fn: "public_services",
      end: "$$;",
      was: "supabase/migrations/20261011170000_training-is-a-service-line.sql",
    },
    {
      fn: "public_quote",
      end: "$$;",
      was: "supabase/migrations/20261011100000_a-walk-is-priced-as-a-walk.sql",
    },
    {
      fn: "portal_request_one_off",
      end: "$function$;",
      was: "supabase/migrations/20261011100200_a-customer-asks-for-a-walk.sql",
    },
  ];

  it("uses bookable_service_lines() from 20261017004000 rather than defining another", () => {
    expect(
      read("supabase/migrations/20261017004000_a-service-line-is-turned-on-only-when-bookable.sql"),
    ).toMatch(/CREATE OR REPLACE FUNCTION public\.bookable_service_lines\(\)/);
    expect(codeOnly(read(FILE))).not.toMatch(/FUNCTION public\.bookable_service_lines/);
  });

  it.each(FNS)(
    "$fn filters on the launch list and is otherwise its previous definition",
    ({ fn, end, was }) => {
      const now = body(read(FILE), fn, end);
      expect(now).toContain(FILTER);
      const before = body(read(was), fn, end);
      expect(before).not.toContain("bookable_service_lines");
      expect(norm(now).replaceAll(` AND ${FILTER}`, "")).toBe(norm(before));
    },
  );

  it("keeps each grant as it was", () => {
    const code = codeOnly(read(FILE));
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.public_services\(text\) FROM PUBLIC;/);
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.public_services\(text\) TO anon, authenticated, service_role;/,
    );
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.public_quote\(text, text, integer, text, text, uuid\) FROM PUBLIC;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.public_quote\(text, text, integer, text, text, uuid\)\s+TO anon, authenticated, service_role;/,
    );
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text, uuid\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text, uuid\) TO service_role;/,
    );
  });

  it("adds no trigger, constraint or policy: an owner can still set up a walk", () => {
    const code = codeOnly(read(FILE));
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i);
    expect(code).not.toMatch(/RETURNS\s+trigger/i);
    expect(code).not.toMatch(/ALTER\s+TABLE/i);
    expect(code).not.toMatch(/ADD\s+CONSTRAINT/i);
    expect(code).not.toMatch(/CREATE\s+POLICY/i);
  });
});
