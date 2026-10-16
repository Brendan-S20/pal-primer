// A client notice that misses Complete's deadline still goes out.
//
// completeVisit waits 2.5s for each client notice (the completion email, the
// push, the review text or email) and then answers the tech, who is told the
// notices that did not finish "are still sending". The work that missed the
// deadline was left as a promise nobody held. In Node that runs on; on a
// Cloudflare Worker it can be cut off once the response has gone out, so the
// email never sent and the toast was wrong.
//
// Now it is handed to the Worker's waitUntil, found the way auto-routing finds
// it (lib/keep-alive.server.ts: getRequest().waitUntil). These run the real
// handler with the framework, Supabase and the senders faked, and a Request
// carrying waitUntil, the shape Nitro gives a Worker request.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import en from "@/lib/i18n/locales/en";

const VISIT = "20000000-0000-4000-8000-000000000001";
const ORG = "0f000000-0000-4000-8000-0000000000b1";
const CLIENT = "30000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
  request: null as null | { waitUntil: (p: Promise<unknown>) => void },
  reviewOn: false,
  rpc: [] as Array<[string, unknown]>,
  inserts: [] as Array<{ table: string; row: unknown }>,
}));

/** What the handler's three visit reads see, told apart by what they select. */
function visitRow(selected: string) {
  if (selected.includes("clients(")) {
    return {
      organization_id: ORG,
      client_id: CLIENT,
      clients: {
        id: CLIENT,
        display_name: "Dana Reyes",
        sms_opt_out: false,
        comms_paused: false,
        primary_phone: "+15555550100",
        review_asked_at: null,
      },
      organizations: {
        name: "Scoop Co",
        review_ask_enabled: state.reviewOn,
        google_review_url: "https://g.page/r/scoop",
        review_ask_template: null,
      },
    };
  }
  return {
    organization_id: ORG,
    client_id: CLIENT,
    property_id: "40000000-0000-4000-8000-000000000001",
    scheduled_on: "2026-10-15",
    visit_checklist: null,
    properties: { street: "12 Elm St", city: "Springfield", visit_contact_email: null },
    organizations: { email_visit_checklist: false },
  };
}

const db = vi.hoisted(() => ({
  rpc: async (fn: string, args: unknown) => {
    state.rpc.push([fn, args]);
    return { data: fn === "client_may_be_texted" ? true : null, error: null };
  },
  from: (table: string) => {
    let selected = "";
    const q: any = {
      select: (s?: string) => ((selected = s ?? ""), q),
      eq: () => q,
      in: () => q,
      order: () => q,
      insert: async (row: unknown) => (state.inserts.push({ table, row }), { error: null }),
      single: async () => ({ data: visitRow(selected), error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return q;
  },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: db, userId: "user-1" } }),
    };
    return b;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => state.request }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/field-notify.server", () => ({
  afterStopResolved: vi.fn(async () => {}),
  notifyVisitSkipped: vi.fn(async () => {}),
}));
const senders = vi.hoisted(() => ({
  enqueueAppEmail: vi.fn(),
  sendPushToClient: vi.fn(),
  sendTwilioSms: vi.fn(),
  endCustomerSmsSender: vi.fn(),
}));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: senders.enqueueAppEmail }));
vi.mock("@/lib/push.server", () => ({ sendPushToClient: senders.sendPushToClient }));
vi.mock("@/lib/twilio.server", () => ({ sendTwilioSms: senders.sendTwilioSms }));
vi.mock("@/lib/twilio-credentials.server", () => ({
  endCustomerSmsSender: senders.endCustomerSmsSender,
  orgCanTextClients: async () => false,
}));

/** A promise the test resolves when it chooses: a send that is still going. */
function slow<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Runs the handler to its answer, moving the fake clock past the deadline
 *  while real I/O (the handler's dynamic imports) gets its turns. */
async function finish<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  // Bounded by the real clock (Date is not faked), not by a count of turns.
  const giveUpAt = Date.now() + 10_000;
  while (!done && Date.now() < giveUpAt) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(50);
  }
  return p;
}

beforeAll(async () => {
  // Load everything the handler imports on the way, so its awaits inside a
  // test are module-cache hits rather than file reads.
  await Promise.all([
    import("@/lib/my-day.functions"),
    import("@/lib/keep-alive.server"),
    import("@/lib/activity.server"),
    import("@/lib/field-notify.server"),
    import("@/integrations/supabase/client.server"),
    import("@/lib/email/enqueue.server"),
    import("@/lib/push.server"),
    import("@/lib/twilio.server"),
    import("@/lib/twilio-credentials.server"),
    import("@tanstack/react-start/server"),
  ]);
});

