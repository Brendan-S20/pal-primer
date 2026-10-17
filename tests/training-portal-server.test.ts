import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The portal's training server functions, the package notices and the
// office's "Book this lesson", against a fake database that records every
// query. Nothing here reaches a real Supabase project.

type Q = {
  table: string;
  op: string;
  cols?: string;
  filters: Array<[string, ...unknown[]]>;
  payload?: unknown;
  opts?: unknown;
};
type Resp = { data: unknown; error: { message: string } | null };
type Handler = (q: Q) => Resp | undefined;

const state = vi.hoisted(() => ({
  queries: [] as Q[],
  handler: (() => undefined) as (q: Q) => { data: unknown; error: unknown } | undefined,
  rpc: vi.fn(),
  session: { clientId: "client-1", organizationId: "org-1", preview: false },
  notify: vi.fn(async () => ({ inserted: ["n"], coalesced: [], pushed: [] })),
  email: vi.fn(async () => ({ ok: true })),
  officeEmail: vi.fn(async () => {}),
  sale: vi.fn(),
  book: vi.fn(),
  permission: vi.fn(async () => ({ orgId: "org-1", role: "owner" })),
}));

function makeDb() {
  const db = {
    from(table: string) {
      const q: Q = { table, op: "select", filters: [] };
      state.queries.push(q);
      const chain: Record<string, unknown> = {};
      const filter =
        (name: string) =>
        (...args: unknown[]) => {
          q.filters.push([name, ...args]);
          return chain;
        };
      for (const f of ["eq", "neq", "in", "is", "gt", "lte", "order", "limit", "not"])
        chain[f] = filter(f);
      chain.select = (cols?: string) => {
        if (q.op === "select") q.cols = cols;
        return chain;
      };
      for (const op of ["insert", "update", "upsert"])
        chain[op] = (payload: unknown, opts?: unknown) => {
          q.op = op;
          q.payload = payload;
          q.opts = opts;
          return chain;
        };
      chain.delete = () => {
        q.op = "delete";
        return chain;
      };
      const settle = () => Promise.resolve(state.handler(q) ?? { data: null, error: null });
      chain.single = settle;
      chain.maybeSingle = settle;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        settle().then(res, rej);
      return chain;
    },
    rpc: (...args: unknown[]) => state.rpc(...args),
  };
  return db;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({
            data: validate(args?.data),
            context: { supabase: makeDb(), userId: "office-user" },
          }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeDb();
  },
}));
vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: vi.fn(async (_t: string, opts: { readOnly?: boolean } = {}) => {
    if (state.session.preview && !opts.readOnly) throw new Error("preview is read-only");
    return state.session;
  }),
}));
vi.mock("@/lib/notify-center.server", () => ({ notifyRoles: state.notify }));
vi.mock("@/lib/email/enqueue.server", () => ({ enqueueAppEmail: state.email }));
vi.mock("@/lib/portal-links.server", () => ({
  ensureOrgSlug: async () => "good-dog",
  buildPortalLink: async (_o: string, token: string | null) =>
    token ? `https://app.test/portal/good-dog/${token}` : undefined,
}));
vi.mock("@/lib/portal.functions", () => ({ notifyOfficeOfConcern: state.officeEmail }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: state.permission,
  resolveCaller: state.permission,
}));
vi.mock("@/lib/training-packages.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/training-packages.server")>()),
  createPackageSale: state.sale,
  bookTrainingSessions: state.book,
  requireTrainingOffice: async () => "org-1",
}));

import {
  portalBuyTrainingPackage,
  portalGetTraining,
  portalRequestTrainingLesson,
} from "@/lib/portal-training.functions";
import { sendTrainingPackageNotices } from "@/lib/training-portal.server";
import { bookLessonRequest } from "@/lib/training-packages.functions";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const PACK = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";
const TICKET = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";

const today = new Date().toISOString().slice(0, 10);

function on(handlers: Record<string, Handler>) {
  state.handler = (q) => handlers[`${q.table}:${q.op}`]?.(q) ?? handlers[q.table]?.(q);
}

