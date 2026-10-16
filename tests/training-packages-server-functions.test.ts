import { beforeEach, describe, expect, it, vi } from "vitest";

const context: { supabase: unknown; userId: string } = { supabase: null, userId: "owner-user" };
const mocks = vi.hoisted(() => ({
  permission: vi.fn(async () => ({ orgId: "org-a", role: "owner" })),
  caller: vi.fn(async () => ({ orgId: "org-a", role: "owner" })),
  invoice: vi.fn(),
  estimate: vi.fn(async () => {}),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => { validate = fn; return builder; },
      handler: (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) => fn({ data: validate(args?.data), context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({ requirePermission: mocks.permission, resolveCaller: mocks.caller }));
vi.mock("@/lib/manual-invoice.server", () => ({ insertManualInvoice: mocks.invoice }));
vi.mock("@/lib/estimate.server", () => ({ recomputePropertyEstimate: mocks.estimate }));

import {
  bookOneSession, bookPackageSessions, cancelClientPackage, extendClientPackage,
  getTrainingSession, listClientPackages, listServicePackages, listTrainingBookingOptions,
  saveServicePackage, sellPackage, setServicePackageActive, getTrainingSessionRules,
  saveTrainingSessionRules, setLessonSessionUse,
} from "@/lib/training-packages.functions";
import { CHOOSE_DOG, TRAINER_BUSY } from "@/lib/training-packages";

const ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const sale = { clientId: ID, servicePackageId: ID, requestId: REQUEST, dogId: ID };
const booking = { clientPackageId: ID, propertyId: PROPERTY, startOn: "2090-01-02", weekday: 1 };
const pack = {
  id: ID, organization_id: "org-a", client_id: ID, service_id: ID, name: "6-session package",
  sessions_count: 6, sessions_used: 1, price_cents: 42000, purchased_on: "2090-01-01",
  expires_on: null as string | null, status: "active" as "active" | "canceled", invoice_id: INVOICE,
};
type Call = { table: string; op: string; args: unknown[] };
type DbError = { message: string; code?: string };
function fake(options: {
  canWrite?: boolean; active?: boolean; duplicate?: boolean; insertError?: DbError;
  cleanupError?: DbError; catalogError?: DbError; staffError?: DbError;
  package?: Partial<typeof pack>; visits?: { status: string; skip_billable: boolean }[];
  accountType?: string; busy?: unknown[]; lessonMissing?: boolean;
} = {}) {
  const calls: Call[] = [];
  const row = { ...pack, ...options.package };
  const client = {
    from(table: string) {
      let op = "select";
      let columns: unknown;
      const answer = (single = false) => {
        let data: unknown = { id: ID };
        let error: DbError | null = null;
        let count: number | undefined;
        if (table === "clients") data = { id: ID };
        if (table === "service_packages") {
          data = { ...row, active: options.active !== false, services: { name: "Private lesson (60 min)" } };
          if (!single) data = [data];
          error = options.catalogError ?? null;
        }
        if (table === "client_packages") {
          data = columns === "id" && op === "select" ? (options.duplicate ? { id: ID } : null) : row;
          if (!single && op === "select") data = [row];
          if (op === "insert") error = options.insertError ?? null;
        }
        if (table === "invoices") {
          data = { id: INVOICE, number: 1001, status: "open" };
          if (op === "delete") error = options.cleanupError ?? null;
        }
        if (table === "organizations") data = { timezone: "UTC", training_late_cancel_hours: 24, training_missed_uses_session: true };
        if (table === "visits") data = columns === "client_packages(sessions_count)"
          ? { client_packages: { sessions_count: 6 } }
          : String(columns).startsWith("scheduled_on, subscriptions")
            ? options.busy ?? []
            : op === "update" && single
              ? (options.lessonMissing ? null : { id: ID })
              : options.visits ?? [{ status: "completed", skip_billable: false }, { status: "scheduled", skip_billable: false }];
        if (table === "properties") data = { id: PROPERTY, zone_id: null, clients: { account_type: options.accountType ?? "residential" } };
        if (table === "dogs") { data = []; count = 2; }
        if (table === "staff") error = options.staffError ?? null;
        return { data, error, count };
      };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "insert", "update", "delete", "eq", "in", "not", "order", "limit"])
        query[method] = (...args: unknown[]) => {
          calls.push({ table, op: method, args });
          if (["insert", "update", "delete"].includes(method)) op = method;
          if (method === "select") columns = args[0];
          return query;
        };
      query.single = async () => answer(true);
      query.maybeSingle = async () => answer(true);
      query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return query;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ table: name, op: "rpc", args: [args] });
      return { data: name === "can_write_org" ? options.canWrite !== false : name === "client_package_session_number" ? 3 : 4, error: null };
    },
  };
  context.supabase = client;
  const writes = (table: string, op: string) => calls.filter((c) => c.table === table && c.op === op);
  return { client, calls, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ orgId: "org-a", role: "owner" });
  mocks.invoice.mockResolvedValue({ invoiceId: INVOICE, totalCents: 42000, taxCents: 0 });
});

