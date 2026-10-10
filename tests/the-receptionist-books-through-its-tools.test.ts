import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { FakeDb } from "./support/fake-supabase";
import { twoBusinesses, type FakeReceptionistDb } from "./support/fake-receptionist-store";

// The receptionist's real tool loop -- runAiReceptionist, generateText, the
// tools it hands the model -- driven by a scripted model instead of Claude.
// The script is the worst customer-and-model pair we can write: it invents
// dates, books without asking, repeats itself. What is asserted is what the
// TOOLS hand back and what gets written, because that is the part the
// business is answerable for whatever the model says.
//
// Mocked: the Anthropic provider (to the scripted model), the paid-plan gate
// (open), metering (a no-op), the service-role client (a FakeDb that answers
// public_quote and the org's extra-cleanup price), and the booking store (the
// in-memory one the rules test uses). Nothing is sent anywhere.

const h = vi.hoisted(() => ({
  model: null as any,
  modelIds: [] as string[],
  admin: null as any,
  store: null as any,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (id: string) => {
    h.modelIds.push(id);
    return h.model;
  },
}));
vi.mock("@/lib/ai-access.server", () => ({ orgMayUseAi: async () => true }));
vi.mock("@/lib/ai-usage.server", () => ({ recordAiUsage: async () => {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.admin;
  },
}));
vi.mock("@/lib/receptionist-booking-store.server", () => ({
  // The real lead insert (ai-receptionist.server.ts) is kept, so an unknown
  // number's lead lands in the FakeDb exactly as capture_lead's would.
  supabaseReceptionistStore: (_db: unknown, opts: { createLead: unknown }) => ({
    ...h.store,
    createLead: opts.createLead,
  }),
}));

const { runAiReceptionist } = await import("../src/lib/ai-receptionist.server");

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type Step = (results: Record<string, any>) => any[];
let callN = 0;
const call = (toolName: string, input: Record<string, unknown>) => ({
  type: "tool-call",
  toolCallId: `call-${++callN}`,
  toolName,
  input: JSON.stringify(input),
});
const say = (text: string) => ({ type: "text", text });

/** Every tool result in the prompt so far, by tool name (latest wins). */
function toolResults(prompt: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const m of prompt) {
    if (m.role !== "tool") continue;
    for (const p of m.content) if (p.type === "tool-result") out[p.toolName] = p.output?.value;
  }
  return out;
}

const seen: Record<string, any>[] = [];
function scripted(steps: Step[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      const results = toolResults(options.prompt);
      seen.push(results);
      const content = steps[Math.min(i++, steps.length - 1)](results);
      const calls = content.some((c) => c.type === "tool-call");
      return {
        content,
        finishReason: { unified: calls ? "tool-calls" : "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      } as any;
    },
  });
}

let world: ReturnType<typeof twoBusinesses>;
let db: FakeReceptionistDb;

function text(
  caller: { orgId: string; fromNumber: string; clientId: string | null },
  userText: string,
) {
  return runAiReceptionist({
    organizationId: caller.orgId,
    orgSlug: caller.orgId,
    fromNumber: caller.fromNumber,
    toNumber: "+13125550000",
    userText,
    clientId: caller.clientId,
    persona: "You are Poop Patrol's friendly assistant. Sign off as Patty.",
    faq: null,
    history: [],
  });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";
  seen.length = 0;
  h.modelIds.length = 0;
  world = twoBusinesses();
  db = world.db;
  // The booking rules read "now" from the clock; the fixture is Monday
  // 12 Oct 2026, 10am in Chicago.
  vi.useFakeTimers({ toFake: ["Date"], now: db.now });
  h.store = world.store;
  const admin = new FakeDb();
  admin
    .table("organizations")
    .push({ id: "org-a", one_off_price_cents: 4500 }, { id: "org-b", one_off_price_cents: 9900 });
  admin.rpcHandler = async (fn: string, args: any) => {
    if (fn !== "public_quote")
      return { data: null, error: { message: `unexpected rpc ${fn}` } } as any;
    if (args._postal_code !== "60601") return { data: [], error: null } as any;
    return {
      data: [{ recurring_price_cents: 2500, initial_cleanup_cents: 7500, zone_name: "Loop" }],
      error: null,
    } as any;
  };
  h.admin = admin;
});