beforeEach(() => {
  state.queries = [];
  state.session = { clientId: "client-1", organizationId: "org-1", preview: false };
  state.rpc.mockReset();
  state.notify.mockClear();
  state.email.mockReset().mockResolvedValue({ ok: true });
  state.officeEmail.mockClear();
  state.sale.mockReset();
  state.book.mockReset();
  on({});
});

const filtersOf = (table: string) =>
  state.queries.filter((q) => q.table === table).flatMap((q) => q.filters);

describe("the portal Training page", () => {
  it("is not for a client with no package at a business that sells none", async () => {
    on({
      organizations: () => ({
        data: { timezone: "America/Chicago", service_lines: ["pet_waste"] },
        error: null,
      }),
      service_packages: () => ({
        data: [{ id: "sp", name: "x", services: { active: true } }],
        error: null,
      }),
      client_packages: () => ({ data: [], error: null }),
    });
    await expect(portalGetTraining({ data: { token: TOKEN } })).resolves.toEqual({
      visible: false,
    });
    // Read for the session's own client, never one named by the browser.
    expect(filtersOf("client_packages")).toContainEqual(["eq", "client_id", "client-1"]);
    expect(filtersOf("client_packages")).toContainEqual(["eq", "organization_id", "org-1"]);
  });

  const lessonData = (share: boolean): Record<string, Handler> => ({
    organizations: () => ({
      data: { timezone: "UTC", service_lines: ["training"], training_share_progress: share },
      error: null,
    }),
    client_packages: () => ({
      data: [
        {
          id: PACK,
          name: "6-session package",
          dog_id: "dog-1",
          sessions_count: 6,
          sessions_used: 1,
          expires_on: null,
          status: "active",
          purchased_on: "2026-10-01",
          price_cents: 42000,
          invoice_id: "inv-1",
        },
      ],
      error: null,
    }),
    service_packages: () => ({ data: [], error: null }),
    dogs: () => ({ data: [{ id: "dog-1", name: "Biscuit" }], error: null }),
    properties: () => ({ data: [{ id: PROPERTY, street: "1 Elm St" }], error: null }),
    visits: () => ({
      data: [
        {
          id: "v-done",
          scheduled_on: "2026-10-02",
          status: "completed",
          skip_billable: false,
          client_package_id: PACK,
          assigned_staff_id: "s1",
          subscriptions: { earliest_time: "10:00:00" },
        },
        {
          id: "v-next",
          scheduled_on: "2099-01-05",
          status: "scheduled",
          skip_billable: false,
          client_package_id: PACK,
          assigned_staff_id: "s1",
          subscriptions: { earliest_time: "09:30:00" },
        },
      ],
      error: null,
    }),
    invoices: () => ({ data: [{ id: "inv-1", status: "open", total_cents: 42000 }], error: null }),
    qc_tickets: () => ({
      data: [
        {
          id: "t1",
          client_package_id: PACK,
          requested_on: "2099-01-12",
          requested_time: "11:00:00",
          message: null,
          booked_visit_id: null,
        },
      ],
      error: null,
    }),
    session_progress: () => ({
      data: [{ visit_id: "v-done", score: 4, training_skills: { name: "Sit", sort_order: 1 } }],
      error: null,
    }),
    homework: () => ({
      data: [{ visit_id: "v-done", body: "Practice sit", due_on: null }],
      error: null,
    }),
    staff: () => ({ data: [{ id: "s1", display_name: "Maria Lopez" }], error: null }),
  });

  const lessonNotes = () =>
    state.rpc.mockImplementation(async (fn: string) =>
      fn === "portal_training_lesson_notes"
        ? { data: [{ visit_id: "v-done", note: "Good focus" }], error: null }
        : { data: null, error: { message: `unexpected rpc ${fn}` } },
    );

  it("shows a lesson's scores, note and homework, the balance and what is booked", async () => {
    on(lessonData(true));
    lessonNotes();
    const r = await portalGetTraining({ data: { token: TOKEN } });
    if (!r.visible) throw new Error("expected the page");
    const p = r.packages[0];
    expect(p).toMatchObject({
      dogName: "Biscuit",
      left: 5,
      // One completed, one booked, one asked for: three of six still free.
      free: 3,
      requestBlock: null,
      invoice: { id: "inv-1", payable: true },
      upcoming: [{ id: "v-next", startTime: "09:30", trainer: "Maria" }],
      requests: [{ requestedOn: "2099-01-12", requestedTime: "11:00" }],
    });
    expect(p.recent).toEqual([
      {
        id: "v-done",
        scheduledOn: "2026-10-02",
        status: "completed",
        scores: [{ skill: "Sit", score: 4 }],
        note: "Good focus",
        homework: { body: "Practice sit", dueOn: null },
      },
    ]);
    // The shared note only, through the portal function. The table itself is
    // never read, so no column list on it can widen to the trainer's note. The
    // session's client goes with it, so another client's visit ids return
    // nothing.
    expect(state.queries.some((q) => q.table === "training_session_notes")).toBe(false);
    expect(state.rpc).toHaveBeenCalledWith("portal_training_lesson_notes", {
      _organization_id: "org-1",
      _client_id: "client-1",
      _visit_ids: ["v-done"],
    });
  });

  it("reads lesson notes only through portal_training_lesson_notes, which returns visit_id and note", () => {
    const code = readFileSync("src/lib/training-portal.server.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\(\s*["']training_session_notes["']/);
    expect(code).toMatch(/\.rpc\(\s*"portal_training_lesson_notes"/);
    const sql = readFileSync(
      "supabase/migrations/20261016237000_portal-reads-no-trainer-note.sql",
      "utf8",
    ).replace(/--.*$/gm, "");
    expect(sql).toMatch(/RETURNS TABLE \(visit_id uuid, note text\)/);
    expect(sql).toMatch(/SELECT n\.visit_id, n\.note\s+FROM public\.training_session_notes n/);
    expect(sql).toMatch(/_organization_id uuid, _client_id uuid, _visit_ids uuid\[\]/);
    expect(sql).toMatch(/JOIN public\.visits v ON v\.id = n\.visit_id/);
    expect(sql).toMatch(/AND v\.client_id = _client_id/);
    expect(sql).not.toMatch(/trainer_note|\*/);
    expect(sql).toMatch(/FROM PUBLIC, anon, authenticated;/);
  });

  it("never names the trainer-only note anywhere in the portal code", () => {
    for (const file of [
      "src/lib/training-portal.server.ts",
      "src/lib/training-portal.ts",
      "src/lib/portal-training.functions.ts",
      "src/routes/portal.$slug.$token.training.tsx",
    ])
      expect(readFileSync(file, "utf8").replace(/\/\/.*$/gm, ""), file).not.toMatch(
        /trainer_note|trainerNote/,
      );
  });

  it("keeps notes and homework back when the business turns sharing off, and does not read them", async () => {
    on(lessonData(false));
    const r = await portalGetTraining({ data: { token: TOKEN } });
    if (!r.visible) throw new Error("expected the page");
    expect(r.shareProgress).toBe(false);
    expect(r.packages[0].recent[0]).toMatchObject({ note: null, homework: null });
    expect(r.packages[0].recent[0].scores).toHaveLength(1);
    expect(state.queries.some((q) => q.table === "training_session_notes")).toBe(false);
    expect(state.rpc).not.toHaveBeenCalledWith("portal_training_lesson_notes", expect.anything());
    expect(state.queries.some((q) => q.table === "homework")).toBe(false);
  });
});