describe("selling a training package", () => {
  it("requires billing permission and creates one manual invoice with the package price", async () => {
    const db = fake();
    const result = await sellPackage({ data: sale });
    expect(mocks.permission).toHaveBeenCalledWith(db.client, "owner-user", "manage_client_billing");
    expect(mocks.invoice).toHaveBeenCalledExactlyOnceWith(db.client, {
      orgId: "org-a", userId: "owner-user", clientId: ID, activityLabel: "training package invoice",
      items: [{ description: "6-session package: Private lesson (60 min)", amountCents: 42000 }],
    });
    expect(db.writes("client_packages", "insert")[0].args[0]).toEqual({
      organization_id: "org-a", client_id: ID, service_package_id: ID, dog_id: ID,
      invoice_id: INVOICE, request_id: REQUEST, created_by: "owner-user",
    });
    expect(result).toMatchObject({ package: { id: ID }, invoiceId: INVOICE, invoiceNumber: 1001 });
    expect(db.calls).toContainEqual({ table: "service_packages", op: "eq", args: ["organization_id", "org-a"] });
  });
  it("refuses inactive packages and repeated request ids before creating an invoice", async () => {
    fake({ active: false });
    await expect(sellPackage({ data: sale })).rejects.toThrow("This package is not available for sale.");
    fake({ duplicate: true });
    await expect(sellPackage({ data: sale })).rejects.toThrow("This package sale was already submitted.");
    expect(mocks.invoice).not.toHaveBeenCalled();
  });
  it("cleans up the invoice if the package insert fails, including a competing duplicate sale", async () => {
    for (const error of [{ code: "23514", message: "Choose a dog belonging to this client." }, { code: "23505", message: "duplicate key" }]) {
      const db = fake({ insertError: error });
      await expect(sellPackage({ data: sale })).rejects.toThrow(error.code === "23505" ? "already submitted" : error.message);
      expect(db.writes("invoices", "delete")).toHaveLength(1);
      expect(db.calls).toContainEqual({ table: "invoices", op: "eq", args: ["id", INVOICE] });
      expect(db.calls).toContainEqual({ table: "invoices", op: "eq", args: ["organization_id", "org-a"] });
    }
  });
  it("reports failed cleanup and never inserts a package after a failed invoice", async () => {
    fake({ insertError: { message: "bad dog" }, cleanupError: { message: "delete failed" } });
    await expect(sellPackage({ data: sale })).rejects.toThrow("bad dog Invoice cleanup failed: delete failed");
    const db = fake();
    mocks.invoice.mockRejectedValueOnce(new Error("invoice failed"));
    await expect(sellPackage({ data: sale })).rejects.toThrow("invoice failed");
    expect(db.writes("client_packages", "insert")).toEqual([]);
  });
  it("stops before any database call if billing permission is missing", async () => {
    const db = fake();
    mocks.permission.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(sellPackage({ data: sale })).rejects.toThrow("Not authorized");
    expect(db.calls).toEqual([]);
  });
  it("validates the request id before permissions or writes", async () => {
    const db = fake();
    await expect(sellPackage({ data: { ...sale, requestId: "double-click" } })).rejects.toThrow();
    expect(db.calls).toEqual([]);
    expect(mocks.permission).not.toHaveBeenCalled();
  });
});

