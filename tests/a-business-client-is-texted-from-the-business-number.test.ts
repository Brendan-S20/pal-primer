// A business's client is texted from the business's own number, or not at all.
//
// tests/the-toll-free-number-texts-account-holders.test.ts reads the source
// and says where a send is wired wrong. This one RUNS the senders, with the
// real transport (twilio.server) and the real sender resolution
// (twilio-credentials.server) against a fake database and a fake fetch, and
// watches what goes on the wire:
//
//   * no subaccount: no text, and the email that was always the fallback goes;
//   * a subaccount: the text goes on the subaccount, from its number, and the
//     platform's account and number are never touched;
//   * an account holder: the platform's account and number, declared;
//   * portal sign-in: email only, unless the business can text;
//   * a text to the platform number: answered in HoundStack's name, routed to
//     no business.
//
// PLATFORM_SMS_FROM_NUMBER is set throughout, as it is in production, because
// the bug was that its being set was enough to send a client a text from it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PLATFORM = "+18885550000";
const SUB_FROM = "+15125557777";

let credsRow: Record<string, unknown> | null;
let clientRow: Record<string, unknown> | null;
let orgRow: Record<string, unknown> | null;
const tablesRead: string[] = [];
const adminCalls: Array<{ table: string; op: string; payload?: unknown }> = [];

/** The service-role client. Reads what the test sets; records every write. */
function adminBuilder(table: string) {
  tablesRead.push(table);
  const call = { table, op: "select", payload: undefined as unknown };
  const record = (op: string, payload?: unknown) => {
    call.op = op;
    call.payload = payload;
    adminCalls.push({ ...call });
  };
  const b: any = {
    select: () => b,
    eq: () => b,
    is: () => b,
    in: () => b,
    lt: () => b,
    gte: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    insert: (p: unknown) => (record("insert", p), b),
    update: (p: unknown) => (record("update", p), b),
    delete: () => (record("delete"), b),
    maybeSingle: async () => {
      if (table === "org_twilio_credentials") return { data: credsRow, error: null };
      if (table === "clients") return { data: clientRow, error: null };
      if (table === "organizations") return { data: orgRow, error: null };
      return { data: null, error: null };
    },
    single: async () => {
      if (table === "portal_otps") return { data: { id: "otp-1" }, error: null };
      if (table === "visits") return { data: { tracking_token: null }, error: null };
      return { data: null, error: null };
    },
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], count: 0, error: null }).then(res),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => adminBuilder(t) },
}));
vi.mock("@/lib/secret-encryption.server", () => ({
  decryptSecret: (s: string) => `plain:${s}`,
}));
const emails: Array<Record<string, any>> = [];
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: vi.fn(async (p: Record<string, any>) => {
    emails.push(p);
    return { ok: true };
  }),
}));
const notified: unknown[] = [];
vi.mock("@/lib/notify-center.server", () => ({
  notifyRoles: vi.fn(async (_r: unknown, n: unknown) => void notified.push(n)),
}));
vi.mock("@/lib/twilio-inbound-auth.server", () => ({
  verifyTwilioInbound: vi.fn(async () => ({ ok: true, via: "platform_signature" })),
}));

const fetchMock = vi.fn();

const { endCustomerSmsSender, platformAccountHolderFrom } = await import(
  "@/lib/twilio-credentials.server"
);
const { sendTwilioSms } = await import("@/lib/twilio.server");
const { sendOnMyWay } = await import("@/lib/on-my-way.server");
const { portalContactChannels, issuePortalOtp, portalIdentify } = await import(
  "@/lib/portal-auth.server"
);
const { handlePlatformReply } = await import("@/lib/platform-inbound.server");

const SUBACCOUNT = {
  account_sid: "ACsub",
  auth_token: "enc-token",
  sms_from_number: SUB_FROM,
  messaging_service_sid: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ sid: "SM1", status: "queued" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  process.env.PLATFORM_SMS_FROM_NUMBER = PLATFORM;
  process.env.LOVABLE_API_KEY = "lov-key";
  process.env.TWILIO_API_KEY = "conn-key";
  credsRow = null;
  clientRow = null;
  orgRow = null;
  tablesRead.length = 0;
  adminCalls.length = 0;
  emails.length = 0;
  notified.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const wire = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    auth: (init as any).headers.Authorization as string,
    body: new URLSearchParams(String((init as any).body)),
  }));

