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
//     hours is merged into the OPEN lead (still one lead) and recorded on it:
//     the new ask is appended, updated_at moves, and the office is told once
//     more as a repeat; a double tap is recorded and tells nobody; a lead the
//     office already acted on takes no merge; one from a day ago is a new
//     lead (#920);
//   * nothing but a directory quote can write source = 'directory';
//   * the lead the directory wrote goes through Convert to client's mapping
//     with its name, email, phone, ZIP, dogs and message intact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0d000000-0000-4000-8000-000000000630";
const WEEKLY = "0d000000-0000-4000-8000-0000000009a1";
const DEEP_CLEAN = "0d000000-0000-4000-8000-0000000009a2";
const SERVICES = [
  {
    id: WEEKLY,
    organization_id: ORG,
    name: "Weekly scoop",
    service_line: "pet_waste",
    price_unit: "visit",
  },
  {
    id: DEEP_CLEAN,
    organization_id: ORG,
    name: "Deep clean",
    service_line: "pet_waste",
    price_unit: "visit",
  },
];

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  leads: [] as Row[],
  activity: [] as Row[],
  repeats: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Row }>,
  turn: "ok" as unknown,
  published: { "acme-scoop": "0d000000-0000-4000-8000-000000000630" } as Record<string, string>,
  notified: [] as Row[],
  portalOrg: "0d000000-0000-4000-8000-000000000630" as string | null,
}));

/** A column, or PostgREST's `meta->>key` read of a json one. */
function field(r: Row, c: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(c);
  return m ? r[m[1]]?.[m[2]] : r[c];
}

function query(rows: () => Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => field(r, c) === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
    // Newest first: every ordered read here is `created_at desc`.
    order: () => ((b.desc = true), b),
    limit: () => b,
    maybeSingle: async () => {
      const hits = rows().filter((r) => filters.every((f) => f(r)));
      if (b.desc) hits.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      return { data: hits[0] ?? null, error: null };
    },
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
            const at = new Date().toISOString();
            const created = {
              id: `lead-${h.leads.length + 1}`,
              created_at: at,
              updated_at: at,
              ...row,
            };
            h.leads.push(created);
            return { data: { id: created.id }, error: null };
          },
        }),
      });
      b.update = (patch: Row) => {
        const u = query(() => h.leads);
        u.select = () => u;
        const single = u.maybeSingle;
        u.maybeSingle = async () => {
          const { data } = await single();
          if (data) Object.assign(data, patch);
          return { data: data ? { id: data.id } : null, error: null };
        };
        return u;
      };
      return b;
    }
    if (table === "activity_log") {
      const b = query(() => h.activity);
      b.insert = async (row: Row) => {
        h.activity.push({
          id: `act-${h.activity.length + 1}`,
          created_at: new Date().toISOString(),
          ...row,
        });
        return { error: null };
      };
      return b;
    }
    if (table === "staff") return query(() => []);
    if (table === "services") return query(() => SERVICES);
    if (table === "organizations") return query(() => [{ id: ORG, lead_form_config: null }]);
    if (table === "zones") return query(() => []);
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    if (fn === "directory_org_for_quote")
      return { data: h.published[args._slug] ?? null, error: null };
    if (fn === "take_public_form_turn") return { data: h.turn, error: null };
    if (fn === "service_line_availability")
      return { data: [{ service_line: "pet_waste", bookable: true }], error: null };
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
  notifyOfficeOfRepeatLead: async (n: Row) => {
    h.repeats.push(n);
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
  h.activity = [];
  h.repeats = [];
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
    expect(h.leads[0].message).toContain("Asked about: Poop scooping.");
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

  it("a repeat still takes a rate-limit turn, so a script repeating itself is limited", async () => {
    await postLead(QUOTE);
    await postLead({ ...QUOTE, message: "Me again" });
    expect(h.rpcs.filter((c) => c.fn === "take_public_form_turn")).toHaveLength(2);
  });
});

