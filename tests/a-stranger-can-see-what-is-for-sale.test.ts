// A stranger can see what is for sale: the service catalog, phase 5, the
// public paths (migration 20261011150000).
//
// Phase 5 taught public_quote to price a service and nothing public passed it
// one. This change lets a visitor on /signup/{slug} see the business's
// services (public_services, the one anon door onto `services`), pick one,
// be quoted and charged for THAT, and have the pick recorded on the lead and
// the signup so the office knows what was asked for.
//
// The rule every part of it is held to: a business that sells one thing sees
// the form it always saw. No picker, no service id in any request, no
// service_id on its lead or its signup, the same quote and the same charge.
// Pet waste is that business today, and its path is byte-for-byte unchanged.
//
// What this file pins:
//   1. the migration: the function, its gate, its grants, its columns
//   2. the pure rules the form reads (lib/public-services.ts)
//   3. the form: picker only with a choice, the id sent to both buttons
//   4. the lead endpoint, end to end: the service recorded and named to the
//      office; another business's id refused; no id, the row it always was
//   5. the webhook puts the picked service on the plan, and only then
// The signup handler itself is driven in
// tests/the-signup-sells-what-was-picked.test.ts, and the SQL in
// tests/sql/a-stranger-can-see-what-is-for-sale.proof.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { withBookable } from "./support/service-line-availability";
import { join } from "node:path";
import {
  asksAboutTheYard,
  chosenPublicService,
  defaultPublicServiceId,
  offersAChoice,
  publicServiceChoices,
  publicServiceOptionLabel,
} from "@/lib/public-services";

const ROOT = join(import.meta.dirname, "..");