describe("the loop offers only what the schedule has", () => {
  it("get_open_slots hands the model the schedule's days, and the persona is the voice", async () => {
    db.blackoutRows.push({ orgId: "org-a", day: "2026-10-13" });
    h.model = scripted([
      () => [call("get_open_slots", {})],
      (r) => [
        say(
          `I can come ${r.get_open_slots.slots.map((s: any) => s.label).join(", ")}. Which works?`,
        ),
      ],
    ]);
    const res = await text(world.clientA, "can you come out this week?");
    expect(res.error).toBeNull();
    expect(h.modelIds).toEqual(["claude-haiku-4-5-20251001"]);
    const slots = seen[1].get_open_slots.slots.map((s: any) => s.date);
    expect(slots).toEqual(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
    expect(res.reply).toContain("Wed, Oct 14");

    const system = (h.model as MockLanguageModelV4).doGenerateCalls[0].prompt[0] as any;
    expect(system.role).toBe("system");
    expect(system.content.startsWith("You are Poop Patrol's friendly assistant.")).toBe(true);
    expect(system.content).toMatch(/offer only the dates .* it returned/);
    expect(system.content).toMatch(/repeat the exact date back and get a clear yes/);
    expect(system.content).toMatch(
      /Say a visit is booked only when book_visit returned booked: true/,
    );
    expect(system.content).toMatch(/call escalate_to_human/);
  });
});

describe("the loop cannot book what was not offered", () => {
  it("a date the model made up is refused, and nothing is written", async () => {
    h.model = scripted([
      () => [call("book_visit", { date: "2026-10-21" })],
      (r) => [say(r.book_visit.booked ? "Booked!" : "Let me check which days are open.")],
    ]);
    const res = await text(world.clientA, "book me wednesday the 21st");
    expect(seen[1].book_visit).toMatchObject({ booked: false, reason: "not_offered" });
    expect(res.reply).toBe("Let me check which days are open.");
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
  });

  it("offered in one text, confirmed in the next: booked once, however often it is repeated", async () => {
    h.model = scripted([() => [call("get_open_slots", {})], () => [say("Tue Oct 13 works?")]]);
    await text(world.clientA, "need an extra cleanup");
    expect(db.offers.length).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      h.model = scripted([
        () => [call("book_visit", { date: "2026-10-13" })],
        (r) => [
          say(
            r.book_visit.booked ? `Booked for ${r.book_visit.label}.` : "The office will confirm.",
          ),
        ],
      ]);
      const res = await text(world.clientA, "yes tuesday");
      expect(res.reply).toBe("Booked for Tue, Oct 13.");
    }
    expect(db.visits).toHaveLength(1);
    expect(db.tickets).toHaveLength(1);
    expect(db.notices).toHaveLength(1);
  });

  it("a day taken between the offer and the yes is refused", async () => {
    h.model = scripted([() => [call("get_open_slots", {})], () => [say("Tue?")]]);
    await text(world.clientA, "extra cleanup please");
    db.timeOff.push({ staffId: "tech-a", starts: "2026-10-13", ends: "2026-10-13" });
    h.model = scripted([() => [call("book_visit", { date: "2026-10-13" })], () => [say("x")]]);
    await text(world.clientA, "yes");
    expect(seen[seen.length - 1].book_visit).toMatchObject({
      booked: false,
      reason: "no_longer_available",
    });
    expect(db.visits).toHaveLength(0);
  });
});

describe("an unknown number, through the loop", () => {
  it("becomes a lead in the business it texted, never a booking", async () => {
    h.model = scripted([
      () => [call("get_open_slots", { postal_code: "60601" })],
      (r) => [
        call("book_visit", {
          date: r.get_open_slots.slots[0].date,
          postal_code: "60601",
          name: "Sam",
        }),
      ],
      (r) => [
        say(r.book_visit.status === "office_will_confirm" ? "The office will confirm." : "Booked!"),
      ],
    ]);
    const res = await text(world.stranger, "do you come to 60601? can you do tuesday");
    expect(res.reply).toBe("The office will confirm.");
    expect(db.visits).toHaveLength(0);
    expect(db.tickets).toHaveLength(0);
    const leads = (h.admin as FakeDb).table("leads");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      organization_id: "org-a",
      name: "Sam",
      phone: world.stranger.fromNumber,
      source: "sms_receptionist",
    });
  });
});

