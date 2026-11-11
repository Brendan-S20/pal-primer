// A quote from the directory is one lead, and Convert to client works on it
// (#630, phase 1).
//
// Driven through the SHIPPED /api/public/leads handler. Only the edges are
// fake: the service-role client (an in-memory leads table, and the two RPCs a
// directory quote calls), the anon client, and the office notification.
//
// What it pins:
//   * a quote names the business by its DIRECTORY slug; the server resolves
//     that with directory_org_for_quote (service role), never by portal slug;
//   * an unpublished or unknown slug writes nothing (404);
//   * the lead is source = 'directory', status 'new', and the office is told
//     once;
//   * the honeypot, the time check and the rate limit refuse it the same calm
//     way as any public form, before anything is written;
//   * a second quote from the same email to the same business within 24
//     hours is merged (still one lead, nobody told twice), and one from a
//     day ago is a new lead;
//   * nothing but a directory quote can write source = 'directory';
//   * the lead the directory wrote goes through Convert to client's mapping
//     with its name, email, phone, ZIP, dogs and message intact.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0d000000-0000-4000-8000-000000000630";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  leads: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Row }>,
  turn: "ok" as unknown,
  published: { "acme-scoop": "0d000000-0000-4000-8000-000000000630" } as Record<string, string>,
  notified: [] as Row[],
  portalOrg: "0d000000-0000-4000-8000-000000000630" as string | null,
}));

function query(rows: () => Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
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
    if (table === "leads") {
      const b = query(() => h.leads);
      b.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            const created = {
              id: `lead-${h.leads.length + 1}`,
              created_at: new Date().toISOString(),
              ...row,
            };
            h.leads.push(created);
            return { data: { id: created.id }, error: null };
          },
        }),
      });
      return b;
    }
    if (table === "organizations") return query(() => [{ id: ORG, lead_form_config: null }]);
    if (table === "zones") return query(() => []);
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    if (fn === "directory_org_for_quote")
      return { data: h.published[args._slug] ?? null, error: null };
    if (fn === "take_public_form_turn") return { data: h.turn, error: null };
    return { data: null, error: null };
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Row) => {
      h.rpcs.push({ fn: `anon:${fn}`, args });
      return fn === "public_get_org_for_lead_form"
        ? { data: h.portalOrg ? [{ id: h.portalOrg }] : [], error: null }
        : { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/lead-notify.server", () => ({
  notifyOfficeOfNewLead: async (n: Row) => {
    h.notified.push(n);
  },
}));

import { CALM_REFUSAL } from "@/lib/public-form-guard";
import { directoryQuoteBody } from "@/lib/directory";
import { leadOriginLabel } from "@/lib/new-customer-form";
import {
  leadConversionState,
  leadToWizardPrefill,
  type ConvertibleLead,
} from "@/lib/lead-conversion";