// This file pins how the catalog sells a walk or a groom once their lines are
// bookable. Today only pet waste is (#506), and what a Coming soon line is
// refused is pinned in tests/a-coming-soon-service-is-not-offered.test.ts; so
// here every offered line is treated as launched on the switch (#531).
// Every offered line launched and, but for training, open to customers: the
// switch as it would read once grooming and sitting go live.
const ALL_LIVE = {
  bookable: withBookable("pet_sitting", "mobile_grooming", "training").bookable,
  customerRequestable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "other"],
} as const;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(--|\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join("\n");

const MIGRATION = "supabase/migrations/20261011150000_a-stranger-can-see-what-is-for-sale.sql";

// ── 1. The migration ────────────────────────────────────────────────────────

describe("20261011150000", () => {
  const sql = read(MIGRATION);
  const code = codeOnly(sql);

  it("creates public_services over a slug and nothing else", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.public_services\(_slug text\)/);
    expect(code).toMatch(/STABLE SECURITY DEFINER/);
    expect(code).toMatch(/SET search_path TO 'public'/);
  });

  it("resolves the business exactly as public_quote does, gate included", () => {
    const quote = codeOnly(
      read("supabase/migrations/20261011100000_a-walk-is-priced-as-a-walk.sql"),
    );
    const resolution = (src: string) =>
      src.match(
        /SELECT \* INTO _org FROM public\.organizations o\s+WHERE \(o\.portal_slug = _slug OR o\.slug = _slug\)\s+AND o\.public_signup_enabled = true\s+AND o\.deleted_at IS NULL\s+ORDER BY \(o\.portal_slug = _slug\) DESC NULLS LAST\s+LIMIT 1;/,
      )?.[0];
    expect(
      resolution(code),
      "public_services does not resolve the slug the way public_quote does",
    ).toBeTruthy();
    expect(resolution(quote)).toBeTruthy();
    expect(resolution(code)!.replace(/\s+/g, " ")).toBe(resolution(quote)!.replace(/\s+/g, " "));
  });

  it("lists active services that are priced, plus the zone-priced pet-waste one, in the Services page's order", () => {
    const body = code.slice(code.indexOf("RETURN QUERY"), code.indexOf("END;\n$$;"));
    expect(body).toMatch(/s\.organization_id = _org\.id/);
    expect(body).toMatch(/AND s\.active/);
    expect(body).toMatch(/\(s\.service_line = 'pet_waste' OR s\.base_price_cents IS NOT NULL\)/);
    expect(body).toMatch(
      /array_position\(ARRAY\['pet_waste','dog_walking','pet_sitting','mobile_grooming','other'\], s\.service_line\)/,
    );
    expect(body).toMatch(/lower\(s\.name\)/);
  });

  it("returns service columns only: no organization id, slug, key or setting", () => {
    const returns = code.slice(code.indexOf("RETURNS TABLE("), code.indexOf("LANGUAGE plpgsql"));
    expect(returns).toMatch(/id uuid/);
    expect(returns).toMatch(/name text/);
    expect(returns).toMatch(/service_line text/);
    expect(returns).toMatch(/price_unit text/);
    expect(returns).toMatch(/base_price_cents integer/);
    expect(returns).toMatch(/extra_pet_cents integer/);
    expect(returns).toMatch(/default_duration_min integer/);
    expect(returns).not.toMatch(/organization|slug|stripe|key|email|phone|enabled|config/i);
    // And the $post$ block refuses a future edit that adds one.
    expect(code).toMatch(
      /_ret ~\* 'organization\|slug\|stripe\|key\|email\|phone\|enabled\|config'/,
    );
  });

  it("revokes PUBLIC first, then grants anon, authenticated and service_role, in that order", () => {
    const revoke = code.indexOf("REVOKE ALL ON FUNCTION public.public_services(text) FROM PUBLIC;");
    const grant = code.indexOf(
      "GRANT EXECUTE ON FUNCTION public.public_services(text) TO anon, authenticated, service_role;",
    );
    expect(revoke).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(revoke);
    // The table stays shut: the function is the door.
    expect(code).toMatch(/has_table_privilege\('anon', 'public\.services', 'SELECT'\)/);
    expect(code).not.toMatch(/GRANT[^;]*ON (TABLE )?public\.services\b/);
  });

  it("is on the anon allowlist with a caller, and nothing else new is", () => {
    const lockdown = read(
      "tests/the-lockdown-that-only-held-for-the-functions-that-existed-that-day.test.ts",
    );
    expect(lockdown).toMatch(/public_services:\s*\n?\s*"[^"]*getPublicSignupForm[^"]*"/);
    // One function created here, and it is the allowlisted one.
    const created = [...code.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)/g)].map(
      (m) => m[1],
    );
    expect(created).toEqual(["public_services"]);
  });

  it("adds nullable service_id to leads and signup_requests, set null when the service goes, each indexed", () => {
    for (const t of ["leads", "signup_requests"]) {
      expect(code).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${t}\\s+ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public\\.services\\(id\\) ON DELETE SET NULL;`,
        ),
      );
      expect(code).toMatch(
        new RegExp(
          `CREATE INDEX IF NOT EXISTS ${t}_service_id_idx ON public\\.${t} \\(service_id\\)\\s+WHERE service_id IS NOT NULL;`,
        ),
      );
    }
    expect(code).not.toMatch(/NOT NULL DEFAULT/);
  });

  it("creates no trigger function and no table, so the trigger count stays where it is", () => {
    expect(code).not.toMatch(/RETURNS (event_)?trigger/i);
    expect(code).not.toMatch(/CREATE TABLE/i);
  });

  it("the generated types know the function and the columns", () => {
    const types = read("src/integrations/supabase/types.ts");
    expect(types).toMatch(/public_services: \{\s*Args: \{ _slug: string \}/);
    const leads = types.slice(
      types.indexOf("      leads: {"),
      types.indexOf("      live_activity_tokens: {"),
    );
    expect(leads).toMatch(/service_id: string \| null/);
    expect(leads).toMatch(/referencedRelation: "services"/);
    const sr = types.slice(types.indexOf("      signup_requests: {"));
    expect(sr.slice(0, sr.indexOf("Relationships") + 900)).toMatch(/service_id: string \| null/);
  });
});

// ── 2. The rules the form reads ─────────────────────────────────────────────

const PW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Pet waste removal",
  service_line: "pet_waste",
  price_unit: "visit",
  base_price_cents: null,
  extra_pet_cents: 0,
  default_duration_min: null,
};
const WALK = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "30-minute walk",
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2500,
  extra_pet_cents: 500,
  default_duration_min: 30,
};
const GROOM = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Full groom",
  service_line: "mobile_grooming",
  price_unit: "hour",
  base_price_cents: 6000,
  extra_pet_cents: 1000,
  default_duration_min: 90,
};
const SIT = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Drop-in visit",
  service_line: "pet_sitting",
  price_unit: "visit",
  base_price_cents: 3000,
  extra_pet_cents: 500,
  default_duration_min: 90,
};
const TRAIN = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Private lesson",
  service_line: "training",
  price_unit: "visit",
  base_price_cents: 8000,
  extra_pet_cents: 0,
  default_duration_min: 60,
};

describe("what a stranger may pick from", () => {
  it("lists every launched service, the groom and the lesson included (#560)", () => {
    // Brendan, 2026-10-28: walking, training and grooming are self-serve on
    // the booking link. A groom is priced per pet size and requested; a
    // lesson is priced and started like a walk (bookingLinkOffersLine).
    expect(publicServiceChoices([PW, GROOM, WALK, TRAIN], ALL_LIVE).map((r) => r.id)).toEqual([
      PW.id,
      GROOM.id,
      WALK.id,
      TRAIN.id,
    ]);
  });

  it("keeps the rows the RPC returned, in its order, and drops anything malformed", () => {
    const rows = publicServiceChoices(
      [PW, WALK, { id: 1, name: "bad" }, null, { ...GROOM, price_unit: "week" }, WALK],
      ALL_LIVE,
    );
    expect(rows.map((r) => r.id)).toEqual([PW.id, WALK.id]);
    expect(publicServiceChoices(undefined, ALL_LIVE)).toEqual([]);
    expect(publicServiceChoices("nope", ALL_LIVE)).toEqual([]);
  });

  it("one service, or none, is no choice: the form as it always was", () => {
    expect(offersAChoice([])).toBe(false);
    expect(offersAChoice(publicServiceChoices([PW], ALL_LIVE))).toBe(false);
    expect(offersAChoice(publicServiceChoices([WALK], ALL_LIVE))).toBe(false);
    expect(defaultPublicServiceId(publicServiceChoices([PW], ALL_LIVE))).toBeNull();
    expect(chosenPublicService(publicServiceChoices([PW], ALL_LIVE), PW.id)).toBeNull();
    expect(chosenPublicService(publicServiceChoices([WALK], ALL_LIVE), WALK.id)).toBeNull();
  });

  it("with a choice, starts on the pet-waste service when there is one, else the first listed", () => {
    expect(defaultPublicServiceId(publicServiceChoices([WALK, PW], ALL_LIVE))).toBe(PW.id);
    expect(defaultPublicServiceId(publicServiceChoices([WALK, SIT], ALL_LIVE))).toBe(WALK.id);
    expect(chosenPublicService(publicServiceChoices([PW, WALK], ALL_LIVE), "")?.id).toBe(PW.id);
    expect(chosenPublicService(publicServiceChoices([PW, WALK], ALL_LIVE), WALK.id)?.id).toBe(
      WALK.id,
    );
    // An id that is not listed (a service retired since the page loaded)
    // falls back to the default rather than being sent.
    expect(chosenPublicService(publicServiceChoices([PW, WALK], ALL_LIVE), GROOM.id)?.id).toBe(
      PW.id,
    );
  });

  it("asks about the yard with no choice made and for pet waste; a walk has no yard", () => {
    expect(asksAboutTheYard(null)).toBe(true);
    expect(asksAboutTheYard(publicServiceChoices([PW], ALL_LIVE)[0])).toBe(true);
    expect(asksAboutTheYard(publicServiceChoices([WALK], ALL_LIVE)[0])).toBe(false);
  });

  it("labels an option with the business's name and its length, never a price", () => {
    const [pw, walk, sit] = publicServiceChoices([PW, WALK, SIT], ALL_LIVE);
    expect(publicServiceOptionLabel(pw)).toBe("Pet waste removal");
    // The name already says its length, so it is not said twice (#560).
    expect(publicServiceOptionLabel(walk)).toBe("30-minute walk");
    expect(publicServiceOptionLabel(sit)).toBe("Drop-in visit (1 hr 30 min)");
    for (const s of [pw, walk, sit]) expect(publicServiceOptionLabel(s)).not.toMatch(/\$|\d\.\d\d/);
  });
});

// ── 3. The form ─────────────────────────────────────────────────────────────

describe("the public form", () => {
  const flow = read("src/components/signup/SignupFlow.tsx");
  const fns = read("src/lib/signup.functions.ts");

  it("learns what is for sale from the one lookup it already makes, through public_services", () => {
    const lookup = fns.slice(
      fns.indexOf("export const getPublicSignupForm"),
      fns.indexOf("const quoteSchema"),
    );
    expect(lookup).toMatch(/sb\.rpc\("public_services", \{\s*_slug: data\.slug,?\s*\}\)/);
    expect(lookup).toMatch(/services,\s*serviceLines,\s*extras,\s*\};/);
    // A lookup that fails lists nothing; the page still loads.
    expect(lookup).toMatch(/let services: PublicService\[\] = \[\];/);
    expect(lookup).toMatch(/services = publicServiceChoices\(svcRows, availability\);/);
    expect(flow).toMatch(
      /publicServiceChoices\(\s*formQ\.data\?\.services,\s*formQ\.data\?\.serviceLines/,
    );
  });

  it("shows the picker only when there is a choice, and sends the id with both buttons and the quote", () => {
    expect(flow).toMatch(/const pickService = offersAChoice\(services\);/);
    expect(flow).toMatch(/\{pickService && \(\s*<div[^>]*>\s*<Label htmlFor="service">/);
    expect(flow).toMatch(/const serviceField = chosen \? \{ service_id: chosen\.id \} : \{\};/);
    // The quote, the checkout and the quote request: three sends, one source.
    expect(flow.match(/\.\.\.serviceField/g)?.length).toBe(3);
    const quoteCall = flow.slice(
      flow.indexOf("const quoteMut"),
      flow.indexOf("// Payment happens right here"),
    );
    expect(quoteCall).toMatch(/\.\.\.serviceField/);
    const checkoutCall = flow.slice(
      flow.indexOf("const checkoutMut"),
      flow.indexOf("const [sent, setSent]"),
    );
    expect(checkoutCall).toMatch(/\.\.\.serviceField/);
    const leadCall = flow.slice(
      flow.indexOf("const leadMut"),
      flow.indexOf("const branch = decideFormBranch"),
    );
    expect(leadCall).toMatch(/\.\.\.serviceField/);
  });

  it("sends an id and never a price or a name for the service", () => {
    expect(flow).not.toMatch(/service_name|service_price|base_price_cents:/);
    expect(fns).toMatch(/service_id: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    const api = read("src/routes/api/public/leads.ts");
    expect(api).toMatch(/service_id: z\.string\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/);
  });

  it("asks about the yard only for pet waste, and drops a quote when the service changes", () => {
    expect(flow).toMatch(/asksAboutTheYard\(chosen\)\s*\? formQ\.data\.firstCleanup\.tiers/);
    const picker = flow.slice(
      flow.indexOf('<Label htmlFor="service">'),
      flow.indexOf("{fields.location && ("),
    );
    expect(picker).toMatch(/quoteMut\.reset\(\)/);
    expect(picker).toMatch(/last_cleaned: ""/);
    expect(picker).toMatch(/publicServiceOptionLabel\(s\)/);
  });

  it("passes the service to public_quote on both calls, as an id, from one argument builder", () => {
    expect(fns).toMatch(
      /\.\.\.\(data\.service_id \? \{ _service_id: data\.service_id \} : \{\}\),/,
    );
    // `asked` is the body with only its cadence set by the service's booking
    // mode (quoteDataFor, #574): the same ids, never a price.
    expect(fns.match(/sb\.rpc\("public_quote", publicQuoteArgs\(asked\)\)/g)?.length).toBe(2);
    expect(fns.match(/const asked = quoteDataFor\(data, terms\);/g)?.length).toBe(2);
    // And no price-shaped key anywhere near the call.
    const args = fns.slice(
      fns.indexOf("function publicQuoteArgs"),
      fns.indexOf("export const getSignupQuote"),
    );
    expect(args).not.toMatch(/cents|price|amount/i);
  });

  it("the signup row and the signup lead carry the service only when one was picked", () => {
    const checkout = fns.slice(fns.indexOf("export const createSignupPaymentIntent"));
    expect(checkout).toMatch(
      /\.\.\.\(data\.service_id \? \{ service_id: data\.service_id \} : \{\}\),/,
    );
    expect(checkout).toMatch(/serviceId: data\.service_id \?\? null,/);
    const lead = fns.slice(fns.indexOf("export async function recordSignupLead"));
    expect(lead).toMatch(/\.\.\.\(lead\.serviceId \? \{ service_id: lead\.serviceId \} : \{\}\),/);
    expect(lead).toMatch(/serviceName: lead\.serviceName \?\? null,/);
  });

  it("refuses to charge a service the database could not price, in words a visitor can act on", async () => {
    const { signupChargeFromQuote, SERVICE_NOT_PRICED } = await import("@/lib/signup-charge");
    expect(() =>
      signupChargeFromQuote({
        initial_cleanup_cents: 0,
        recurring_price_cents: null,
        first_cleanup_mode: "off",
      }),
    ).toThrow(SERVICE_NOT_PRICED);
    expect(SERVICE_NOT_PRICED).not.toMatch(/—/);
    // The pet-waste quote is never null here, so the pet-waste charge is unchanged.
    expect(
      signupChargeFromQuote({
        initial_cleanup_cents: 0,
        recurring_price_cents: 2500,
        first_cleanup_mode: "off",
      }),
    ).toEqual({
      firstCleanupCents: 0,
      recurringCents: 2500,
      amountCents: 2500,
      firstCleanupLabel: null,
    });
  });

  it("says nothing with an em dash to a visitor", () => {
    const copy = [
      ...flow.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g),
      ...flow.matchAll(/"([^"\n]*[A-Za-z][^"\n]*)"/g),
    ].map((m) => m[1]);
    expect(copy.filter((c) => c.includes("—"))).toEqual([]);
  });
});

// ── 4. The webhook ──────────────────────────────────────────────────────────

describe("the plan a signup provisions", () => {
  it("carries the service picked, and only then", () => {
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    const sub = hook.slice(
      hook.indexOf('await supabaseAdmin.from("subscriptions").insert({'),
      hook.indexOf("if (subErr) throw new Error(subErr.message);"),
    );
    expect(sub).toMatch(
      /\.\.\.\(sr\.service_id \? \{ service_id: sr\.service_id as string \} : \{\}\),/,
    );
    // Nothing else about the insert moved: the price is still the signup's.
    expect(sub).toMatch(/price_cents: sr\.recurring_price_cents,/);
    expect(sub).toMatch(/billing_cadence: "prepaid",/);
  });
});

// ── 5. The lead endpoint, end to end ────────────────────────────────────────

type Row = Record<string, any>;
const ORG = "0f000000-0000-4000-8000-00000000a1ea";
const OTHER_ORG = "0f000000-0000-4000-8000-00000000b2eb";

const h = vi.hoisted(() => ({
  leads: [] as Row[],
  services: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Row }>,
  notices: [] as Row[],
}));

/** A query builder over an array: every filter narrows, awaiting it answers. */
function query(rows: () => Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({
      data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null,
      error: null,
    }),
    then: (res: any, rej: any) =>
      Promise.resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }).then(
        res,
        rej,
      ),
  };
  return b;
}

const admin = {
  from(table: string): any {
    if (table === "services") return query(() => h.services);
    if (table === "leads") {
      const b = query(() => h.leads);
      b.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            const created = { id: `lead-${h.leads.length + 1}`, ...row };
            h.leads.push(created);
            return { data: { id: created.id }, error: null };
          },
        }),
      });
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    return { data: "ok", error: null };
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
// This file pins how the catalog sells a walk, a sit or a groom once their lines are
// bookable. What a Coming soon line is refused is pinned in
// tests/a-coming-soon-service-is-not-offered.test.ts; so here every offered
// line is treated as launched, as ALL_LIVE says.
vi.mock("@/lib/service-line-availability.server", async () => ({
  loadServiceLineAvailability: async () => ({
    bookable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training", "other"],
    customerRequestable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "other"],
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string) =>
      fn === "public_get_org_for_lead_form"
        ? { data: [{ id: ORG }], error: null }
        : { data: null, error: null },
  }),
}));
vi.mock("@/lib/lead-notify.server", () => ({
  notifyOfficeOfNewLead: async (lead: Row) => {
    h.notices.push(lead);
  },
}));

async function postLead(body: Record<string, unknown>) {
  const mod = await import("@/routes/api/public/leads");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  const res = await POST({
    request: new Request("https://app.houndstack.com/api/public/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const QUOTE = {
  slug: "whitfield",
  name: "Marguerite Okonkwo",
  email: "marguerite@example.test",
  phone: "",
  location: "612 Maple St, Southfield, MI 48037",
  dog_count: 2,
  frequency: "weekly",
  message: "",
  source: "website",
  website_url: "",
  elapsed_ms: 38_000,
};

beforeEach(() => {
  h.leads = [];
  h.rpcs = [];
  h.notices = [];
  h.services = [
    {
      id: WALK.id,
      organization_id: ORG,
      name: "30-minute walk",
      service_line: "dog_walking",
      active: true,
    },
    {
      id: GROOM.id,
      organization_id: OTHER_ORG,
      name: "Full groom",
      service_line: "mobile_grooming",
      active: true,
    },
    {
      id: PW.id,
      organization_id: ORG,
      name: "Old walk",
      service_line: "dog_walking",
      active: false,
    },
  ];
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
});

describe("a quote request that names a service, through the shipped endpoint", () => {
  it("records the service on the lead and names it to the office", async () => {
    const r = await postLead({ ...QUOTE, service_id: WALK.id });
    expect(r).toEqual({ status: 201, body: { ok: true } });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0]).toMatchObject({ organization_id: ORG, service_id: WALK.id, status: "new" });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ orgId: ORG, serviceName: "30-minute walk" });
    // The filters stand where they stood: screened, then a turn, then the write.
    expect(h.rpcs.map((c) => c.fn)).toEqual(["take_public_form_turn"]);
  });

  it("without a service is the row it always was: no service_id key at all", async () => {
    const r = await postLead(QUOTE);
    expect(r.status).toBe(201);
    expect(h.leads[0]).not.toHaveProperty("service_id");
    expect(h.notices[0]).toMatchObject({ serviceName: null });
  });

  it("refuses another business's service as malformed input, before a turn is taken, and writes nothing", async () => {
    const r = await postLead({ ...QUOTE, service_id: GROOM.id });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Invalid input" });
    expect(h.rpcs).toEqual([]);
    expect(h.leads).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("refuses an id that is not a uuid the same way, so a name cannot be smuggled in", async () => {
    const r = await postLead({ ...QUOTE, service_id: "30-minute walk" });
    expect(r.status).toBe(400);
    expect(h.leads).toEqual([]);
  });

  it("still records a service this business has since retired: the person asked for it", async () => {
    const r = await postLead({ ...QUOTE, service_id: PW.id });
    expect(r.status).toBe(201);
    expect(h.leads[0]).toMatchObject({ service_id: PW.id });
    expect(h.notices[0]).toMatchObject({ serviceName: "Old walk" });
  });

  it("the honeypot and the clock still stand in front of it", async () => {
    const r = await postLead({ ...QUOTE, service_id: WALK.id, elapsed_ms: 400 });
    expect(r.status).toBe(400);
    expect(h.leads).toEqual([]);
    expect(h.rpcs).toEqual([]);
  });

  it("the office's notice says the service after the yard", async () => {
    const { leadNotice } = await vi.importActual<typeof import("@/lib/lead-notify.server")>(
      "@/lib/lead-notify.server",
    );
    expect(
      leadNotice({
        name: "Marguerite Okonkwo",
        source: "website",
        location: "612 Maple St",
        dogCount: 2,
        frequency: "weekly",
        serviceName: "30-minute walk",
      }).body,
    ).toBe("Asked for a quote · 612 Maple St · 2 dogs · Weekly · 30-minute walk");
    // And with none, word for word what it said before.
    expect(
      leadNotice({
        name: "M",
        source: "website",
        location: "612 Maple St",
        dogCount: 2,
        frequency: "weekly",
      }).body,
    ).toBe("Asked for a quote · 612 Maple St · 2 dogs · Weekly");
  });

  it("Leads reads the name back beside the dogs", () => {
    expect(read("src/lib/leads.functions.ts")).toMatch(/service:services\(name\)/);
    expect(read("src/routes/_authenticated/leads.tsx")).toMatch(/\(l as any\)\.service\?\.name/);
  });
});