describe("a repeat directory quote within 24 hours (#920)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Post at a fixed clock time, so updated_at and the double-tap window are
   *  measured rather than assumed. Only Date is faked: promises still run. */
  async function postAt(iso: string, body: Record<string, unknown>) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    try {
      return await postLead(body);
    } finally {
      vi.useRealTimers();
    }
  }

  it("leaves one lead, records the new message and service on it, moves updated_at, and is told once as a repeat", async () => {
    await postAt("2026-11-13T03:48:03Z", { ...QUOTE, service_id: WEEKLY });
    const original = h.leads[0].message as string;
    const createdUpdatedAt = h.leads[0].updated_at;

    const again = await postAt("2026-11-13T11:42:00Z", {
      ...QUOTE,
      email: "rosa@EXAMPLE.test",
      service_id: DEEP_CLEAN,
      dog_count: 3,
      message: "Me again: we got a third dog, gate code is 4411.",
    });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, merged: true });
    // One row.
    expect(h.leads).toHaveLength(1);
    const lead = h.leads[0];
    // The original ask is untouched: columns and the start of the message.
    expect(lead.service_id).toBe(WEEKLY);
    expect(lead.dog_count).toBe(2);
    expect(lead.message.startsWith(original)).toBe(true);
    // The new ask is on the lead, dated, with the service and what changed.
    expect(lead.message).toContain("--- Asked again 2026-11-13 11:42 UTC ---");
    expect(lead.message).toContain("Service: Deep clean (new)");
    expect(lead.message).toContain("Dogs: 3 (was 2)");
    expect(lead.message).toContain("Me again: we got a third dog, gate code is 4411.");
    expect(lead.message.length).toBeLessThanOrEqual(2000);
    // It moved back up in Leads.
    expect(lead.updated_at).toBe("2026-11-13T11:42:00.000Z");
    expect(lead.updated_at > createdUpdatedAt).toBe(true);
    // And it is in activity_log in full, on that lead.
    expect(h.activity).toHaveLength(1);
    expect(h.activity[0]).toMatchObject({
      organization_id: ORG,
      client_id: null,
      kind: "lead.repeat_request",
      meta: {
        lead_id: lead.id,
        double_tap: false,
        service_id: DEEP_CLEAN,
        service_name: "Deep clean",
        dog_count: 3,
      },
    });
    // Told exactly once more: the new-lead notice, then one repeat notice.
    expect(h.notified).toHaveLength(1);
    expect(h.repeats).toHaveLength(1);
    expect(h.repeats[0]).toMatchObject({
      orgId: ORG,
      leadId: lead.id,
      name: "Rosa Delgado",
      serviceName: "Deep clean",
      dogCount: 3,
    });
    expect(h.repeats[0].requestId).toBe(h.activity[0].meta.request_id);
  });

  it("gives each repeat its own request id, so the notice index does not swallow the second", async () => {
    await postAt("2026-11-13T03:00:00Z", QUOTE);
    await postAt("2026-11-13T05:00:00Z", { ...QUOTE, message: "Second ask" });
    await postAt("2026-11-13T07:00:00Z", { ...QUOTE, message: "Third ask" });
    expect(h.leads).toHaveLength(1);
    expect(h.repeats).toHaveLength(2);
    expect(h.repeats[0].requestId).not.toBe(h.repeats[1].requestId);
    expect(h.leads[0].message).toContain("Second ask");
    expect(h.leads[0].message).toContain("Third ask");
  });

  it("a double tap (the same body within 10 minutes) is recorded but appends nothing and tells nobody", async () => {
    await postAt("2026-11-13T03:00:00Z", QUOTE);
    const before = h.leads[0].message;
    const tap = await postAt("2026-11-13T03:00:04Z", QUOTE);
    expect(tap.status).toBe(200);
    expect(tap.body).toMatchObject({ ok: true, merged: true });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0].message).toBe(before);
    expect(h.leads[0].updated_at).toBe("2026-11-13T03:00:04.000Z");
    expect(h.activity).toHaveLength(1);
    expect(h.activity[0].meta).toMatchObject({ double_tap: true, lead_id: h.leads[0].id });
    expect(h.notified).toHaveLength(1);
    expect(h.repeats).toHaveLength(0);
  });

  it("measures the double tap from the last repeat, not only from the lead", async () => {
    await postAt("2026-11-13T03:00:00Z", QUOTE);
    const ask = { ...QUOTE, message: "Can you come Saturday?" };
    await postAt("2026-11-13T06:00:00Z", ask);
    await postAt("2026-11-13T06:00:05Z", ask);
    expect(h.repeats).toHaveLength(1);
    expect(h.leads[0].message.match(/Can you come Saturday\?/g)).toHaveLength(1);
    expect(h.activity.map((a) => a.meta.double_tap)).toEqual([false, true]);
  });

  it("the same body after 10 minutes is the person asking again, and is told", async () => {
    await postAt("2026-11-13T03:00:00Z", QUOTE);
    await postAt("2026-11-13T03:30:00Z", QUOTE);
    expect(h.leads).toHaveLength(1);
    expect(h.repeats).toHaveLength(1);
    expect(h.leads[0].message).toContain("--- Asked again 2026-11-13 03:30 UTC ---");
  });

  it.each(["contacted", "qualified", "converted", "archived"])(
    "does not merge into a lead the office already marked %s: the ask is a new lead",
    async (status) => {
      await postAt("2026-11-13T03:00:00Z", QUOTE);
      h.leads[0].status = status;
      const before = { ...h.leads[0] };
      const r = await postAt("2026-11-13T05:00:00Z", { ...QUOTE, message: "Following up" });
      expect(r.status).toBe(201);
      expect(r.body.merged).toBeUndefined();
      expect(h.leads).toHaveLength(2);
      expect(h.leads[0]).toEqual(before);
      expect(h.leads[1]).toMatchObject({ status: "new", source: "directory" });
      expect(h.leads[1].message).toContain("Following up");
      expect(h.notified).toHaveLength(2);
      expect(h.repeats).toHaveLength(0);
      expect(h.activity).toEqual([]);
    },
  );

  it("never pushes the lead's message past its 2000-character limit, and keeps the original whole", async () => {
    const long = "x".repeat(1990);
    await postAt("2026-11-13T03:00:00Z", { ...QUOTE, message: long });
    const original = h.leads[0].message as string;
    await postAt("2026-11-13T05:00:00Z", { ...QUOTE, message: "y".repeat(1500) });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0].message.length).toBeLessThanOrEqual(2000);
    expect(h.leads[0].message.startsWith(original)).toBe(true);
    // Still recorded in full, and still told.
    expect(h.activity[0].meta.message).toContain("y".repeat(1500));
    expect(h.repeats).toHaveLength(1);
  });

  it.each(["pet_waste", "dog_walking", "pet_sitting", "grooming", "training"])(
    "works the same for a %s quote",
    async (line) => {
      const body = {
        ...directoryQuoteBody("acme-scoop", {
          name: "Rosa Delgado",
          email: "rosa@example.test",
          phone: "",
          zip: "48201",
          service_line: line,
          dog_count: "1",
          message: "First",
        }),
        website_url: "",
        elapsed_ms: 25_000,
      };
      await postAt("2026-11-13T03:00:00Z", body);
      await postAt("2026-11-13T05:00:00Z", { ...body, message: "Second" });
      expect(h.leads).toHaveLength(1);
      expect(h.leads[0].message).toContain("Second");
      expect(h.repeats).toHaveLength(1);
    },
  );
});

describe("a directory quote, through the shipped endpoint (continued)", () => {
  it("does not merge one from a day and a half ago, or a different person", async () => {
    h.leads.push({
      id: "old",
      organization_id: ORG,
      email: "rosa@example.test",
      source: "directory",
      status: "new",
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
    expect(prefill.officeNote).toContain("Asked about: Poop scooping.");
    expect(leadOriginLabel("directory", null)).toBe("Quote request from the HoundStack directory");
  });
});
