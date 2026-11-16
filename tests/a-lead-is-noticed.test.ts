// A lead is noticed, and a script cannot fill the pipeline it is noticed in.
//
// Two follow-ups from the merged public form (/signup/{slug}, #360):
//
//   1. The office is told about a new lead. A quote request or an online
//      signup writes a `leads` row; until this change nobody heard about it.
//      Now the owner, the office managers and anyone whose role holds
//      manage_leads get it in the bell and on the phone, once per lead. A
//      signup that is re-pressed, or that pays later, is the same lead and
//      tells nobody again.
//   2. The public form refuses what a person would not send: a filled
//      honeypot, a submission faster than anyone types, and more than its
//      share per address or per business. Every refusal is the same calm
//      sentence and writes nothing.
//
// Driven through the SHIPPED pieces: the real notify-center fan-out, the real
// recordSignupLead, the real /api/public/leads handler. Only the edges are
// fake: the service-role client (an in-memory model of the four tables and
// the one RPC involved), the anon client, and the push sender.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ORG = "0f000000-0000-4000-8000-00000000a1ea";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  roles: [] as Row[],
  prefs: [] as Row[],
  notifications: [] as Row[],
  pushed: [] as Array<{ userId: string; payload: Row }>,
  leads: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Row }>,
  turn: "ok" as unknown,
  turnError: null as null | { message: string },
  orgForSlug: "0f000000-0000-4000-8000-00000000a1ea" as string | null,
}));

vi.mock("@/lib/push.server", () => ({
  sendPushToUser: async (userId: string, payload: Row) => {
    h.pushed.push({ userId, payload });
    return { sent: 1, failed: 0 };
  },
}));

/** A query builder over an array: every filter narrows, awaiting it answers. */
function query(rows: () => Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    gte: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (res: any, rej: any) =>
      Promise.resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
  };
  return b;
}

const admin = {
  from(table: string): any {
    if (table === "user_roles") return query(() => h.roles);
    if (table === "app_notification_prefs") return query(() => h.prefs);
    // #378 reads `staff` to leave out people whose access is off.
    if (table === "staff") return query(() => []);
    if (table === "app_notifications") {
      return {
        // ON CONFLICT (recipient_user_id, event_key) DO NOTHING, returning
        // only what was inserted: the unique index from 20261004150000.
        upsert: (rows: Row[]) => ({
          select: async () => {
            const fresh = rows.filter(
              (r) =>
                !h.notifications.some(
                  (n) => n.recipient_user_id === r.recipient_user_id && n.event_key === r.event_key,
                ),
            );
            h.notifications.push(...fresh);
            return { data: fresh.map((r) => ({ recipient_user_id: r.recipient_user_id })), error: null };
          },
        }),
        insert: async (rows: Row[]) => (h.notifications.push(...rows), { error: null }),
      };
    }
    if (table === "leads") {
      const b = query(() => h.leads);
      b.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            const created = { id: `lead-${h.leads.length + 1}`, created_at: new Date().toISOString(), ...row };
            h.leads.push(created);
            return { data: { id: created.id }, error: null };
          },
        }),
      });
      b.update = (patch: Row) => ({
        eq: async (_c: string, id: string) => {
          const r = h.leads.find((l) => l.id === id);
          if (r) Object.assign(r, patch);
          return { error: null };
        },
      });
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string, args: Row) => {
    h.rpcs.push({ fn, args });
    return { data: h.turnError ? null : h.turn, error: h.turnError };
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string) =>
      fn === "public_get_org_for_lead_form"
        ? { data: h.orgForSlug ? [{ id: h.orgForSlug }] : [], error: null }
        : { data: null, error: null },
  }),
}));

import { hasPermission } from "@/lib/permissions";
import { resetNotifyMemoForTests } from "@/lib/notify-center.server";
import {
  leadNotice,
  notifyOfficeOfNewLead,
  notifyOfficeOfRepeatLead,
  repeatLeadEventKey,
  repeatLeadNotice,
  rolesThatWorkLeads,
} from "@/lib/lead-notify.server";
import {
  CALM_REFUSAL,
  MIN_FILL_MS,
  RATE_LIMIT,
  callerAddress,
  screenSubmission,
} from "@/lib/public-form-guard";
import { hashAddress, takePublicFormTurn } from "@/lib/public-form-guard.server";