describe("endCustomerSmsSender", () => {
  it("is null with no subaccount, which is every business today", async () => {
    expect(await endCustomerSmsSender("org-1")).toBeNull();
  });

  it("is null for a subaccount with nothing to send from", async () => {
    credsRow = { ...SUBACCOUNT, sms_from_number: null, messaging_service_sid: null };
    expect(await endCustomerSmsSender("org-1")).toBeNull();
  });

  it("is the subaccount's own credentials and number, never the platform's", async () => {
    credsRow = SUBACCOUNT;
    orgRow = { name: "Acme Scoop" };
    expect(await endCustomerSmsSender("org-1")).toEqual({
      credentials: {
        mode: "direct",
        accountSid: "ACsub",
        authToken: "plain:enc-token",
        brand: "Acme Scoop",
      },
      // The business's own name, which every text to its client starts with
      // (#538).
      brand: "Acme Scoop",
      from: SUB_FROM,
      messagingServiceSid: null,
    });
  });
});

// ── on my way: the end-customer send with an email path ─────────────────────

let visit: Record<string, unknown>;
let org: Record<string, unknown>;
const callerInserts: unknown[] = [];

function callerDb() {
  const from = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      single: async () => ({
        data: table === "visits" ? visit : table === "organizations" ? org : null,
        error: null,
      }),
      maybeSingle: async () =>
        table === "staff" ? { data: { id: "staff-1", display_name: "Sam Rivera" } } : { data: null },
      insert: async (p: unknown) => (callerInserts.push(p), { data: null, error: null }),
    };
    return b;
  };
  // client_may_be_texted: consent is on file, so the only thing that can stop
  // the text is the sender.
  return { from, rpc: async () => ({ data: true, error: null }) } as any;
}

const onMyWay = () =>
  sendOnMyWay({
    supabase: callerDb(),
    userId: "user-1",
    visitId: "11111111-1111-4111-8111-111111111111",
    trigger: "button",
    now: new Date("2026-10-06T15:00:00Z"),
  });

describe("an end-customer text (on my way)", () => {
  beforeEach(() => {
    callerInserts.length = 0;
    org = {
      name: "Acme Scoop",
      timezone: "America/Chicago",
      // The legacy per-org column, set: it must not be used as a sender.
      sms_from_number: "+15125550001",
      notify_sms_on_my_way: true,
      notify_email_on_my_way: true,
      on_my_way_on_navigate: false,
      live_tracking_enabled: false,
    };
    visit = {
      id: "11111111-1111-4111-8111-111111111111",
      organization_id: "org-1",
      client_id: "client-1",
      status: "scheduled",
      scheduled_on: "2026-10-06",
      eta_start: null,
      eta_end: null,
      on_my_way_sent_at: null,
      tracking_token: null,
      clients: { display_name: "Jane", primary_phone: "+15125550100", sms_opt_out: false, comms_paused: false },
      properties: { street: "412 Elm St", city: "Austin", visit_contact_name: null, visit_contact_phone: null, visit_contact_email: null },
    };
  });

  it("with no subaccount sends no text, and the email still goes", async () => {
    await expect(onMyWay()).resolves.toEqual({ sent: true, channel: "email" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callerInserts).toEqual([]);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ templateName: "on-my-way", clientId: "client-1" });
  });

  it("with a subaccount texts on the subaccount, from its number, and never the platform", async () => {
    credsRow = SUBACCOUNT;
    await expect(onMyWay()).resolves.toEqual({ sent: true, channel: "sms" });
    const [sent, ...rest] = wire();
    expect(rest).toEqual([]);
    expect(sent.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACsub/Messages.json");
    expect(sent.auth).toBe(`Basic ${Buffer.from("ACsub:plain:enc-token").toString("base64")}`);
    expect(sent.body.get("From")).toBe(SUB_FROM);
    expect(sent.body.get("To")).toBe("+15125550100");
    expect(sent.url).not.toContain("connector-gateway");
    expect(sent.body.toString()).not.toContain(encodeURIComponent(PLATFORM));
    expect(emails).toEqual([]);
    expect(callerInserts).toEqual([expect.objectContaining({ from_number: SUB_FROM })]);
  });
});

