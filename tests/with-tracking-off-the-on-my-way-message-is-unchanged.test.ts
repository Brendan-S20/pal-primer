// With tracking off, the on-my-way message is unchanged.
//
// Live tracking is off by default for every business, and a business that
// has not turned it on must not start sending its customers anything new: not
// a link, not an extra word, not a third SMS segment. With it on, the text and
// the email carry one link to /track/<token>, and the token is minted once per
// visit and kept across re-sends. These drive sendOnMyWay itself against a
// fake database, not just the wording function, because the switch is read
// there.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { onMyWayText } from "@/lib/on-my-way";

const BEFORE_LIVE_TRACKING =
  "Hi Jane, Sam from Acme Scoop is on the way for today's visit. Dogs inside? Reply ENT. Rather we didn't come in? Reply DNE. Reply STOP to opt out.";

let org: Record<string, unknown>;
let visit: Record<string, unknown>;
let canText: boolean;
const sms: string[] = [];
const emails: Array<Record<string, any>> = [];
const adminWrites: Array<{ op: string; payload: any; filters: Array<[string, unknown]> }> = [];
let storedToken: string | null;

/** The caller's client: reads only, plus the messages row. */
function callerDb() {
  const from = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      single: async () => {
        if (table === "visits") return { data: visit, error: null };
        if (table === "organizations") return { data: org, error: null };
        return { data: null, error: null };
      },
      maybeSingle: async () =>
        table === "staff" ? { data: { id: "staff-1", display_name: "Sam Rivera" } } : { data: null },
      insert: async () => ({ data: null, error: null }),
    };
    return b;
  };
  return { from, rpc: async () => ({ data: canText, error: null }) } as any;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const w = { op: "select", payload: undefined as any, filters: [] as Array<[string, unknown]> };
      const b: any = {
        update: (payload: any) => {
          w.op = "update";
          w.payload = payload;
          adminWrites.push(w);
          if (payload.tracking_token && storedToken === null) storedToken = payload.tracking_token;
          return b;
        },
        select: () => b,
        eq: (k: string, v: unknown) => (w.filters.push([k, v]), b),
        is: (k: string, v: unknown) => (w.filters.push([`is:${k}`, v]), b),
        single: async () => ({ data: { tracking_token: storedToken }, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      return b;
    },
  },
}));
// The business's own subaccount: the only thing a client is texted from.
vi.mock("@/lib/twilio-credentials.server", () => ({
  endCustomerSmsSender: async () => ({
    credentials: { mode: "direct", accountSid: "ACsub", authToken: "tok" },
    from: "+15125550000",
    messagingServiceSid: null,
  }),
}));
vi.mock("@/lib/twilio.server", () => ({
  sendTwilioSms: vi.fn(async (p: { body: string }) => {
    sms.push(p.body);
    return { sid: "SM1", status: "queued" };
  }),
}));
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: vi.fn(async (p: Record<string, any>) => {
    emails.push(p);
    return { ok: true };
  }),
}));

const { sendOnMyWay } = await import("@/lib/on-my-way.server");

const send = () =>
  sendOnMyWay({
    supabase: callerDb(),
    userId: "user-1",
    visitId: "11111111-1111-4111-8111-111111111111",
    trigger: "button",
    now: new Date("2026-09-29T15:00:00Z"),
  });

beforeEach(() => {
  sms.length = 0;
  emails.length = 0;
  adminWrites.length = 0;
  storedToken = null;
  canText = true;
  org = {
    name: "Acme Scoop",
    timezone: "America/Chicago",
    notify_sms_on_my_way: true,
    notify_email_on_my_way: true,
    on_my_way_on_navigate: true,
    live_tracking_enabled: false,
  };
  visit = {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "org-1",
    client_id: "client-1",
    status: "scheduled",
    scheduled_on: "2026-09-29",
    eta_start: null,
    eta_end: null,
    on_my_way_sent_at: null,
    tracking_token: null,
    clients: { display_name: "Jane", primary_phone: "+15125550100", sms_opt_out: false, comms_paused: false },
    properties: { street: "412 Elm St", city: "Austin", visit_contact_name: null, visit_contact_phone: null, visit_contact_email: null },
  };
});

