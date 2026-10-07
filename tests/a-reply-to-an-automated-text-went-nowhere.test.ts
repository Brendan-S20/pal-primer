// A reply to an automated text went nowhere.
//
// Automated texts went out from the PLATFORM number. The inbound webhook found
// a business by matching the number a reply was sent to against
// organizations.sms_from_number, which the platform number never is, so every
// reply to an automated text was dropped with "no org for To=". That included
// STOP: the customer's opt-out was never recorded in the app. And it meant
// the dogs-secured handshake (ENT / DNE, answering "on my way") could not
// exist. These drive the handlers against a fake database.
//
// CHANGED 2026-10-06. The platform number now texts ACCOUNT HOLDERS only (the
// toll-free resubmission; tests/the-toll-free-number-texts-account-holders
// .test.ts), so a business's client is texted from the business's own number
// and replies to it, ENT and DNE included, arrive on the business's own path.
// A text to the platform number is from an account holder or a stranger: it
// is answered in HoundStack's name and routed to no business. What this file
// still guards is the original point: no reply goes nowhere. STOP is answered
// wherever it lands, and the handshake is recorded wherever "on my way" went
// from.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReply, samePhone, textsTo } from "@/lib/platform-replies";
import { onMyWayText } from "@/lib/on-my-way";
import en from "@/lib/i18n/locales/en";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };
const calls: Call[] = [];
const reads: Call[] = [];
let tables: Record<string, any> = {};

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => (call.filters.push([k, v]), b),
    in: (k: string, v: unknown) => (call.filters.push([k, v]), b),
    gte: () => b,
    order: () => b,
    limit: () => b,
    insert: (payload: unknown) => {
      call.op = "insert";
      call.payload = payload;
      calls.push(call);
      return Promise.resolve({ data: null, error: null });
    },
    update: (payload: unknown) => {
      call.op = "update";
      call.payload = payload;
      calls.push(call);
      return b;
    },
    maybeSingle: () => {
      if (table === "messages") return Promise.resolve({ data: null }); // no duplicate SID
      return Promise.resolve({ data: tables[table] ?? null });
    },
    then: (res: (v: unknown) => unknown) => {
      // Reads are recorded too, so a test can say which business was asked.
      if (call.op === "select") reads.push(call);
      return Promise.resolve({ data: table === "messages" ? tables.sent : null, error: null }).then(res);
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => builder(t) },
}));
let authOk = true;
vi.mock("@/lib/twilio-inbound-auth.server", () => ({
  verifyTwilioInbound: vi.fn(async () =>
    authOk ? { ok: true, via: "platform_signature" } : { ok: false },
  ),
}));
const notified: unknown[] = [];
vi.mock("@/lib/notify-center.server", () => ({
  notifyRoles: vi.fn(async (_roles: unknown, n: unknown) => void notified.push(n)),
}));

const { handlePlatformReply } = await import("@/lib/platform-inbound.server");
const { answerGateReply } = await import("@/lib/gate-reply.server");

const PLATFORM = "+15125550000";
const CUSTOMER = "(512) 555-0100";
// 10:00 AM Chicago, Sep 28.
const NOW = new Date("2026-09-28T15:00:00Z");

const reply = (body: string) =>
  handlePlatformReply({
    requestUrl: "https://app.example.com/api/public/hooks/twilio",
    pathWithQuery: "/api/public/hooks/twilio",
    params: {},
    signature: "sig",
    from: "+15125550100",
    to: PLATFORM,
    body,
    sid: `SM${Math.random()}`,
  });

/** A reply to Acme Scoop's OWN number, which its "on my way" went from. */
const gate = (kind: "enter" | "do_not_enter") =>
  answerGateReply({
    supabaseAdmin: { from: (t: string) => builder(t) },
    orgId: "org-a",
    phone: "+15125550100",
    kind,
    tz: "America/Chicago",
    brand: "Acme Scoop",
    contact: "512-555-0142",
    now: NOW,
  });

beforeEach(() => {
  calls.length = 0;
  reads.length = 0;
  notified.length = 0;
  authOk = true;
  tables = {
    sent: [
      // Texts this business sent the customer, newest first once sorted.
      {
        organization_id: "org-a",
        client_id: "client-a",
        visit_id: "visit-1",
        to_number: CUSTOMER,
        created_at: "2026-09-28T14:50:00Z",
      },
      {
        organization_id: "org-b",
        client_id: "client-b",
        visit_id: null,
        to_number: "+15125550100",
        created_at: "2026-08-01T12:00:00Z",
      },
      // Someone else entirely.
      {
        organization_id: "org-a",
        client_id: "client-z",
        visit_id: "visit-9",
        to_number: "+15125559999",
        created_at: "2026-09-28T14:55:00Z",
      },
    ],
    organizations: {
      id: "org-a",
      name: "Acme Scoop",
      contact_phone: "512-555-0142",
      timezone: "America/Chicago",
    },
    visits: {
      id: "visit-1",
      organization_id: "org-a",
      status: "scheduled",
      scheduled_on: "2026-09-28",
      clients: { display_name: "Jane" },
    },
  };
});

describe("what a reply means", () => {
  it("matches the whole message, like a carrier matches STOP", () => {
    expect(classifyReply("Stop.")).toBe("stop");
    expect(classifyReply(" ent ")).toBe("enter");
    expect(classifyReply("DNE!")).toBe("do_not_enter");
    expect(classifyReply("do not enter")).toBe("do_not_enter");
    expect(classifyReply("stop by at noon")).toBeNull();
    expect(classifyReply("thanks!")).toBeNull();
  });

  it("treats two spellings of one number as the same phone", () => {
    expect(samePhone("+1 (512) 555-0100", "5125550100")).toBe(true);
    expect(samePhone("+15125550100", "+15125550101")).toBe(false);
    expect(textsTo(tables.sent, "+15125550100").map((m) => m.client_id)).toEqual([
      "client-a",
      "client-b",
    ]);
  });
});