describe("buying a package in the portal", () => {
  it("makes the office's sale for the session's client, with no user, and tells the office", async () => {
    on({ organizations: () => ({ data: { service_lines: ["training"] }, error: null }) });
    state.sale.mockResolvedValue({
      package: { id: PACK, name: "6-session package" },
      invoiceId: "inv-9",
      invoiceNumber: 1009,
    });
    const r = await portalBuyTrainingPackage({
      data: { token: TOKEN, servicePackageId: PACK, requestId: REQUEST },
    });
    expect(r).toEqual({ packageId: PACK, invoiceId: "inv-9" });
    expect(state.sale).toHaveBeenCalledWith(expect.anything(), {
      servicePackageId: PACK,
      dogId: undefined,
      requestId: REQUEST,
      orgId: "org-1",
      userId: null,
      clientId: "client-1",
    });
    expect(state.notify).toHaveBeenCalledWith(
      ["owner", "office_manager"],
      expect.objectContaining({ eventKey: `training-bought:${PACK}` }),
    );
  });

  it("refuses at a business that does not run training, before any sale", async () => {
    on({ organizations: () => ({ data: { service_lines: ["pet_waste"] }, error: null }) });
    await expect(
      portalBuyTrainingPackage({
        data: { token: TOKEN, servicePackageId: PACK, requestId: REQUEST },
      }),
    ).rejects.toThrow("Training packages are not offered here.");
    expect(state.sale).not.toHaveBeenCalled();
  });

  it("refuses an owner's preview", async () => {
    state.session = { ...state.session, preview: true };
    await expect(
      portalBuyTrainingPackage({
        data: { token: TOKEN, servicePackageId: PACK, requestId: REQUEST },
      }),
    ).rejects.toThrow(/read-only/);
    expect(state.sale).not.toHaveBeenCalled();
  });
});