/** One business: an owner, two office managers, a dispatcher and a tech, and
 *  an owner of a DIFFERENT business who must never hear about this one. */
function staff() {
  h.roles = [
    { organization_id: ORG, user_id: "owner", role: "owner" },
    { organization_id: ORG, user_id: "office-1", role: "office_manager" },
    { organization_id: ORG, user_id: "office-2", role: "office_manager" },
    { organization_id: ORG, user_id: "dispatch", role: "dispatcher" },
    { organization_id: ORG, user_id: "tech", role: "tech" },
    { organization_id: "another-business", user_id: "stranger", role: "owner" },
  ];
}

const LEAD = {
  orgId: ORG,
  leadId: "lead-xyz",
  name: "Marguerite Okonkwo",
  source: "website",
  location: "612 Maple St, Southfield, MI 48037",
  dogCount: 2,
  frequency: "weekly",
};

beforeEach(() => {
  h.roles = [];
  h.prefs = [];
  h.notifications = [];
  h.pushed = [];
  h.leads = [];
  h.rpcs = [];
  h.turn = "ok";
  h.turnError = null;
  h.orgForSlug = ORG;
  resetNotifyMemoForTests();
  process.env.SUPABASE_PUBLISHABLE_KEY = "anon_test";
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
});

const recipients = () => h.notifications.map((n) => n.recipient_user_id).sort();

// ── 1. Who is told ──────────────────────────────────────────────────────────