async function complete() {
  const { completeVisit } = await import("@/lib/my-day.functions");
  return finish(
    (completeVisit as any)({ data: { visitId: VISIT } }) as Promise<{
      ok: boolean;
      notificationSummary: { sent: string[]; pending: boolean };
    }>,
  );
}

let kept: Promise<unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  kept = [];
  state.request = { waitUntil: vi.fn((p: Promise<unknown>) => void kept.push(p)) };
  state.reviewOn = false;
  state.rpc = [];
  state.inserts = [];
  senders.enqueueAppEmail.mockReset().mockResolvedValue({ ok: true });
  senders.sendPushToClient.mockReset().mockResolvedValue({ sent: 1 });
  senders.sendTwilioSms.mockReset().mockResolvedValue({ sid: "SM-fast", status: "queued" });
  senders.endCustomerSmsSender.mockReset().mockResolvedValue({
    from: "+15555550199",
    messagingServiceSid: null,
    credentials: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a client notice that misses Complete's deadline", () => {
  it("is handed to the Worker's waitUntil, and finishes after the tech has their answer", async () => {
    const email = slow<{ ok: boolean }>();
    senders.enqueueAppEmail.mockReturnValue(email.promise);

    const out = await complete();

    // The tech is told the push went and the rest is still sending...
    expect(out.notificationSummary).toEqual({ sent: ["push"], pending: true });
    // ...and the email that was still going is the Worker's to keep alive.
    expect(state.request!.waitUntil).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);

    let settled = false;
    void kept[0].then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    email.resolve({ ok: true });
    await kept[0];
    expect(settled).toBe(true);
  });

  it("still records a review text that lands late, so the next visit does not ask again", async () => {
    state.reviewOn = true;
    const sms = slow<{ sid: string; status: string }>();
    senders.sendTwilioSms.mockReturnValue(sms.promise);

    const out = await complete();

    expect(out.notificationSummary).toEqual({
      sent: ["completion_email", "push"],
      pending: true,
    });
    expect(kept).toHaveLength(1);
    // Nothing is written for a text that has not gone yet.
    expect(state.inserts).toEqual([]);
    expect(state.rpc.map(([fn]) => fn)).not.toContain("mark_review_asked");

    sms.resolve({ sid: "SM-late", status: "queued" });
    await kept[0];

    expect(state.inserts).toEqual([
      expect.objectContaining({
        table: "messages",
        row: expect.objectContaining({ client_id: CLIENT, visit_id: VISIT, twilio_sid: "SM-late" }),
      }),
    ]);
    expect(state.rpc).toContainEqual(["mark_review_asked", { _client_id: CLIENT }]);
  });

  it("does the same for a review email", async () => {
    state.reviewOn = true;
    senders.endCustomerSmsSender.mockResolvedValue(null);
    const reviewEmail = slow<{ ok: boolean }>();
    senders.enqueueAppEmail.mockImplementation(async (args: { templateName: string }) =>
      args.templateName === "review-request" ? reviewEmail.promise : { ok: true },
    );

    const out = await complete();

    expect(out.notificationSummary).toEqual({
      sent: ["completion_email", "push"],
      pending: true,
    });
    expect(kept).toHaveLength(1);
    reviewEmail.resolve({ ok: true });
    await kept[0];
    expect(state.rpc).toContainEqual(["mark_review_asked", { _client_id: CLIENT }]);
  });

  it("hands nothing over when every notice finishes in time", async () => {
    const out = await complete();
    expect(out.notificationSummary).toEqual({ sent: ["completion_email", "push"], pending: false });
    expect(state.request!.waitUntil).not.toHaveBeenCalled();
  });

  it("without a waitUntil (Node in dev, vitest) answers the same way and does not throw", async () => {
    state.request = null;
    const email = slow<{ ok: boolean }>();
    senders.enqueueAppEmail.mockReturnValue(email.promise);

    const out = await complete();

    expect(out).toMatchObject({ ok: true, notificationSummary: { sent: ["push"], pending: true } });
    email.resolve({ ok: true });
  });
});

describe("what the tech is told", () => {
  // My Day's completeToast reads notificationSummary: `pending` picks the
  // "still sending" sentences. With the work kept alive those are true.
  it("says the notices are still sending only when one is", async () => {
    const i = i18next.createInstance();
    await i.init({ resources: { en: { translation: en } }, lng: "en" });
    expect(i.t("visit.completedNoticePending")).toBe(
      "Completed. Client notices are still sending.",
    );
    expect(i.t("visit.completedWithNoticesPending", { notices: "push" })).toBe(
      "Completed. Client notices sent: push. More are still sending.",
    );
    expect(i.t("visit.completedWithNotices", { notices: "completion email, push" })).toBe(
      "Completed. Client notices: completion email, push.",
    );
  });
});