describe("an account-holder text", () => {
  it("goes on the platform's account, from the platform number, when it says so", async () => {
    await sendTwilioSms({
      to: "+15125550199",
      body: "HoundStack: your verification code is 123456.",
      from: platformAccountHolderFrom()!,
      credentials: { mode: "gateway", purpose: "account_holder" },
    });
    const [sent] = wire();
    expect(sent.url).toBe("https://connector-gateway.lovable.dev/twilio/Messages.json");
    expect(sent.auth).toBe("Bearer lov-key");
    expect(sent.body.get("From")).toBe(PLATFORM);
  });

  it("cannot reach the platform's account without declaring who it is for", async () => {
    await expect(
      sendTwilioSms({ to: "+1", body: "x", from: PLATFORM, credentials: { mode: "gateway" } as any }),
    ).rejects.toThrow(/account holders only/);
    await expect(
      sendTwilioSms({ to: "+1", body: "x", from: PLATFORM } as any),
    ).rejects.toThrow(/requires credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── portal sign-in ──────────────────────────────────────────────────────────

const TOKEN = "22222222-2222-4222-8222-222222222222";

describe("portal sign-in", () => {
  beforeEach(() => {
    clientRow = {
      id: "client-1",
      organization_id: "org-1",
      display_name: "Jane Doe",
      primary_phone: "+15125550100",
      primary_email: "jane@example.com",
      active: true,
      organizations: { name: "Acme Scoop", portal_slug: "acme", logo_url: null, brand_color: null, timezone: "America/Chicago" },
    };
  });

  it("offers email only when the business has no subaccount, phone on file or not", async () => {
    const c = await portalContactChannels(TOKEN);
    expect(c?.channels.map((x) => x.channel)).toEqual(["email"]);
  });

  it("offers a text code once the business can send one", async () => {
    credsRow = SUBACCOUNT;
    const c = await portalContactChannels(TOKEN);
    expect(c?.channels.map((x) => x.channel)).toEqual(["sms", "email"]);
  });

  it("refuses a text code it cannot send, and sends nothing", async () => {
    await expect(issuePortalOtp(TOKEN, "sms")).rejects.toThrow(/sends sign-in codes by email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a text code on the subaccount when there is one", async () => {
    credsRow = SUBACCOUNT;
    await issuePortalOtp(TOKEN, "sms");
    const [sent] = wire();
    expect(sent.url).toContain("/Accounts/ACsub/");
    expect(sent.body.get("From")).toBe(SUB_FROM);
  });

  it("asks for an email at the company sign-in, before looking anybody up", async () => {
    orgRow = { id: "org-1", name: "Acme Scoop", portal_slug: "acme", logo_url: null, brand_color: null, timezone: null };
    await expect(portalIdentify("acme", "(512) 555-0100")).rejects.toThrow(
      /sends sign-in codes by email\. Enter the email on your account/,
    );
    // The refusal says nothing about who is a customer: no client was read.
    expect(tablesRead).not.toContain("clients");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── inbound on the platform number ──────────────────────────────────────────

const platformReply = (body: string) =>
  handlePlatformReply({
    requestUrl: "https://app.houndstack.com/api/public/hooks/twilio",
    pathWithQuery: "/api/public/hooks/twilio",
    params: {},
    signature: "sig",
    from: "+15125550100",
    to: PLATFORM,
    body,
    sid: "SMin",
  });

describe("a text to the platform number", () => {
  it("answers STOP, START and HELP in HoundStack's name, with a real contact", async () => {
    expect((await platformReply("STOP")).reply).toMatch(/^HoundStack: You are unsubscribed/);
    expect((await platformReply("start")).reply).toMatch(/^HoundStack: You are resubscribed/);
    expect((await platformReply("HELP")).reply).toMatch(
      /^HoundStack: .*support@houndstack\.com.*Reply STOP to opt out\.$/,
    );
  });

  it("is never routed into a business: no lookup, no write, no notification", async () => {
    for (const body of ["STOP", "ENT", "DNE", "Can you come Thursday instead?"]) {
      await platformReply(body);
    }
    expect(adminCalls).toEqual([]);
    expect(notified).toEqual([]);
    expect((await platformReply("Can you come Thursday instead?")).reply).toBeNull();
    expect((await platformReply("ENT")).reply).toBeNull();
  });
});
