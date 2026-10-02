// A reply to an automated text went nowhere.
//
// Automated texts go out from the PLATFORM number. The inbound webhook found
// a business by matching the number a reply was sent to against
// organizations.sms_from_number, which the platform number never is, so every
// reply to an automated text was dropped with "no org for To=". That included
// STOP: the customer's opt-out was never recorded in the app. And it meant
// the dogs-secured handshake (ENT / DNE, answering "on my way") could not
// exist. These drive the handler against a fake database.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReply, samePhone, textsTo } from "@/lib/platform-replies";
import { onMyWayText } from "@/lib/on-my-way";
import en from "@/lib/i18n/locales/en";

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> };
const calls: Call[] = [];
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
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: table === "messages" ? tables.sent : null, error: null }).then(res),
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
    now: NOW,
  });

beforeEach(() => {
  calls.length = 0;
  notified.length = 0;
  authOk = true;
  tables = {
    sent: [
      // Two businesses have texted this customer from the platform number.
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
  it("opts the customer out everywhere that number texted them, and says who", async () => {
    const r = await reply("STOP");
    const opt = calls.find((c) => c.table === "clients" && c.op === "update");
    expect(opt?.payload).toEqual({ sms_opt_out: true });
    expect(opt?.filters).toContainEqual(["id", ["client-a", "client-b"]]);
    expect(r.reply).toMatch(/^Acme Scoop: You are unsubscribed/);
  });

  it("is refused without a valid signature, and changes nothing", async () => {
    authOk = false;
    const r = await reply("STOP");
    expect(r.status).toBe(401);
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});

describe("the dogs-secured handshake", () => {
  it("ENT marks today's visit and thanks the customer", async () => {
    const r = await reply("ENT");
    const upd = calls.find((c) => c.table === "visits" && c.op === "update");
    expect(upd?.payload).toEqual({ gate_reply: "enter", gate_reply_at: NOW.toISOString() });
    expect(upd?.filters).toContainEqual(["id", "visit-1"]);
    expect(r.reply).toMatch(/dogs are secured/);
    expect(notified).toEqual([]);
  });

  it("DNE marks it and tells the office and the crew", async () => {
    const r = await reply("DNE");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")?.payload).toMatchObject({
      gate_reply: "do_not_enter",
    });
    expect(notified).toEqual([expect.objectContaining({ type: "gate_do_not_enter" })]);
    expect(r.reply).toMatch(/will not enter/);
  });

  it("does not touch a visit that is not today's", async () => {
    tables.visits = { ...tables.visits, scheduled_on: "2026-09-27" };
    const r = await reply("ENT");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")).toBeUndefined();
    expect(r.reply).toMatch(/couldn't match that/);
  });

  it("does not touch a finished visit", async () => {
    tables.visits = { ...tables.visits, status: "completed" };
    await reply("DNE");
    expect(calls.find((c) => c.table === "visits" && c.op === "update")).toBeUndefined();
  });
});

describe("anything else", () => {
  it("goes to the office of the business that texted last, logged against it", async () => {
    const r = await reply("Can you come Thursday instead?");
    expect(r.reply).toBeNull();
    expect(notified).toEqual([expect.objectContaining({ orgId: "org-a", type: "inbound_sms" })]);
    const logged = calls.find((c) => c.table === "messages" && c.op === "insert");
    expect(logged?.payload).toMatchObject({ organization_id: "org-a", direction: "inbound" });
  });

  it("from a phone the number never texted, is dropped without a reply", async () => {
    tables.sent = [];
    const r = await reply("STOP");
    expect(r.reply).toBeNull();
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});

describe("the wiring", () => {
  it("routes replies to the platform number before giving up on an unknown To", () => {
    const hook = readFileSync(
      join(import.meta.dirname, "../src/routes/api/public/hooks/twilio.ts"),
      "utf8",
    );
    const i = hook.indexOf("if (!org) {");
    const block = hook.slice(i, hook.indexOf('console.warn("Inbound SMS: no org for To="', i));
    expect(block).toMatch(/samePhone\(to, platform\)/);
    expect(block).toMatch(/handlePlatformReply\(/);
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
    expect(en.visit.customerSaysDoNotEnter).toBe("Customer says do not enter");
    const fn = readFileSync(join(import.meta.dirname, "../src/lib/my-day.functions.ts"), "utf8");
    expect(fn).toMatch(/gate_reply, gate_reply_at/);
  });
});