describe("booking lessons from a package", () => {
  it("creates one weekly zero-price postpaid plan, stopping at the free count", async () => {
    const db = fake();
    expect(await bookPackageSessions({ data: { ...booking, staffId: ID, startTime: "11:00", minutes: 120 } })).toEqual({ subscriptionId: ID, visitCount: 4 });
    expect(mocks.permission).toHaveBeenCalledWith(db.client, "owner-user", "manage_pricing");
    expect(db.writes("subscriptions", "insert")).toHaveLength(1);
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({
      organization_id: "org-a", client_id: ID, property_id: PROPERTY, service_id: ID,
      client_package_id: ID, frequency: "weekly", weekdays: [1], dog_count: 2,
      price_cents: 0, billing_cadence: "postpaid", started_on: "2090-01-02", ends_on: "2090-01-23",
      earliest_time: "11:00", latest_time: "13:00", priced_from_zone_id: null,
    });
    expect(db.calls).toContainEqual({ table: "generate_visits_for_subscription", op: "rpc", args: [{ _org_id: "org-a", _subscription_id: ID, _through: "2090-01-23" }] });
    expect(db.writes("visits", "update")[0].args[0]).toEqual({ assigned_staff_id: ID });
    expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["status", "scheduled"] });
  });
  it("cuts the last date at expiry or an optional smaller count", async () => {
    let db = fake({ package: { expires_on: "2090-01-09" } });
    await bookPackageSessions({ data: booking });
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({ ends_on: "2090-01-09" });
    db = fake();
    await bookPackageSessions({ data: { ...booking, count: 1 } });
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({ ends_on: "2090-01-02" });
  });
  it("creates one one-time plan for exactly the selected day and preserves account shape", async () => {
    const db = fake({ accountType: "commercial" });
    await bookOneSession({ data: { clientPackageId: ID, propertyId: PROPERTY, date: "2090-01-03" } });
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({
      frequency: "one_time", weekdays: null, started_on: "2090-01-03", ends_on: "2090-01-03",
      account_type: "commercial", dog_count: null, unit_count: 1, price_cents: 0,
    });
  });
  it("returns capacity, expiry and cancellation sentences before inserting a plan", async () => {
    for (const [options, message] of [
      [{ visits: Array.from({ length: 6 }, () => ({ status: "scheduled", skip_billable: false })) }, "No sessions left in this package: 6 of 6 are booked or used."],
      [{ package: { expires_on: "2000-01-15" } }, "This package expired on 2000-01-15."],
      [{ package: { status: "canceled" as const } }, "This package was canceled."],
    ] as const) {
      const db = fake(options);
      await expect(bookOneSession({ data: { clientPackageId: ID, propertyId: PROPERTY, date: booking.startOn } })).rejects.toThrow(message);
      expect(db.writes("subscriptions", "insert")).toEqual([]);
    }
  });
  it("counts billable skips as held and gives cancellations and missed lessons back", async () => {
    const db = fake({ visits: [
      { status: "skipped", skip_billable: true }, { status: "skipped", skip_billable: false },
      { status: "canceled", skip_billable: false }, { status: "missed", skip_billable: false },
    ] });
    await bookPackageSessions({ data: booking });
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({ ends_on: "2090-01-30" });
  });
  it("validates dates, start times and lesson lengths before any database work", async () => {
    const db = fake();
    for (const patch of [{ startOn: "2090-02-30" }, { weekday: 7 }, { startTime: "25:00" }, { minutes: 5 }, { minutes: 481 }, { count: 0 }])
      await expect(bookPackageSessions({ data: { ...booking, ...patch } })).rejects.toThrow();
    expect(db.calls).toEqual([]);
  });
  it("checks the property client and active trainer in this org", async () => {
    const db = fake({ staffError: { message: "no staff" } });
    await expect(bookPackageSessions({ data: { ...booking, staffId: ID } })).rejects.toThrow("Choose a trainer from this business.");
    expect(db.calls).toContainEqual({ table: "properties", op: "eq", args: ["client_id", ID] });
    expect(db.calls).toContainEqual({ table: "staff", op: "eq", args: ["organization_id", "org-a"] });
    expect(db.writes("subscriptions", "insert")).toEqual([]);
  });
});