describe("the price comes only from get_pricing_quote, through the loop", () => {
  it("the booking tools carry no price; the quote tool carries the one booked at", async () => {
    h.model = scripted([
      () => [call("get_pricing_quote", { postal_code: "60601", dogs: 1, frequency: "one_time" })],
      () => [call("get_open_slots", {})],
      () => [call("book_visit", { date: "2026-10-13" })],
      () => [say("done")],
    ]);
    await text(world.clientA, "how much for an extra cleanup tuesday? book it");
    const last = seen[seen.length - 1];
    expect(last.get_pricing_quote).toMatchObject({
      available: true,
      price_per_visit_usd: 25,
      extra_cleanup_for_existing_clients_usd: 45,
    });
    const priced = (v: unknown) => JSON.stringify(v).match(/usd|cents|price|\$\d/gi) ?? [];
    expect(priced(last.get_open_slots)).toEqual([]);
    expect(priced(last.book_visit)).toEqual([]);
    expect(db.visits[0].priceCents).toBe(4500);
  });

  it("a reply that names a price no quote returned is not sent; a person answers", async () => {
    h.model = scripted([() => [say("It's just $30 a visit! Want me to book Tuesday?")]]);
    const res = await text(world.clientA, "how much?");
    expect(res.reply).toBeNull();
    expect(res.escalated).toBe(true);
    expect(res.error).toMatch(/did not return \(30\)/);
  });

  it("a reply that names the quoted price is sent", async () => {
    h.model = scripted([
      () => [call("get_pricing_quote", { postal_code: "60601", dogs: 1, frequency: "weekly" })],
      () => [say("Weekly is $25 a visit, and an extra cleanup is $45.")],
    ]);
    const res = await text(world.clientA, "how much?");
    expect(res.reply).toBe("Weekly is $25 a visit, and an extra cleanup is $45.");
    expect(res.escalated).toBe(false);
  });

  it("a price the business already sent in this conversation may be repeated", async () => {
    h.model = scripted([() => [say("Yes, still $25 a visit.")]]);
    const res = await runAiReceptionist({
      organizationId: "org-a",
      orgSlug: "org-a",
      fromNumber: world.clientA.fromNumber,
      toNumber: "+13125550000",
      userText: "still 25?",
      clientId: "client-a",
      persona: "Patty.",
      faq: null,
      history: [
        { direction: "inbound", body: "how much" },
        { direction: "outbound", body: "Weekly is $25 a visit." },
      ],
    });
    expect(res.reply).toBe("Yes, still $25 a visit.");
  });

  it("a stranger is not told the existing clients' extra-cleanup price", async () => {
    h.model = scripted([
      () => [call("get_pricing_quote", { postal_code: "60601", dogs: 1, frequency: "weekly" })],
      () => [say("ok")],
    ]);
    await text(world.stranger, "how much?");
    expect(seen[1].get_pricing_quote).not.toHaveProperty("extra_cleanup_for_existing_clients_usd");
  });
});

describe("business A's client cannot book into business B, through the loop", () => {
  it("texting B, A's client gets B's stranger treatment and nothing of A's", async () => {
    const intoB = { orgId: "org-b", fromNumber: world.clientA.fromNumber, clientId: null };
    h.model = scripted([
      () => [call("get_open_slots", {})],
      () => [call("book_visit", { date: "2026-10-13" })],
      () => [say("x")],
    ]);
    await text(intoB, "book my usual address tuesday");
    expect(seen[1].get_open_slots).toMatchObject({ available: false, needs_postal_code: true });
    expect(seen[2].book_visit).toMatchObject({ booked: false, reason: "not_offered" });
    expect(db.visits).toHaveLength(0);
    expect(db.offers).toHaveLength(0);
  });
});