describe("the office is told about a new lead", () => {
  it("is told to every role that may work Leads, read from the permission matrix", () => {
    const expected = (["owner", "office_manager", "dispatcher", "tech"] as const).filter((r) =>
      hasPermission(r, "manage_leads"),
    );
    expect(rolesThatWorkLeads()).toEqual(expected);
    expect(rolesThatWorkLeads()).toEqual(["owner", "office_manager"]);
  });

  it("reaches the owner and the office managers, and no tech, dispatcher or other business", async () => {
    staff();
    await notifyOfficeOfNewLead(LEAD);
    expect(recipients()).toEqual(["office-1", "office-2", "owner"]);
    expect(h.pushed.map((p) => p.userId).sort()).toEqual(["office-1", "office-2", "owner"]);
    for (const n of h.notifications) {
      expect(n).toMatchObject({
        organization_id: ORG,
        type: "lead",
        link: "/leads",
        event_key: "lead:lead-xyz",
        title: "New lead: Marguerite Okonkwo",
      });
    }
    // The tap lands on Leads, not on the list of notifications.
    expect(h.pushed[0].payload.url).toBe("/leads");
  });

  it("leaves out anybody who muted new leads", async () => {
    staff();
    h.prefs = [{ user_id: "office-2", muted_types: ["lead"] }];
    await notifyOfficeOfNewLead(LEAD);
    expect(recipients()).toEqual(["office-1", "owner"]);
  });

  it("tells each person once per lead, even when asked twice from two servers", async () => {
    staff();
    await notifyOfficeOfNewLead(LEAD);
    // A second server instance has no memo of the first: only the database's
    // unique (recipient, event_key) stands between the office and a repeat.
    resetNotifyMemoForTests();
    h.pushed = [];
    await notifyOfficeOfNewLead(LEAD);
    expect(recipients()).toEqual(["office-1", "office-2", "owner"]);
    expect(h.pushed).toEqual([]);
  });

  it("never throws, so a notice that fails cannot cost the lead", async () => {
    h.roles = null as any; // the lookup blows up inside notifyRoles
    await expect(notifyOfficeOfNewLead(LEAD)).resolves.toBeUndefined();
  });

  it("says how the lead came in and what they told us", () => {
    expect(leadNotice(LEAD)).toEqual({
      title: "New lead: Marguerite Okonkwo",
      body: "Asked for a quote · 612 Maple St, Southfield, MI 48037 · 2 dogs · Weekly",
    });
    expect(leadNotice({ ...LEAD, source: "online_signup", dogCount: 1 }).body).toMatch(
      /^Started signing up online · .* · 1 dog · /,
    );
    expect(leadNotice({ ...LEAD, source: "door_signup" }).body).toMatch(/^Started signing up at the door/);
    expect(leadNotice({ ...LEAD, name: "  ", location: null, dogCount: null, frequency: null })).toEqual({
      title: "New lead: Someone",
      body: "Asked for a quote",
    });
  });

  it("sends no text and no email: the bell and the push are the whole of it", () => {
    const src = read("src/lib/lead-notify.server.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/twilio|sendSms|sms\.server|enqueueAppEmail|email\//i);
    expect(src).toMatch(/notifyRoles\(rolesThatWorkLeads\(\)/);
  });
});

// ── 1a. A repeat directory quote is told, once per repeat (#920) ───────────

describe("the office is told when an open lead asks again", () => {
  const REPEAT = { ...LEAD, source: "directory", serviceName: "Deep clean", requestId: "req-1" };

  it("is told after the new-lead notice, not swallowed by it, to the same people", async () => {
    staff();
    await notifyOfficeOfNewLead(LEAD);
    h.pushed = [];
    await notifyOfficeOfRepeatLead(REPEAT);
    const repeats = h.notifications.filter((n) => n.event_key !== "lead:lead-xyz");
    expect(repeats.map((n) => n.recipient_user_id).sort()).toEqual([
      "office-1",
      "office-2",
      "owner",
    ]);
    const key = repeatLeadEventKey("lead-xyz", "req-1");
    expect(repeats.every((n) => n.event_key === key)).toBe(true);
    expect(repeats[0]).toMatchObject({ type: "lead", title: "Repeat request: Marguerite Okonkwo" });
    expect(h.pushed.map((p) => p.userId).sort()).toEqual(["office-1", "office-2", "owner"]);
  });

  it("is told again for a second repeat, and only once for the same one", async () => {
    staff();
    await notifyOfficeOfRepeatLead(REPEAT);
    resetNotifyMemoForTests();
    await notifyOfficeOfRepeatLead(REPEAT);
    expect(h.notifications).toHaveLength(3);
    await notifyOfficeOfRepeatLead({ ...REPEAT, requestId: "req-2" });
    expect(h.notifications).toHaveLength(6);
  });

  it("leaves out anybody who muted new leads", async () => {
    staff();
    h.prefs = [{ user_id: "office-2", muted_types: ["lead"] }];
    await notifyOfficeOfRepeatLead(REPEAT);
    expect(recipients()).toEqual(["office-1", "owner"]);
  });

  it("never throws", async () => {
    h.roles = null as any;
    await expect(notifyOfficeOfRepeatLead(REPEAT)).resolves.toBeUndefined();
  });

  it("says it is a repeat, and what this ask named", () => {
    expect(repeatLeadNotice(REPEAT)).toEqual({
      title: "Repeat request: Marguerite Okonkwo",
      body: "Asked again · 612 Maple St, Southfield, MI 48037 · 2 dogs · Weekly · Deep clean",
    });
    expect(repeatLeadEventKey("a", "b")).not.toBe("lead:a");
  });
});

// ── 1b. A lead that converts later does not tell anyone twice ───────────────

describe("a signup is one notice, however it ends", () => {
  const SIGNUP = {
    orgId: ORG,
    source: "online_signup",
    name: "Marguerite Okonkwo",
    email: "Marguerite@Example.test",
    phone: null,
    location: "612 Maple St, Southfield, MI 48037",
    dogCount: 2,
    frequency: "weekly",
    message: null,
  };

  it("tells the office when the signup writes its lead, and not when it is pressed again", async () => {
    staff();
    const { recordSignupLead } = await import("@/lib/signup.functions");
    const first = await recordSignupLead(admin, SIGNUP);
    expect(first).toBe("lead-1");
    expect(recipients()).toEqual(["office-1", "office-2", "owner"]);
    expect(h.notifications[0]).toMatchObject({ event_key: "lead:lead-1" });
    expect(h.notifications[0].body).toMatch(/^Started signing up online/);

    // Same household, a fixed typo, "Start service" again: the same lead,
    // brought up to date, and nobody told twice.
    resetNotifyMemoForTests();
    const again = await recordSignupLead(admin, { ...SIGNUP, dogCount: 3 });
    expect(again).toBe("lead-1");
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0].dog_count).toBe(3);
    expect(h.notifications).toHaveLength(3);
  });

  it("the payment that converts it says nothing: the webhook marks it converted and notifies no one about it", async () => {
    staff();
    const { recordSignupLead } = await import("@/lib/signup.functions");
    const leadId = (await recordSignupLead(admin, SIGNUP))!;
    expect(h.notifications).toHaveLength(3);

    // What the Stripe webhook runs when the card goes through.
    const { markLeadConverted } = await import("@/lib/lead-conversion.server");
    const sb = {
      from: () => {
        const q: any = {
          update: (patch: Row) => ((q.patch = patch), q),
          eq: () => q,
          is: () => q,
          select: async () => {
            Object.assign(h.leads.find((l) => l.id === leadId)!, q.patch);
            return { data: [{ id: leadId }], error: null };
          },
        };
        return q;
      },
    };
    expect(await markLeadConverted(sb, leadId, "client-1")).toBe(true);
    expect(h.leads[0].status).toBe("converted");
    expect(h.notifications).toHaveLength(3);

    // And nothing on the webhook's provisioning path, or in the conversion
    // helper, tells the office about a lead.
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    const provision = hook.slice(0, hook.indexOf("Best-effort welcome email"));
    expect(provision).not.toMatch(/notifyOfficeOfNewLead|lead-notify|type: "lead"/);
    expect(read("src/lib/lead-conversion.server.ts")).not.toMatch(/notify/i);
  });

  it("only the INSERT notifies: the re-use branch returns before it", () => {
    const fns = read("src/lib/signup.functions.ts");
    const helper = fns.slice(fns.indexOf("export async function recordSignupLead"));
    const reuse = helper.indexOf("if (existing?.id)");
    const reuseReturn = helper.indexOf("return existing.id as string;", reuse);
    const notify = helper.indexOf("notifyOfficeOfNewLead(");
    expect(reuse).toBeGreaterThan(0);
    expect(reuseReturn).toBeGreaterThan(reuse);
    expect(notify).toBeGreaterThan(reuseReturn);
  });
});