describe("with live tracking off", () => {
  it("texts exactly what it texted before live tracking existed", async () => {
    await expect(send()).resolves.toEqual({ sent: true, channel: "sms" });
    expect(sms).toEqual([BEFORE_LIVE_TRACKING]);
  });

  it("mints no token and writes nothing but the sent stamp", async () => {
    await send();
    expect(adminWrites.map((w) => Object.keys(w.payload))).toEqual([["on_my_way_sent_at"]]);
  });

  it("emails exactly what it emailed before, with no link", async () => {
    canText = false;
    await expect(send()).resolves.toEqual({ sent: true, channel: "email" });
    expect(emails).toHaveLength(1);
    expect(emails[0].templateData.trackUrl).toBeUndefined();
    const html = await render(
      React.createElement(TEMPLATES["on-my-way"].component, {
        orgName: "Acme Scoop",
        ...emails[0].templateData,
      }),
    );
    expect(html).not.toContain("/track/");
    expect(html).not.toContain("on the map");
  });

  it("is the wording function's own answer with no link", () => {
    expect(
      onMyWayText({ customerName: "Jane", orgName: "Acme Scoop", techName: "Sam", eta: null }),
    ).toBe(BEFORE_LIVE_TRACKING);
    expect(
      onMyWayText({ customerName: "Jane", orgName: "Acme Scoop", techName: "Sam", eta: null, trackUrl: null }),
    ).toBe(BEFORE_LIVE_TRACKING);
  });
});

describe("with live tracking on", () => {
  beforeEach(() => {
    org.live_tracking_enabled = true;
  });

  it("puts one link to the live map in the text, and keeps the handshake", async () => {
    await send();
    expect(sms).toHaveLength(1);
    const m = sms[0].match(/Live map: (\S+)/);
    expect(m, sms[0]).not.toBeNull();
    expect(m![1]).toMatch(
      /^https:\/\/[^/]+\/track\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sms[0]).toMatch(/Reply ENT\..*Reply DNE\..*Reply STOP to opt out\.$/);
    expect(sms[0].match(/https?:\/\//g)).toHaveLength(1);
  });

  it("stays inside two SMS segments for an ordinary name and window", async () => {
    visit.eta_start = "2026-09-29T15:15:00Z";
    visit.eta_end = "2026-09-29T15:45:00Z";
    await send();
    // Two concatenated GSM-7 segments carry 306 characters. The text without
    // the link was already two; the link must not make it three.
    expect(sms[0].length, sms[0]).toBeLessThanOrEqual(306);
  });

  it("mints the token once, only where none exists, and reuses it", async () => {
    await send();
    const mint = adminWrites.find((w) => w.payload.tracking_token);
    expect(mint?.filters).toContainEqual(["is:tracking_token", null]);
    const first = sms[0].match(/\/track\/(\S+)/)![1];
    expect(first).toBe(storedToken);

    visit.tracking_token = storedToken;
    adminWrites.length = 0;
    await send();
    expect(adminWrites.some((w) => w.payload.tracking_token)).toBe(false);
    expect(sms[1]).toContain(`/track/${first}`);
  });

  it("puts the link in the email when the text cannot go", async () => {
    canText = false;
    await send();
    expect(emails[0].templateData.trackUrl).toMatch(/\/track\/[0-9a-f-]{36}$/);
    const html = await render(
      React.createElement(TEMPLATES["on-my-way"].component, {
        orgName: "Acme Scoop",
        ...emails[0].templateData,
      }),
    );
    expect(html).toContain(emails[0].templateData.trackUrl);
    expect(html).toContain("See Sam on the map");
  });
});