async function postLead(body: Record<string, unknown>, ip = "203.0.113.30") {
  const mod = await import("@/routes/api/public/leads");
  const POST = (
    mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers.POST;
  const res = await POST({
    request: new Request("https://app.houndstack.com/api/public/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const QUOTE = {
  ...directoryQuoteBody("acme-scoop", {
    name: "Rosa Delgado",
    email: "Rosa@Example.test",
    phone: "313-555-0100",
    zip: "48201",
    service_line: "pet_waste",
    dog_count: "2",
    message: "Weekly, starting next month.",
  }),
  website_url: "",
  elapsed_ms: 25_000,
};

beforeEach(() => {
  h.leads = [];
  h.rpcs = [];
  h.turn = "ok";
  h.notified = [];
  h.published = { "acme-scoop": ORG };
  h.portalOrg = ORG;
});

describe("a directory quote, through the shipped endpoint", () => {
  it("writes exactly one new lead, source 'directory', and tells the office once", async () => {
    const r = await postLead(QUOTE);
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0]).toMatchObject({
      organization_id: ORG,
      name: "Rosa Delgado",
      email: "rosa@example.test",
      phone: "313-555-0100",
      location: "48201",
      dog_count: 2,
      source: "directory",
      status: "new",
    });
    expect(h.leads[0].message).toContain("Asked about: Pet waste removal.");
    expect(h.leads[0].message).toContain("Weekly, starting next month.");
    expect(h.leads[0]).not.toHaveProperty("directory_slug");
    expect(h.leads[0]).not.toHaveProperty("website_url");
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ orgId: ORG, source: "directory" });
    // Resolved by the directory, with the service role; never by portal slug.
    const fns = h.rpcs.map((c) => c.fn);
    expect(fns).toContain("directory_org_for_quote");
    expect(fns).not.toContain("anon:public_get_org_for_lead_form");
    expect(fns).toContain("take_public_form_turn");
  });

  it("writes nothing for a slug that is not published (or does not exist)", async () => {
    h.published = {};
    const r = await postLead(QUOTE);
    expect(r.status).toBe(404);
    expect(h.leads).toEqual([]);
    expect(h.notified).toEqual([]);
  });

  it.each([
    ["a filled honeypot", { website_url: "https://cheap-pills.example" }],
    ["a submission faster than anyone types", { elapsed_ms: 400 }],
    ["a body with no clock", { elapsed_ms: undefined }],
  ])("refuses %s calmly, before it resolves anything, and writes nothing", async (_l, patch) => {
    const r = await postLead({ ...QUOTE, ...patch });
    expect(r).toEqual({ status: 400, body: { error: CALM_REFUSAL } });
    expect(h.rpcs).toEqual([]);
    expect(h.leads).toEqual([]);
  });

  it.each(["address", "business"])("refuses when the %s is over its share", async (verdict) => {
    h.turn = verdict;
    const r = await postLead(QUOTE);
    expect(r).toEqual({ status: 429, body: { error: CALM_REFUSAL } });
    expect(h.leads).toEqual([]);
    expect(h.notified).toEqual([]);
  });

  it("merges a second quote from the same email within 24 hours: still one lead, told once", async () => {
    await postLead(QUOTE);
    const again = await postLead({ ...QUOTE, email: "rosa@EXAMPLE.test", message: "Me again" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, merged: true });
    expect(h.leads).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    // The repeat still took a turn, so a script repeating itself is limited.
    expect(h.rpcs.filter((c) => c.fn === "take_public_form_turn")).toHaveLength(2);
  });

  it("does not merge one from a day and a half ago, or a different person", async () => {
    h.leads.push({
      id: "old",
      organization_id: ORG,
      email: "rosa@example.test",
      source: "directory",
      created_at: new Date(Date.now() - 36 * 3_600_000).toISOString(),
    });
    await postLead(QUOTE);
    await postLead({ ...QUOTE, email: "sam@example.test" });
    expect(h.leads.filter((l) => l.id !== "old")).toHaveLength(2);
  });

  it("will not let anything but a directory quote write source 'directory'", async () => {
    const { directory_slug: _d, ...rest } = QUOTE;
    const r = await postLead({ ...rest, slug: "acme-portal", source: "directory" });
    expect(r.status).toBe(400);
    expect(h.leads).toEqual([]);
  });

  it("takes exactly one of slug and directory_slug", async () => {
    const both = await postLead({ ...QUOTE, slug: "acme-portal" });
    expect(both.status).toBe(400);
    const { directory_slug: _d, ...neither } = QUOTE;
    const none = await postLead({ ...neither, source: "website" });
    expect(none.status).toBe(400);
    expect(h.leads).toEqual([]);
  });

  it("leaves a website quote exactly as it was", async () => {
    const { directory_slug: _d, ...rest } = QUOTE;
    const r = await postLead({ ...rest, slug: "acme-portal", source: "website" });
    expect(r.status).toBe(201);
    expect(h.leads[0]).toMatchObject({ source: "website" });
    expect(h.rpcs.map((c) => c.fn)).not.toContain("directory_org_for_quote");
  });
});

describe("Convert to client, on the lead the directory wrote", () => {
  it("is offered, and keeps who they are, where they are, their dogs and their words", async () => {
    await postLead(QUOTE);
    const row = h.leads[0];
    const lead: ConvertibleLead = {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      company: row.company ?? null,
      location: row.location,
      dog_count: row.dog_count,
      frequency: row.frequency ?? null,
      message: row.message,
      source: row.source,
      status: row.status,
      converted_client_id: null,
    };
    expect(leadConversionState(lead)).toEqual({ kind: "convertible" });
    const prefill = leadToWizardPrefill(lead);
    expect(prefill.displayName).toBe("Rosa Delgado");
    expect(prefill.primaryEmail).toBe("rosa@example.test");
    expect(prefill.primaryPhone).toBe("313-555-0100");
    expect(prefill.postalCode).toBe("48201");
    expect(prefill.dogs).toHaveLength(2);
    expect(prefill.officeNote).toContain("Asked about: Pet waste removal.");
    expect(leadOriginLabel("directory", null)).toBe("Quote request from the HoundStack directory");
  });
});