describe("requesting a lesson from the balance", () => {
  const ask = { token: TOKEN, clientPackageId: PACK, propertyId: PROPERTY, day: "2099-01-12" };

  it("words each refusal the database raises and tells nobody", async () => {
    for (const [code, words] of [
      ["no_sessions_left", /No sessions are left/],
      ["package_expired", /expired/],
      ["package_canceled", /canceled/],
      ["after_expiry", /before the day this package expires/],
      ["package_not_found", /not on your account/],
    ] as const) {
      state.rpc.mockResolvedValueOnce({ data: null, error: { message: code } });
      await expect(portalRequestTrainingLesson({ data: ask })).rejects.toThrow(words);
    }
    expect(state.notify).not.toHaveBeenCalled();
    expect(state.officeEmail).not.toHaveBeenCalled();
  });

  it("passes the day, time and note to the database and tells the office once", async () => {
    state.rpc.mockResolvedValueOnce({ data: [{ ticket_id: TICKET, created: true }], error: null });
    const r = await portalRequestTrainingLesson({
      data: { ...ask, time: "10:15", message: "Mornings are best" },
    });
    expect(r).toEqual({ ticketId: TICKET, alreadyAsked: false });
    expect(state.rpc).toHaveBeenCalledWith("portal_request_training_lesson", {
      _token: TOKEN,
      _client_package_id: PACK,
      _property_id: PROPERTY,
      _on: "2099-01-12",
      _at: "10:15",
      _message: "Mornings are best",
    });
    expect(state.officeEmail).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith(
      ["owner", "office_manager"],
      expect.objectContaining({ link: "/concerns", eventKey: `training-request:${TICKET}` }),
    );

    // The same day again: the first request comes back and nobody is told twice.
    state.rpc.mockResolvedValueOnce({ data: [{ ticket_id: TICKET, created: false }], error: null });
    await expect(portalRequestTrainingLesson({ data: ask })).resolves.toEqual({
      ticketId: TICKET,
      alreadyAsked: true,
    });
    expect(state.officeEmail).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it("refuses a time that is not HH:MM before reaching the database", async () => {
    await expect(portalRequestTrainingLesson({ data: { ...ask, time: "9am" } })).rejects.toThrow();
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("package notices send once", () => {
  const due = {
    id: PACK,
    client_id: "client-1",
    name: "6-session package",
    sessions_count: 6,
    sessions_used: 5,
    expires_on: null,
    status: "active",
    clients: { display_name: "Ana", portal_token: "tok" },
  };
  const claims = new Set<string>();
  const ledger: Handler = (q) => {
    if (q.op === "upsert") {
      const key = (q.payload as { dedupe_key: string }).dedupe_key;
      if (claims.has(key)) return { data: [], error: null };
      claims.add(key);
      return { data: [{ dedupe_key: key }], error: null };
    }
    if (q.op === "delete") {
      claims.delete(String(q.filters.find((f) => f[1] === "dedupe_key")?.[2]));
      return { data: null, error: null };
    }
    return undefined;
  };
  beforeEach(() => claims.clear());

  it("claims the key, emails the client and tells the office, and does nothing the second time", async () => {
    on({ client_packages: () => ({ data: [due], error: null }), training_package_notices: ledger });
    await expect(
      sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" }),
    ).resolves.toBe(1);
    expect(state.email).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        templateName: "training-package-notice",
        notifyKey: "notify_email_training_package",
        idempotencyKey: `training-one-left:${PACK}`,
        oncePerKey: true,
        templateData: expect.objectContaining({
          kind: "one_left",
          portalUrl: "https://app.test/portal/good-dog/tok/training",
        }),
      }),
    );
    expect(state.notify).toHaveBeenCalledWith(
      ["owner", "office_manager"],
      expect.objectContaining({
        title: "One session left: Ana",
        eventKey: `training-one-left:${PACK}`,
      }),
    );

    // The nightly job, or the next lesson on the same package.
    await expect(
      sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" }),
    ).resolves.toBe(0);
    expect(state.email).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when nothing could be sent, so the next run tries again", async () => {
    on({ client_packages: () => ({ data: [due], error: null }), training_package_notices: ledger });
    state.email.mockResolvedValueOnce({ ok: false, reason: "enqueue_failed" });
    state.notify.mockRejectedValueOnce(new Error("down"));
    await expect(
      sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" }),
    ).resolves.toBe(0);
    expect(claims.size).toBe(0);
    await expect(
      sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" }),
    ).resolves.toBe(1);
    expect(claims.has(`training-one-left:${PACK}`)).toBe(true);
  });

  it("keeps the claim when the business switched the email off: that is a decision", async () => {
    on({ client_packages: () => ({ data: [due], error: null }), training_package_notices: ledger });
    state.email.mockResolvedValueOnce({ ok: false, reason: "org_toggle_off" });
    state.notify.mockRejectedValueOnce(new Error("down"));
    await expect(
      sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" }),
    ).resolves.toBe(1);
    expect(claims.size).toBe(1);
  });

  it("tells expiry 14 days out and looks only at active packages", async () => {
    const in14 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    on({
      client_packages: () => ({
        data: [{ ...due, sessions_used: 2, expires_on: in14 }],
        error: null,
      }),
      training_package_notices: ledger,
    });
    await sendTrainingPackageNotices(makeDb(), { id: "org-1", timezone: "UTC" });
    expect([...claims]).toEqual([`training-expiring:${PACK}:${in14}`]);
    expect(filtersOf("client_packages")).toContainEqual(["eq", "status", "active"]);
    expect(today).toBeTruthy();
  });
});

describe("the office books a requested lesson", () => {
  const ticket = {
    id: TICKET,
    category: "training_lesson_request",
    client_package_id: PACK,
    property_id: PROPERTY,
    requested_on: "2099-01-12",
    requested_time: "10:15:00",
    booked_visit_id: null,
    status: "open",
  };

  it("books the day and time asked for from the package, then resolves the request", async () => {
    let update: unknown;
    on({
      "qc_tickets:select": () => ({ data: ticket, error: null }),
      "qc_tickets:update": (q) => {
        update = q.payload;
        return { data: [{ id: TICKET }], error: null };
      },
      visits: () => ({ data: { id: "visit-1" }, error: null }),
    });
    state.book.mockResolvedValue({ subscriptionId: "plan-1", visitCount: 1 });
    await expect(bookLessonRequest({ data: { ticketId: TICKET } })).resolves.toEqual({
      ok: true,
      visitId: "visit-1",
      scheduledOn: "2099-01-12",
    });
    expect(state.book).toHaveBeenCalledWith(
      expect.anything(),
      "office-user",
      {
        clientPackageId: PACK,
        propertyId: PROPERTY,
        startOn: "2099-01-12",
        weekday: 1,
        startTime: "10:15",
      },
      true,
    );
    expect(update).toMatchObject({ booked_visit_id: "visit-1", status: "resolved" });
  });

  it("refuses a request that is already booked, and anything that is not a lesson request", async () => {
    on({ "qc_tickets:select": () => ({ data: { ...ticket, booked_visit_id: "v" }, error: null }) });
    await expect(bookLessonRequest({ data: { ticketId: TICKET } })).rejects.toThrow(
      /already has a lesson/,
    );
    on({
      "qc_tickets:select": () => ({
        data: { ...ticket, category: "one_off_request" },
        error: null,
      }),
    });
    await expect(bookLessonRequest({ data: { ticketId: TICKET } })).rejects.toThrow(
      /isn't in your organization/,
    );
    expect(state.book).not.toHaveBeenCalled();
  });
});