describe("catalog, listing and office actions", () => {
  const draft = { serviceId: ID, name: "Six lessons", sessionsCount: 6, priceCents: 42000, expiresAfterDays: 90 };
  it("uses can_write_org before catalog, cancel, extend and booking-option actions", async () => {
    const db = fake({ canWrite: false });
    const actions = [
      () => listServicePackages(), () => saveServicePackage({ data: draft }),
      () => setServicePackageActive({ data: { id: ID, active: true } }),
      () => cancelClientPackage({ data: { clientPackageId: ID, cancelBooked: true } }),
      () => extendClientPackage({ data: { clientPackageId: ID, expiresOn: null } }),
      () => listTrainingBookingOptions({ data: { clientId: ID } }),
      () => bookPackageSessions({ data: booking }),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow("Not authorized");
    expect(db.calls).toHaveLength(actions.length);
    expect(db.calls.every((c) => c.table === "can_write_org")).toBe(true);
  });
  it("saves new packages inactive, bounds money and counts, and scopes edits to the org", async () => {
    const db = fake();
    await saveServicePackage({ data: draft });
    expect(db.writes("service_packages", "insert")[0].args[0]).toMatchObject({ active: false, price_cents: 42000, sessions_count: 6, organization_id: "org-a" });
    await saveServicePackage({ data: { ...draft, id: ID } });
    expect(db.writes("service_packages", "update")).toHaveLength(1);
    expect(db.calls).toContainEqual({ table: "service_packages", op: "eq", args: ["organization_id", "org-a"] });
    for (const patch of [{ sessionsCount: 101 }, { priceCents: -1 }, { expiresAfterDays: 731 }, { name: " " }])
      await expect(saveServicePackage({ data: { ...draft, ...patch } })).rejects.toThrow();
  });
  it("passes database catalog validation sentences through unchanged", async () => {
    fake({ catalogError: { message: "Choose a training service from this business." } });
    await expect(saveServicePackage({ data: draft })).rejects.toThrow("Choose a training service from this business.");
  });
  it("lists entitlement, held and free separately, with the invoice and state", async () => {
    fake();
    const result = await listClientPackages({ data: { clientId: ID } });
    expect(result.packages).toEqual([expect.objectContaining({ left: 5, held: 2, free: 4, state: "active", invoice: { id: INVOICE, number: 1001, status: "open" } })]);
  });
  it("cancels without mutating the invoice, and extends to a later date or no expiry", async () => {
    const db = fake({ package: { expires_on: "2090-04-01" } });
    await cancelClientPackage({ data: { clientPackageId: ID, cancelBooked: false } });
    await extendClientPackage({ data: { clientPackageId: ID, expiresOn: "2090-05-01" } });
    await extendClientPackage({ data: { clientPackageId: ID, expiresOn: null } });
    expect(db.writes("client_packages", "update").map((c) => c.args[0])).toEqual([{ expires_on: "2090-05-01" }, { expires_on: null }]);
    await expect(extendClientPackage({ data: { clientPackageId: ID, expiresOn: "2090-03-01" } })).rejects.toThrow("Choose a later expiry date");
    expect(db.writes("invoices", "update")).toEqual([]);
    expect(db.writes("invoices", "delete")).toEqual([]);
  });
  it("reads a visit through RLS before asking for its session number", async () => {
    const db = fake();
    expect(await getTrainingSession({ data: { visitId: ID } })).toEqual({ n: 3, total: 6 });
    expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["id", ID] });
  });
});

describe("canceling a package with lessons still booked", () => {
  it("asks the database to cancel or keep lessons after today, in one call", async () => {
    for (const cancelBooked of [true, false]) {
      const db = fake();
      expect(await cancelClientPackage({ data: { clientPackageId: ID, cancelBooked } })).toEqual({ ok: true, canceledLessons: 4 });
      expect(db.calls).toContainEqual({ table: "cancel_client_package", op: "rpc", args: [{ _client_package_id: ID, _cancel_booked: cancelBooked }] });
      expect(db.writes("client_packages", "update")).toEqual([]);
      expect(db.writes("visits", "update")).toEqual([]);
    }
  });
  it("refuses a cancel that does not say what happens to booked lessons", async () => {
    const db = fake();
    await expect(cancelClientPackage({ data: { clientPackageId: ID } as never })).rejects.toThrow();
    expect(db.calls).toEqual([]);
  });
  it("lists how many scheduled lessons fall after today", async () => {
    fake({ visits: [
      { status: "scheduled", skip_billable: false, scheduled_on: "2999-01-01" },
      { status: "scheduled", skip_billable: false, scheduled_on: "2000-01-01" },
      { status: "completed", skip_billable: false, scheduled_on: "2999-01-08" },
    ] as never });
    const result = await listClientPackages({ data: { clientId: ID } });
    expect(result.packages[0]).toMatchObject({ held: 3, bookedAfterToday: 1 });
  });
});