describe("STOP to the platform number", () => {
  it("is answered in HoundStack's name, and touches no business's client", async () => {
    const r = await reply("STOP");
    expect(r.reply).toMatch(/^HoundStack: You are unsubscribed/);
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("is refused without a valid signature, and changes nothing", async () => {
    authOk = false;
    const r = await reply("STOP");
    expect(r.status).toBe(401);
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});

describe("the dogs-secured handshake, on the business's own number", () => {
  it("ENT marks today's visit and thanks the customer", async () => {
    const r = await gate("enter");
    const upd = calls.find((c) => c.table === "visits" && c.op === "update");
    expect(upd?.payload).toEqual({ gate_reply: "enter", gate_reply_at: NOW.toISOString() });
    expect(upd?.filters).toContainEqual(["id", "visit-1"]);
    expect(r).toMatch(/dogs are secured/);
    expect(notified).toEqual([]);
  });

  it("asks only this business's texts, and only this business's visits", async () => {
    await gate("enter");
    const sent = reads.find((c) => c.table === "messages");
    expect(sent?.filters).toContainEqual(["organization_id", "org-a"]);
  });

  it("DNE marks it and tells the office and the crew", async () => {
    const r = await gate("do_not_enter");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")?.payload).toMatchObject({
      gate_reply: "do_not_enter",
    });
    expect(notified).toEqual([expect.objectContaining({ type: "gate_do_not_enter" })]);
    expect(r).toMatch(/will not enter/);
  });

  it("does not touch a visit that is not today's", async () => {
    tables.visits = { ...tables.visits, scheduled_on: "2026-09-27" };
    const r = await gate("enter");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")).toBeUndefined();
    expect(r).toMatch(/couldn't match that/);
  });

  it("does not touch a finished visit", async () => {
    tables.visits = { ...tables.visits, status: "completed" };
    await gate("do_not_enter");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")).toBeUndefined();
  });

  it("does nothing for a phone this business did not text about a visit", async () => {
    tables.sent = [];
    const r = await gate("enter");
    expect(calls).toEqual([]);
    expect(r).toMatch(/couldn't match that/);
  });
});

describe("anything else to the platform number", () => {
  it("gets no reply, and goes to no business's office or conversation", async () => {
    for (const body of ["Can you come Thursday instead?", "ENT", "DNE"]) {
      const r = await reply(body);
      expect(r.reply, body).toBeNull();
    }
    expect(notified).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the wiring", () => {
  it("checks for the platform number BEFORE looking up any business", () => {
    const hook = readFileSync(
      join(import.meta.dirname, "../src/routes/api/public/hooks/twilio.ts"),
      "utf8",
    );
    const platform = hook.indexOf("samePhone(to, platform)");
    const handled = hook.indexOf("handlePlatformReply(");
    const orgLookup = hook.indexOf('.eq("sms_from_number", to)');
    expect(platform).toBeGreaterThan(-1);
    expect(handled).toBeGreaterThan(platform);
    expect(orgLookup).toBeGreaterThan(handled);
  });

  it("answers ENT and DNE on the business's own number", () => {
    const hook = readFileSync(
      join(import.meta.dirname, "../src/routes/api/public/hooks/twilio.ts"),
      "utf8",
    );
    const afterOrg = hook.slice(hook.indexOf('.eq("sms_from_number", to)'));
    expect(afterOrg).toMatch(/answerGateReply\(\{[\s\S]*?orgId: org\.id/);
  });

  it("asks for ENT or DNE in the on-my-way text, and My Day shows the answer", () => {
    const text = readFileSync(join(import.meta.dirname, "../src/lib/on-my-way.ts"), "utf8");
    expect(text).toMatch(/Reply ENT/);
    expect(text).toMatch(/Reply DNE/);
    // Updated deliberately with live tracking (2026-09-29): the live map link
    // goes BEFORE the handshake, so a customer who reads to the link still
    // reads the question, and the text still ends on the opt-out.
    const withMap = onMyWayText({
      customerName: "Jane",
      orgName: "Acme Scoop",
      techName: "Sam",
      eta: null,
      trackUrl: "https://app.houndstack.com/track/7a000000-0000-4000-8000-0000000000a1",
    });
    expect(withMap.indexOf("Live map:")).toBeLessThan(withMap.indexOf("Reply ENT"));
    expect(withMap).toMatch(/Reply ENT\. Rather we didn't come in\? Reply DNE\. Reply STOP to opt out\.$/);
    const myDay = readFileSync(
      join(import.meta.dirname, "../src/routes/_authenticated/my-day.tsx"),
      "utf8",
    );
    // The card's words are in lib/i18n; the card asks for them by key.
    expect(myDay).toMatch(/t\("visit\.customerSaysDoNotEnter"\)/);
    // CHANGED 2026-10-02: staff copy says "client" for the person who pays
    // (tests/one-word-for-the-person-who-pays.test.ts).
    expect(en.visit.customerSaysDoNotEnter).toBe("Client says do not enter");
    const fn = readFileSync(join(import.meta.dirname, "../src/lib/my-day.functions.ts"), "utf8");
    expect(fn).toMatch(/gate_reply, gate_reply_at/);
  });
});