// ── 2. The filters ──────────────────────────────────────────────────────────

describe("the honeypot and the clock", () => {
  it("lets a person through", () => {
    expect(screenSubmission({ honeypot: "", elapsedMs: 42_000 })).toEqual({ ok: true });
    expect(screenSubmission({ honeypot: undefined, elapsedMs: MIN_FILL_MS })).toEqual({ ok: true });
    expect(screenSubmission({ honeypot: "   ", elapsedMs: "9000" })).toEqual({ ok: true });
  });

  it("refuses a filled honeypot, whatever it was filled with", () => {
    for (const hp of ["https://spam.example", "x", 1, true, { a: 1 }]) {
      expect(screenSubmission({ honeypot: hp, elapsedMs: 60_000 })).toEqual({
        ok: false,
        reason: "honeypot",
      });
    }
  });

  it("refuses anything faster than a person types", () => {
    expect(MIN_FILL_MS).toBe(3_000);
    for (const ms of [0, 1, 250, MIN_FILL_MS - 1, -5]) {
      expect(screenSubmission({ honeypot: "", elapsedMs: ms })).toEqual({ ok: false, reason: "too_fast" });
    }
  });

  it("refuses a body with no clock at all, because the form always sends one", () => {
    for (const ms of [undefined, null, "", "soon", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(screenSubmission({ honeypot: "", elapsedMs: ms })).toEqual({ ok: false, reason: "untimed" });
    }
  });

  it("the form sends both fields with both buttons, and hides the honeypot from people", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/\.\.\.leadBodyFromForm\(slug, form\), \.\.\.guardFields\(\)/);
    expect(flow).toMatch(/channel,\s*\.\.\.guardFields\(\),/);
    const trap = flow.slice(flow.indexOf('<div aria-hidden="true" className="invisible'));
    expect(trap).toMatch(/^<div aria-hidden="true" className="invisible absolute h-0 w-0 overflow-hidden">/);
    expect(trap.slice(0, 600)).toMatch(/tabIndex=\{-1\}/);
    expect(trap.slice(0, 600)).toMatch(/autoComplete="off"/);
    // Absolute inside the card it sits in, so it cannot widen the page.
    expect(flow).toMatch(/<div className="relative rounded-2xl border bg-card p-\(--card-pad\)">\s*<h2[^>]*>2\. Your details/);
  });
});