describe("a lesson at a start time, and the trainer's other lessons", () => {
  const timed = { ...booking, staffId: ID, startTime: "10:00", minutes: 60 };
  it("stores the lesson's slot as the plan's start and end", async () => {
    const db = fake();
    await bookOneSession({ data: { clientPackageId: ID, propertyId: PROPERTY, date: "2090-01-03", startTime: "10:00" } });
    // No length given: the service's default, or 60 minutes.
    expect(db.writes("subscriptions", "insert")[0].args[0]).toMatchObject({ earliest_time: "10:00", latest_time: "11:00" });
  });
  it("refuses an overlapping lesson for the same trainer and names it, before any plan is made", async () => {
    const db = fake({ busy: [{ scheduled_on: "2090-01-09", subscriptions: { earliest_time: "10:30:00", latest_time: null }, services: { default_duration_min: 45 } }] });
    await expect(bookPackageSessions({ data: timed })).rejects.toThrow(`${TRAINER_BUSY}: 2090-01-09, 10:30 to 11:15.`);
    expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["assigned_staff_id", ID] });
    expect(db.calls).toContainEqual({ table: "visits", op: "in", args: ["status", ["scheduled", "in_progress"]] });
    expect(db.writes("subscriptions", "insert")).toEqual([]);
  });
  it("ignores lessons that touch but do not overlap, and books anyway when told to", async () => {
    let db = fake({ busy: [
      { scheduled_on: "2090-01-02", subscriptions: { earliest_time: "11:00:00", latest_time: "12:00:00" }, services: null },
      { scheduled_on: "2090-01-02", subscriptions: { earliest_time: null, latest_time: null }, services: null },
    ] });
    await bookPackageSessions({ data: timed });
    expect(db.writes("subscriptions", "insert")).toHaveLength(1);
    db = fake({ busy: [{ scheduled_on: "2090-01-02", subscriptions: { earliest_time: "10:00:00", latest_time: "11:00:00" }, services: null }] });
    await bookPackageSessions({ data: { ...timed, allowOverlap: true } });
    expect(db.writes("subscriptions", "insert")).toHaveLength(1);
  });
  it("refuses a lesson that would run past midnight", async () => {
    const db = fake();
    await expect(bookPackageSessions({ data: { ...timed, startTime: "23:30" } })).rejects.toThrow("past midnight");
    expect(db.writes("subscriptions", "insert")).toEqual([]);
  });
});

describe("the dog on a package", () => {
  it("requires the dog when the household has more than one, before any invoice", async () => {
    const db = fake();
    await expect(sellPackage({ data: { ...sale, dogId: undefined } })).rejects.toThrow(CHOOSE_DOG);
    expect(db.calls).toContainEqual({ table: "dogs", op: "eq", args: ["properties.client_id", ID] });
    expect(mocks.invoice).not.toHaveBeenCalled();
  });
});

describe("no-show and late-cancel rules", () => {
  it("reads the business rule and saves it through the settings function", async () => {
    let db = fake();
    expect(await getTrainingSessionRules()).toEqual({ lateCancelHours: 24, missedUsesSession: true });
    db = fake();
    await saveTrainingSessionRules({ data: { lateCancelHours: 12, missedUsesSession: false } });
    expect(mocks.permission).toHaveBeenCalledWith(db.client, "owner-user", "manage_settings");
    expect(db.calls).toContainEqual({ table: "set_training_session_rules", op: "rpc", args: [{ _org_id: "org-a", _late_cancel_hours: 12, _missed_uses_session: false }] });
    for (const bad of [{ lateCancelHours: -1, missedUsesSession: true }, { lateCancelHours: 169, missedUsesSession: true }])
      await expect(saveTrainingSessionRules({ data: bad })).rejects.toThrow();
  });
  it("lets the office override a missed or skipped package lesson, and nothing else", async () => {
    let db = fake();
    await setLessonSessionUse({ data: { visitId: ID, usesSession: false } });
    expect(db.writes("visits", "update")[0].args[0]).toEqual({ skip_billable: false });
    expect(db.calls).toContainEqual({ table: "visits", op: "in", args: ["status", ["skipped", "missed"]] });
    expect(db.calls).toContainEqual({ table: "visits", op: "not", args: ["client_package_id", "is", null] });
    expect(db.calls).toContainEqual({ table: "visits", op: "eq", args: ["organization_id", "org-a"] });
    db = fake({ lessonMissing: true });
    await expect(setLessonSessionUse({ data: { visitId: ID, usesSession: true } })).rejects.toThrow("Only a missed or skipped package lesson");
    db = fake({ canWrite: false });
    await expect(setLessonSessionUse({ data: { visitId: ID, usesSession: true } })).rejects.toThrow("Not authorized");
    expect(db.writes("visits", "update")).toEqual([]);
  });
});