describe("the caller's address", () => {
  const headers = (o: Record<string, string>) => (n: string) => o[n] ?? null;

  it("trusts the address Cloudflare vouches for over anything the client sent", () => {
    expect(
      callerAddress(headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" })),
    ).toBe("203.0.113.9");
  });

  it("takes the LAST forwarded hop, which a client cannot choose", () => {
    expect(callerAddress(headers({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });

  it("has nothing to say without either header", () => {
    expect(callerAddress(headers({}))).toBeNull();
  });

  it("stores a hash, never the address", async () => {
    const a = await hashAddress("203.0.113.9");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.9");
    expect(await hashAddress("203.0.113.9")).toBe(a);
    expect(await hashAddress("203.0.113.10")).not.toBe(a);
  });
});

describe("the rate limit", () => {
  it("asks the database for a turn with the limits the app sets", async () => {
    expect(RATE_LIMIT).toEqual({ windowSeconds: 3600, perAddress: 20, perBusiness: 60 });
    expect(await takePublicFormTurn(admin, ORG, "203.0.113.9")).toEqual({ ok: true });
    expect(h.rpcs[0]).toEqual({
      fn: "take_public_form_turn",
      args: {
        _org_id: ORG,
        _ip_hash: await hashAddress("203.0.113.9"),
        _per_address: 20,
        _per_business: 60,
        _window_seconds: 3600,
      },
    });
  });

  it("with no address, still counts against the business", async () => {
    await takePublicFormTurn(admin, ORG, null);
    expect(h.rpcs[0].args._ip_hash).toBeNull();
  });

  it("says no when the address or the business is over its share", async () => {
    h.turn = "address";
    expect(await takePublicFormTurn(admin, ORG, "203.0.113.9")).toEqual({ ok: false, reason: "address" });
    h.turn = "business";
    expect(await takePublicFormTurn(admin, ORG, "203.0.113.9")).toEqual({ ok: false, reason: "business" });
  });

  it("an error is not a no: a real customer is not the casualty of a bad minute", async () => {
    h.turnError = { message: "function take_public_form_turn does not exist" };
    expect(await takePublicFormTurn(admin, ORG, "203.0.113.9")).toEqual({ ok: true });
  });
});

// ── 3. The endpoint, end to end ─────────────────────────────────────────────

async function postLead(body: Record<string, unknown>, ip = "203.0.113.9") {
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
  slug: "whitfield",
  name: "Marguerite Okonkwo",
  email: "Marguerite@Example.test",
  phone: "",
  location: "612 Maple St, Southfield, MI 48037",
  dog_count: 2,
  frequency: "weekly",
  message: "Gate code 1234",
  source: "website",
  website_url: "",
  elapsed_ms: 38_000,
};

describe("a quote request, through the shipped endpoint", () => {
  it("writes one new lead with the service role and tells the office once", async () => {
    staff();
    const r = await postLead(QUOTE);
    // serviceArea (R2-25): this fake has no zones to say yes or no.
    expect(r).toEqual({ status: 201, body: { ok: true, serviceArea: "unknown" } });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0]).toMatchObject({
      organization_id: ORG,
      email: "marguerite@example.test",
      status: "new",
      source: "website",
    });
    expect(h.leads[0]).not.toHaveProperty("website_url");
    expect(h.leads[0]).not.toHaveProperty("elapsed_ms");
    expect(h.rpcs.map((c) => c.fn)).toEqual(["take_public_form_turn"]);
    expect(h.rpcs[0].args._ip_hash).toBe(await hashAddress("203.0.113.9"));
    expect(recipients()).toEqual(["office-1", "office-2", "owner"]);
    expect(h.notifications[0]).toMatchObject({ event_key: "lead:lead-1", type: "lead" });
  });

  it.each([
    ["a filled honeypot", { website_url: "https://cheap-pills.example" }],
    ["a submission faster than anyone types", { elapsed_ms: 400 }],
    ["a body with no clock", { elapsed_ms: undefined }],
  ])("refuses %s calmly, before it asks for a turn, and writes nothing", async (_label, patch) => {
    staff();
    const r = await postLead({ ...QUOTE, ...patch });
    expect(r).toEqual({ status: 400, body: { error: CALM_REFUSAL } });
    expect(h.rpcs).toEqual([]);
    expect(h.leads).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it.each(["address", "business"])(
    "refuses the same calm way when the %s is over its share, and writes nothing",
    async (verdict) => {
      staff();
      h.turn = verdict;
      const r = await postLead(QUOTE);
      expect(r).toEqual({ status: 429, body: { error: CALM_REFUSAL } });
      expect(h.leads).toEqual([]);
      expect(h.notifications).toEqual([]);
    },
  );

  it("the refusal names no filter", () => {
    expect(CALM_REFUSAL).not.toMatch(/honeypot|bot|spam|fast|rate|limit|address|IP/i);
  });

  it("an unknown business is still a 404 and asks for no turn", async () => {
    h.orgForSlug = null;
    const r = await postLead(QUOTE);
    expect(r.status).toBe(404);
    expect(h.rpcs).toEqual([]);
    expect(h.leads).toEqual([]);
  });
});

describe("a signup, through the shipped server function", () => {
  it("stands behind the same filters before it prices anything", () => {
    const fns = read("src/lib/signup.functions.ts");
    const checkout = fns.slice(fns.indexOf("export const createSignupPaymentIntent"));
    const screen = checkout.indexOf("screenSubmission(");
    const quote = checkout.indexOf('sb.rpc("public_quote"');
    const turn = checkout.indexOf("takePublicFormTurn(");
    const lead = checkout.indexOf("await recordSignupLead(");
    const intent = checkout.indexOf("stripe.paymentIntents.create(");
    expect(screen).toBeGreaterThan(0);
    expect(quote).toBeGreaterThan(screen);
    expect(turn).toBeGreaterThan(quote);
    expect(lead).toBeGreaterThan(turn);
    expect(intent).toBeGreaterThan(lead);
    expect(checkout.slice(0, lead)).toMatch(/throw new Error\(CALM_REFUSAL\)/);
  });
});

// ── 4. The migration ────────────────────────────────────────────────────────

describe("20261009220000", () => {
  const sql = read("supabase/migrations/20261009220000_a-lead-is-noticed.sql");
  const code = sql.replace(/--[^\n]*/g, "");

  it("keeps the counter deny-all, two-step, and out of every browser's reach", () => {
    expect(code).toMatch(/ALTER TABLE public\.public_form_attempts ENABLE ROW LEVEL SECURITY;/);
    expect(code).toMatch(/SELECT public\.require_mfa_policy\('public\.public_form_attempts'\);/);
    expect(code).not.toMatch(/CREATE POLICY[^;]*public_form_attempts/i);
    expect(code).toMatch(/REVOKE ALL ON public\.public_form_attempts FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.take_public_form_turn\(uuid, text, integer, integer, integer\)\s+FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("shuts the side door the publishable key opened", () => {
    expect(code).toMatch(
      /DROP POLICY IF EXISTS "Anyone can submit a lead to a business that publishes a form" ON public\.leads;/,
    );
    expect(code).toMatch(/REVOKE INSERT ON public\.leads FROM anon;/);
    // And nothing after it opens it again.
    const later = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql") && f > "20261009220000_a-lead-is-noticed.sql")
      .map((f) => read(join("supabase/migrations", f)));
    for (const s of later) {
      expect(s).not.toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+public\.leads[\s\S]*?FOR\s+INSERT/i);
      expect(s).not.toMatch(/GRANT[^;]*INSERT[^;]*ON\s+(TABLE\s+)?public\.leads[^;]*\banon\b/i);
    }
  });

  it("proves the limit in the replay, as exceptions, and cleans up its probe", () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'a fourth submission from one address was not refused/);
    expect(sql).toMatch(/RAISE EXCEPTION 'a refused submission was counted/);
    expect(sql).toMatch(/RAISE EXCEPTION 'the business ceiling did not hold/);
    expect(sql).toMatch(/RAISE EXCEPTION 'anon can still INSERT into leads'/);
    const tail = sql.slice(sql.lastIndexOf("the business ceiling did not hold"));
    expect(tail).toMatch(/DELETE FROM public\.public_form_attempts WHERE organization_id = _probe;/);
  });
});
